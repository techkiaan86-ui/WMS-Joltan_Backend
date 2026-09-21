const { CourierMapping, CourierService } = require('../models');

async function list(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const mappings = await CourierMapping.findAll({
      where: { companyId },
      order: [['requestedService', 'ASC']]
    });
    res.json({ success: true, data: mappings });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const { requestedService, courierName, courierService } = req.body;
    
    if (!requestedService || !courierName || !courierService) {
      return res.status(400).json({ success: false, message: 'requestedService, courierName and courierService are required' });
    }

    // Check for duplicate requestedService mapping for this company
    const existing = await CourierMapping.findOne({
      where: { companyId, requestedService }
    });
    if (existing) {
      return res.status(400).json({ success: false, message: `Mapping for requested service "${requestedService}" already exists` });
    }

    const mapping = await CourierMapping.create({
      companyId,
      requestedService,
      courierName,
      courierService
    });

    // Auto-apply this new mapping to matching existing open orders
    let updatedOrdersCount = 0;
    try {
      const { applyCourierMappingsToOrders } = require('../services/orderService');
      const resApply = await applyCourierMappingsToOrders(companyId, mapping);
      updatedOrdersCount = resApply?.count || 0;
    } catch (e) {
      console.warn('[Auto-apply courier mapping warning]:', e.message);
    }

    res.json({ success: true, data: mapping, ordersUpdated: updatedOrdersCount });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;
    const { requestedService, courierName, courierService } = req.body;

    const mapping = await CourierMapping.findOne({
      where: { id, companyId }
    });
    if (!mapping) {
      return res.status(404).json({ success: false, message: 'Courier mapping not found' });
    }

    if (requestedService) {
      // Check duplicate
      const duplicate = await CourierMapping.findOne({
        where: {
          companyId,
          requestedService,
          id: { [require('sequelize').Op.ne]: id }
        }
      });
      if (duplicate) {
        return res.status(400).json({ success: false, message: `Mapping for requested service "${requestedService}" already exists` });
      }
      mapping.requestedService = requestedService;
    }

    if (courierName) mapping.courierName = courierName;
    if (courierService) mapping.courierService = courierService;

    await mapping.save();

    // Auto-apply updated mapping to matching open orders
    let updatedOrdersCount = 0;
    try {
      const { applyCourierMappingsToOrders } = require('../services/orderService');
      const resApply = await applyCourierMappingsToOrders(companyId, mapping);
      updatedOrdersCount = resApply?.count || 0;
    } catch (e) {
      console.warn('[Auto-apply courier mapping warning]:', e.message);
    }

    res.json({ success: true, data: mapping, ordersUpdated: updatedOrdersCount });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;

    const mapping = await CourierMapping.findOne({
      where: { id, companyId }
    });
    if (!mapping) {
      return res.status(404).json({ success: false, message: 'Courier mapping not found' });
    }

    await mapping.destroy();
    res.json({ success: true, message: 'Courier mapping deleted successfully' });
  } catch (err) {
    next(err);
  }
}

async function applyToOrders(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const { applyCourierMappingsToOrders } = require('../services/orderService');
    const result = await applyCourierMappingsToOrders(companyId);
    res.json({ success: true, count: result.count, message: `Successfully applied courier mappings to ${result.count} order(s)!` });
  } catch (err) {
    next(err);
  }
}

async function getUnmappedServices(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const { SalesOrder, CourierMapping } = require('../models');
    const { Op } = require('sequelize');

    const [orders, mappings] = await Promise.all([
      SalesOrder.findAll({
        where: {
          [Op.or]: [
            { companyId },
            { companyId: 1 },
            { companyId: null }
          ],
          status: { [Op.notIn]: ['CANCELLED'] }
        },
        attributes: ['requestedShippingService', 'courierService', 'courierName']
      }),
      CourierMapping.findAll({
        where: {
          [Op.or]: [
            { companyId },
            { companyId: 1 },
            { companyId: null }
          ]
        },
        attributes: ['requestedService']
      })
    ]);

    const mappedSet = new Set(mappings.map(m => (m.requestedService || '').toLowerCase().trim()));

    const serviceMap = {};
    for (const o of orders) {
      const s1 = (o.requestedShippingService || '').trim();
      const s2 = (o.courierService || '').trim();
      const carrier = (o.courierName || '').trim();

      const candidates = [s1, s2].filter(Boolean);
      for (const s of candidates) {
        if (!serviceMap[s]) {
          serviceMap[s] = {
            name: s,
            orderCount: 0,
            carrier: carrier || 'SHIPSTATION',
            isMapped: mappedSet.has(s.toLowerCase().trim())
          };
        }
        serviceMap[s].orderCount += 1;
      }
    }

    const list = Object.values(serviceMap).sort((a, b) => b.orderCount - a.orderCount);
    res.json({ success: true, data: list });
  } catch (err) {
    next(err);
  }
}

async function getAvailableServices(req, res, next) {
  try {
    const companyId = req.user.companyId;
    
    // Check if there are custom courier services defined for this company
    const customServices = await CourierService.findAll({
      where: { companyId },
      order: [['courier', 'ASC'], ['serviceName', 'ASC']]
    });

    if (customServices && customServices.length > 0) {
      const services = {};
      for (const cs of customServices) {
        if (!services[cs.courier]) {
          services[cs.courier] = [];
        }
        // Avoid duplicate service names for same courier
        if (!services[cs.courier].includes(cs.serviceName)) {
          services[cs.courier].push(cs.serviceName);
        }
      }
      return res.json({ success: true, data: services });
    }

    const services = {
      'Royal Mail': [
        'Royal Mail Tracked 24',
        'Royal Mail Tracked 48',
        'Royal Mail Special Delivery',
        'Royal Mail 24',
        'Royal Mail 48'
      ],
      'Parcel Force': [
        'Parcel Force Express 24',
        'Parcel Force Express 48',
        'Parcel Force Express 9',
        'Parcel Force Express 10'
      ],
      'DPD': [
        'DPD Next Day',
        'DPD 10:30',
        'DPD 12:00',
        'DPD Saturday',
        'DPD Sunday'
      ]
    };
    res.json({ success: true, data: services });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, remove, getAvailableServices, applyToOrders, getUnmappedServices };

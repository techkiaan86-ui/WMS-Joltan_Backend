const { IntegrationConfig } = require('../../models');
const shipstationService = require('./shipstation.service');

async function syncOrders(req, res, next) {
  try {
    const companyId = req.user.companyId || req.body.companyId || 1;
    const result = await shipstationService.syncOrdersFromShipStation(companyId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function webhook(req, res, next) {
  try {
    const companyId = req.query.companyId || 1;
    await shipstationService.syncOrdersFromShipStation(companyId);
    res.json({ success: true });
  } catch (err) {
    console.error('ShipStation webhook error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getStores(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const stores = await shipstationService.getShipStationStores(companyId);
    res.json({ success: true, stores });
  } catch (err) {
    next(err);
  }
}

async function getStoreMappings(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const config = await IntegrationConfig.findOne({
      where: { companyId, platform: 'SHIPSTATION' }
    });
    const creds = config && config.credentials ? (typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials) : {};
    
    // Instant response from local database (< 5ms)
    let stores = creds.cachedStores || creds.stores || [];

    // Only fetch remote stores if explicitly requested via ?refreshStores=true
    if (req.query.refreshStores === 'true') {
      try {
        const liveStores = await shipstationService.getShipStationStores(companyId);
        if (Array.isArray(liveStores) && liveStores.length > 0) {
          stores = liveStores;
          creds.cachedStores = liveStores;
          await config.update({ credentials: JSON.stringify(creds) });
        }
      } catch (e) {
        // Ignore remote store fetch errors
      }
    }

    res.json({
      success: true,
      apiKey: creds.apiKey || process.env.SHIPSTATION_API_KEY || '',
      orderSyncDays: Number(creds.orderSyncDays) || 30,
      startDate: creds.startDate || null,
      endDate: creds.endDate || null,
      storeMappings: creds.storeMappings || {},
      stores
    });
  } catch (err) {
    next(err);
  }
}

async function saveStoreMappings(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const { storeMappings, apiKey, apiSecret, orderSyncDays, startDate, endDate, autoSync } = req.body;

    let config = await IntegrationConfig.findOne({
      where: { companyId, platform: 'SHIPSTATION' }
    });

    const oldCreds = config && config.credentials ? (typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials) : {};
    const newCreds = {
      apiKey: apiKey && apiKey !== '********' ? apiKey : (oldCreds.apiKey || process.env.SHIPSTATION_API_KEY || ''),
      apiSecret: apiSecret && apiSecret !== '********' ? apiSecret : (oldCreds.apiSecret || process.env.SHIPSTATION_API_SECRET || ''),
      orderSyncDays: orderSyncDays ? Math.max(1, Number(orderSyncDays) || 30) : (oldCreds.orderSyncDays || 30),
      startDate: startDate || oldCreds.startDate || null,
      endDate: endDate || oldCreds.endDate || null,
      storeMappings: storeMappings || oldCreds.storeMappings || {},
      cachedStores: oldCreds.cachedStores || oldCreds.stores || []
    };

    const payload = {
      companyId,
      platform: 'SHIPSTATION',
      status: 'ACTIVE',
      credentials: JSON.stringify(newCreds)
    };

    if (config) {
      await config.update(payload);
    } else {
      await IntegrationConfig.create(payload);
    }

    // Only run order sync if explicitly requested (e.g. Save & Sync Now)
    let syncedCount = 0;
    if (autoSync === true) {
      try {
        const syncResult = await shipstationService.syncOrdersFromShipStation(companyId, {
          daysPast: newCreds.orderSyncDays,
          startDate: newCreds.startDate,
          endDate: newCreds.endDate
        });
        syncedCount = syncResult?.syncedCount || 0;
      } catch (err) {
        console.error('[ShipStation Sync Error on Save]:', err.message);
      }
    }

    const msg = autoSync
      ? `✅ Settings saved & ${syncedCount} orders synced into WMS.`
      : '✅ ShipStation sync settings saved successfully.';

    res.json({
      success: true,
      message: msg,
      storeMappings: newCreds.storeMappings,
      orderSyncDays: newCreds.orderSyncDays,
      startDate: newCreds.startDate,
      endDate: newCreds.endDate,
      syncedCount
    });
  } catch (err) {
    next(err);
  }
}

async function getRates(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const rates = await shipstationService.getRates(companyId, req.body);
    res.json({ success: true, data: rates });
  } catch (err) { next(err); }
}

async function createShipment(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const result = await shipstationService.createShipment(companyId, req.body);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function listShipments(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.listShipments(companyId, req.query);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function createV2Label(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.createV2Label(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function createReturnLabel(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.createReturnLabel(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function createBatchLabels(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.createBatchLabels(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function createManifest(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.createManifest(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function schedulePickup(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.schedulePickup(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getInventoryLevels(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.getInventoryLevels(companyId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getInventoryWarehouses(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.getInventoryWarehouses(companyId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getInventoryLocations(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.getInventoryLocations(companyId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getUsers(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.getUsers(companyId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

module.exports = {
  syncOrders,
  webhook,
  getStoreMappings,
  saveStoreMappings,
  getStores,
  getRates,
  createShipment,
  listShipments,
  createV2Label,
  createReturnLabel,
  createBatchLabels,
  createManifest,
  schedulePickup,
  getInventoryLevels,
  getInventoryWarehouses,
  getInventoryLocations,
  getUsers
};

const { ProductPool, Product, Bundle, BundleItem, OrderItem, Category, Warehouse, Location, Zone, ProductStock, sequelize } = require('../models');
const { Op } = require('sequelize');

let tableEnsured = false;

/**
 * Ensures that a catalog product exists for a given ProductPool item.
 * Creates it if not present so it can be linked to bundles or orders.
 */
async function ensureProductForPoolItem(poolItem) {
  if (!poolItem) return null;
  const compId = poolItem.companyId || 1;
  const sku = poolItem.sku ? String(poolItem.sku).trim() : '';
  if (!sku) return null;

  let product = await Product.findOne({
    where: {
      companyId: compId,
      sku: sku
    }
  });

  if (!product) {
    let cleanName = poolItem.name;
    if (!cleanName || cleanName.startsWith('Unmatched SKU') || cleanName.toLowerCase().includes('undefined')) {
      cleanName = poolItem.sku;
    }

    const sellingPrice = Number(poolItem.unitPrice || 0);
    const calculatedCost = poolItem.costPrice > 0
      ? Number(poolItem.costPrice)
      : (sellingPrice > 0 ? Number((sellingPrice * 0.6).toFixed(2)) : 5.00);
    const weightVal = poolItem.weight ? parseFloat(poolItem.weight) || 200 : 200;

    product = await Product.create({
      companyId: compId,
      name: cleanName,
      sku: sku,
      barcode: poolItem.barcode || sku,
      price: sellingPrice,
      costPrice: calculatedCost,
      weight: weightVal,
      weightUnit: 'g',
      status: 'ACTIVE',
      description: `${cleanName} - Auto-cataloged from Product Pool`,
      images: poolItem.imageUrl ? [poolItem.imageUrl] : null
    });

    try {
      const defaultWarehouse = await Warehouse.findOne({ where: { companyId: compId } });
      if (defaultWarehouse) {
        await ProductStock.findOrCreate({
          where: { productId: product.id, warehouseId: defaultWarehouse.id },
          defaults: { quantity: 0, reserved: 0 }
        });
      }
    } catch (_) {}
  }

  return product;
}

/**
 * Automatically backfills any ProductPool items that were matched to a bundle
 * so their child product is created in the catalog and registered in bundle_items.
 */
async function syncMatchedBundlesToComponents() {
  try {
    const matchedPoolItems = await ProductPool.findAll({
      where: {
        status: 'MATCHED_BUNDLE',
        resolvedBundleId: { [Op.ne]: null }
      }
    });

    for (const poolItem of matchedPoolItems) {
      const targetBundle = await Bundle.findByPk(poolItem.resolvedBundleId);
      if (!targetBundle) continue;

      const product = await ensureProductForPoolItem(poolItem);
      if (!product) continue;

      const existingBundleItem = await BundleItem.findOne({
        where: {
          bundleId: targetBundle.id,
          productId: product.id
        }
      });

      if (!existingBundleItem) {
        await BundleItem.create({
          bundleId: targetBundle.id,
          productId: product.id,
          quantity: 1
        });
        console.log(`[ProductPool] Synced component product "${product.sku}" into Bundle "${targetBundle.sku}" (ID: ${targetBundle.id})`);
      }

      if (!poolItem.resolvedProductId || poolItem.resolvedProductId !== product.id) {
        await poolItem.update({ resolvedProductId: product.id });
      }

      // Link order items
      await OrderItem.update(
        {
          productId: product.id,
          isBundleParent: true,
          bundleHeader: `Bundle: ${targetBundle.name} (${targetBundle.sku})`
        },
        { where: { originalSku: poolItem.sku } }
      ).catch(() => {});
    }
  } catch (err) {
    console.warn('[syncMatchedBundlesToComponents error]:', err.message);
  }
}

async function ensureTableExists() {
  if (tableEnsured) return;
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS product_pool (
        id INT NOT NULL AUTO_INCREMENT,
        company_id INT NOT NULL DEFAULT 1,
        sku VARCHAR(255) NOT NULL,
        name VARCHAR(255) DEFAULT NULL,
        channel VARCHAR(100) DEFAULT 'SHIPSTATION',
        order_number VARCHAR(100) DEFAULT NULL,
        image_url TEXT DEFAULT NULL,
        barcode VARCHAR(255) DEFAULT NULL,
        unit_price DECIMAL(12,2) DEFAULT 0.00,
        cost_price DECIMAL(12,2) DEFAULT 0.00,
        weight VARCHAR(100) DEFAULT NULL,
        raw_details LONGTEXT DEFAULT NULL,
        status VARCHAR(50) DEFAULT 'PENDING',
        resolved_product_id INT DEFAULT NULL,
        resolved_bundle_id INT DEFAULT NULL,
        notes TEXT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_product_pool_company_sku (company_id, sku),
        INDEX idx_product_pool_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await sequelize.query("ALTER TABLE product_pool ADD COLUMN barcode VARCHAR(255) NULL").catch(() => {});
    await sequelize.query("ALTER TABLE product_pool ADD COLUMN weight VARCHAR(100) NULL").catch(() => {});
    await sequelize.query("ALTER TABLE product_pool ADD COLUMN cost_price DECIMAL(12,2) DEFAULT 0.00").catch(() => {});
    await sequelize.query("ALTER TABLE product_pool ADD COLUMN raw_details LONGTEXT NULL").catch(() => {});
    await sequelize.query("ALTER TABLE order_items ADD COLUMN name VARCHAR(255) NULL").catch(() => {});
    tableEnsured = true;

    // Run background sync for already matched bundles
    syncMatchedBundlesToComponents().catch(() => {});
  } catch (err) {
    console.warn('[ProductPool Table Notice]:', err.message);
  }
}

async function scanUnmatchedOrders(companyId = 1) {
  try {
    await ensureTableExists();

    // Clean up corrupted or invalid SKUs from the pool
    await sequelize.query(`
      DELETE FROM product_pool 
      WHERE LOWER(TRIM(sku)) IN ('undefined', 'null', '', 'unmatched-pool') 
         OR sku IS NULL 
         OR LOWER(TRIM(name)) LIKE '%undefined%' 
         OR LOWER(TRIM(name)) = 'unmatched sku (undefined)'
    `).catch(() => {});

    // 1. Scan order_items where product_id is null/0, or points to placeholder UNMATCHED-POOL product
    const [unmatchedItems] = await sequelize.query(`
      SELECT oi.id, oi.original_sku, oi.name, oi.product_image_url, oi.unit_price, so.order_number,
             COALESCE(so.marketplace, so.sales_channel, 'SHIPSTATION') AS channel,
             p.sku AS prod_sku
      FROM order_items oi
      INNER JOIN sales_orders so ON oi.sales_order_id = so.id
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE (oi.product_id IS NULL OR oi.product_id = 0 OR p.sku = 'UNMATCHED-POOL')
        AND oi.original_sku IS NOT NULL 
        AND TRIM(oi.original_sku) != ''
        AND oi.original_sku NOT IN ('UNMATCHED-POOL', 'undefined', 'null')
    `).catch(err => {
      console.warn('[scanUnmatchedOrders query warning]:', err.message);
      return [[]];
    });

    // 2. Also scan sales_orders with warning notes
    const [flaggedOrders] = await sequelize.query(`
      SELECT id, order_number, internal_notes,
             COALESCE(marketplace, sales_channel, 'SHIPSTATION') AS channel
      FROM sales_orders
      WHERE internal_notes LIKE '%WARNING: Unmatched SKU%' OR internal_notes LIKE '%Routed to Product Pool%'
    `).catch(() => [[]]);

    let addedCount = 0;

    for (const item of unmatchedItems) {
      const cleanSku = String(item.original_sku).trim();
      if (!cleanSku || cleanSku === 'UNMATCHED-POOL' || cleanSku === 'undefined' || cleanSku === 'null') continue;

      const existingProd = await Product.findOne({
        where: {
          sku: cleanSku,
          [Op.and]: [{ sku: { [Op.ne]: 'UNMATCHED-POOL' } }]
        }
      });
      if (existingProd) {
        await sequelize.query(`UPDATE order_items SET product_id = :pId WHERE id = :id`, {
          replacements: { pId: existingProd.id, id: item.id }
        }).catch(() => {});
        continue;
      }

      const itemName = (item.name || '').trim();
      const existingPool = await ProductPool.findOne({ where: { sku: cleanSku } });
      if (!existingPool) {
        await ProductPool.create({
          companyId: companyId || 1,
          sku: cleanSku,
          name: itemName || cleanSku,
          channel: item.channel || 'SHIPSTATION',
          orderNumber: item.order_number,
          imageUrl: item.product_image_url || null,
          unitPrice: item.unit_price || 0,
          status: 'PENDING',
          notes: `Detected from Order #${item.order_number}`
        });
        addedCount++;
      } else if (itemName && (!existingPool.name || existingPool.name.startsWith('Unmatched SKU') || existingPool.name === existingPool.sku)) {
        await existingPool.update({
          name: itemName,
          imageUrl: item.product_image_url || existingPool.imageUrl
        });
      }
    }

    for (const o of flaggedOrders) {
      const match = (o.internal_notes || '').match(/Unmatched SKU "([^"]+)"/);
      if (match && match[1]) {
        const cleanSku = match[1].trim();
        if (!cleanSku || cleanSku === 'UNMATCHED-POOL' || cleanSku === 'undefined' || cleanSku === 'null') continue;
        const existingProd = await Product.findOne({
          where: {
            sku: cleanSku,
            [Op.and]: [{ sku: { [Op.ne]: 'UNMATCHED-POOL' } }]
          }
        });
        if (!existingProd) {
          const existingPool = await ProductPool.findOne({ where: { sku: cleanSku } });
          if (!existingPool) {
            await ProductPool.create({
              companyId: companyId || 1,
              sku: cleanSku,
              name: cleanSku,
              channel: o.channel || 'SHIPSTATION',
              orderNumber: o.order_number,
              status: 'PENDING',
              notes: `Extracted from warning note in Order #${o.order_number}`
            });
            addedCount++;
          }
        }
      }
    }

    // Auto-enrich from ShipStation V2
    try {
      const shipstationService = require('../modules/integrations/shipstation.service');
      if (shipstationService && typeof shipstationService.enrichPoolFromShipStation === 'function') {
        await shipstationService.enrichPoolFromShipStation(companyId);
      }
    } catch (_) {}

    return addedCount;
  } catch (err) {
    console.error('[scanUnmatchedOrders Error]:', err.message);
    return 0;
  }
}

/**
 * List all items in the Product Pool with counts and filtering
 */
async function list(req, res, next) {
  try {
    await ensureTableExists();
    await syncMatchedBundlesToComponents().catch(() => {});

    const companyId = (req.user && req.user.role !== 'super_admin' && req.user.companyId) ? req.user.companyId : (req.query.companyId || 1);
    const { status, search, page = 1, pageSize = 20 } = req.query;

    // Auto-clean any undefined entries
    await sequelize.query(`
      DELETE FROM product_pool 
      WHERE LOWER(TRIM(sku)) IN ('undefined', 'null', '', 'unmatched-pool') 
         OR sku IS NULL 
         OR LOWER(TRIM(name)) LIKE '%undefined%'
    `).catch(() => {});

    // If pool is completely empty, do an initial scan so user doesn't see blank page
    const poolCount = await ProductPool.count().catch(() => 0);
    if (poolCount === 0) {
      await scanUnmatchedOrders(companyId);
    }

    // If there are still items with placeholder "Unmatched SKU", trigger background enrichment from ShipStation V2
    const placeholderCount = await ProductPool.count({
      where: {
        name: { [Op.like]: 'Unmatched SKU%' }
      }
    }).catch(() => 0);
    if (placeholderCount > 0) {
      const shipstationService = require('../modules/integrations/shipstation.service');
      if (shipstationService && typeof shipstationService.enrichPoolFromShipStation === 'function') {
        shipstationService.enrichPoolFromShipStation(companyId).catch(() => {});
      }
    }

    const where = {
      [Op.or]: [
        { companyId },
        { companyId: 1 },
        { companyId: null }
      ]
    };

    if (status && status !== 'all') {
      where.status = status;
    }

    if (search && search.trim() !== '') {
      const s = `%${search.trim()}%`;
      where[Op.and] = [
        ...(where[Op.and] || []),
        {
          [Op.or]: [
            { sku: { [Op.like]: s } },
            { name: { [Op.like]: s } },
            { orderNumber: { [Op.like]: s } },
            { channel: { [Op.like]: s } }
          ]
        }
      ];
    }

    const limit = parseInt(pageSize, 10) || 20;
    const offset = (parseInt(page, 10) - 1) * limit;

    const { count, rows } = await ProductPool.findAndCountAll({
      where,
      include: [
        { association: 'ResolvedProduct', attributes: ['id', 'name', 'sku', 'price', 'barcode'], required: false },
        { association: 'ResolvedBundle', attributes: ['id', 'name', 'sku'], required: false }
      ],
      order: [
        ['id', 'DESC']
      ],
      limit,
      offset
    });

    // Compute stats for tabs/badges
    const baseWhere = {
      [Op.or]: [{ companyId }, { companyId: 1 }, { companyId: null }]
    };
    const [total, pending, matchedAlt, matchedBundle, created, ignored] = await Promise.all([
      ProductPool.count({ where: baseWhere }),
      ProductPool.count({ where: { ...baseWhere, status: 'PENDING' } }),
      ProductPool.count({ where: { ...baseWhere, status: 'MATCHED_ALT' } }),
      ProductPool.count({ where: { ...baseWhere, status: 'MATCHED_BUNDLE' } }),
      ProductPool.count({ where: { ...baseWhere, status: 'CREATED' } }),
      ProductPool.count({ where: { ...baseWhere, status: 'IGNORED' } })
    ]);

    res.json({
      success: true,
      items: rows,
      total: count,
      page: parseInt(page, 10),
      pageSize: limit,
      stats: {
        total,
        pending,
        matchedAlt,
        matchedBundle,
        created,
        ignored
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Match a pool SKU to an existing Product as an Alternative SKU
 */
async function matchAlternative(req, res, next) {
  try {
    const { id } = req.params;
    const { targetProductId, notes } = req.body;

    if (!targetProductId) {
      return res.status(400).json({ success: false, message: 'Target product ID is required' });
    }

    const poolItem = await ProductPool.findByPk(id);
    if (!poolItem) {
      return res.status(404).json({ success: false, message: 'Pool item not found' });
    }

    const targetProduct = await Product.findByPk(targetProductId);
    if (!targetProduct) {
      return res.status(404).json({ success: false, message: 'Target product not found' });
    }

    // Add this SKU into the target product's alternativeSkus array
    let altList = [];
    if (typeof targetProduct.alternativeSkus === 'string') {
      try { altList = JSON.parse(targetProduct.alternativeSkus); } catch (_) { altList = []; }
    } else if (Array.isArray(targetProduct.alternativeSkus)) {
      altList = [...targetProduct.alternativeSkus];
    }

    const skuNormalized = poolItem.sku.trim();
    const alreadyExists = altList.some(item => {
      const s = typeof item === 'string' ? item : item?.sku;
      return s && s.toLowerCase() === skuNormalized.toLowerCase();
    });

    if (!alreadyExists) {
      altList.push({
        id: `alt-${Date.now()}`,
        sku: skuNormalized,
        skuType: 'CHANNEL_ALIAS',
        channelType: poolItem.channel || 'SHIPSTATION',
        active: true,
        notes: notes || `Matched from Product Pool (Order ${poolItem.orderNumber || 'N/A'})`
      });
      await targetProduct.update({ alternativeSkus: altList });
    }

    // Retroactively link any existing unlinked OrderItems with this SKU to the target product
    await OrderItem.update(
      { productId: targetProduct.id },
      { where: { originalSku: skuNormalized, productId: null } }
    ).catch(() => {});

    // Update pool item status
    await poolItem.update({
      status: 'MATCHED_ALT',
      resolvedProductId: targetProduct.id,
      notes: notes || `Matched to alternative SKU on "${targetProduct.name}" (${targetProduct.sku})`
    });

    res.json({
      success: true,
      message: `Successfully mapped SKU "${skuNormalized}" as Alternative SKU to product "${targetProduct.name}" (${targetProduct.sku})!`,
      poolItem
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Match a pool SKU to an existing or new Bundle
 */
async function matchBundle(req, res, next) {
  try {
    const { id } = req.params;
    const { bundleId, bundleSku, bundleName, notes, quantity, componentQuantity } = req.body;

    const poolItem = await ProductPool.findByPk(id);
    if (!poolItem) {
      return res.status(404).json({ success: false, message: 'Pool item not found' });
    }

    let targetBundle = null;
    if (bundleId) {
      targetBundle = await Bundle.findByPk(bundleId);
    } else if (bundleSku) {
      targetBundle = await Bundle.findOne({ where: { sku: bundleSku.trim() } });
    }

    if (!targetBundle && bundleName) {
      // Create new bundle
      targetBundle = await Bundle.create({
        companyId: poolItem.companyId || 1,
        sku: poolItem.sku,
        name: bundleName || poolItem.name || poolItem.sku,
        description: `Created from Product Pool for SKU ${poolItem.sku}`,
        status: 'ACTIVE'
      });
    }

    if (!targetBundle) {
      return res.status(400).json({ success: false, message: 'Valid bundle ID or Bundle details required' });
    }

    // 1. Ensure Product exists in the catalog so it can be added as a component to the bundle
    const product = await ensureProductForPoolItem(poolItem);
    if (!product) {
      return res.status(500).json({ success: false, message: 'Could not initialize product for bundle component' });
    }

    // 2. Add or update component in bundle_items
    const compQty = parseInt(quantity || componentQuantity || 1, 10) || 1;
    const existingBundleItem = await BundleItem.findOne({
      where: {
        bundleId: targetBundle.id,
        productId: product.id
      }
    });

    if (existingBundleItem) {
      await existingBundleItem.update({ quantity: compQty });
    } else {
      await BundleItem.create({
        bundleId: targetBundle.id,
        productId: product.id,
        quantity: compQty
      });
    }

    // 3. Recalculate bundle cost price from all its components
    try {
      const allBundleItems = await BundleItem.findAll({
        where: { bundleId: targetBundle.id },
        include: [{ association: 'Product' }]
      });
      let calculatedBundleCost = 0;
      for (const bi of allBundleItems) {
        const itemCost = Number(bi.Product?.costPrice || 0);
        const itemQty = Number(bi.quantity || 1);
        calculatedBundleCost += itemCost * itemQty;
      }
      if (calculatedBundleCost > 0) {
        await targetBundle.update({ costPrice: parseFloat(calculatedBundleCost.toFixed(2)) });
      }
    } catch (_) {}

    // 4. Retroactively update relevant order items
    await OrderItem.update(
      {
        productId: product.id,
        isBundleParent: true,
        bundleHeader: `Bundle: ${targetBundle.name} (${targetBundle.sku})`
      },
      { where: { originalSku: poolItem.sku } }
    ).catch(() => {});

    // 5. Update pool item
    await poolItem.update({
      status: 'MATCHED_BUNDLE',
      resolvedBundleId: targetBundle.id,
      resolvedProductId: product.id,
      notes: notes || `Added as component child product (${compQty}x) to Bundle "${targetBundle.name}" (${targetBundle.sku})`
    });

    res.json({
      success: true,
      message: `Successfully added product "${product.name}" (${product.sku}) to Bundle "${targetBundle.name}" with quantity ${compQty}!`,
      poolItem,
      bundle: targetBundle,
      product
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Zoltan explicitly decides to create this as a real new product in catalog
 */
async function createProduct(req, res, next) {
  try {
    const { id } = req.params;
    const { name, categoryId, price, costPrice, barcode, description, weight, status } = req.body;

    const poolItem = await ProductPool.findByPk(id);
    if (!poolItem) {
      return res.status(404).json({ success: false, message: 'Pool item not found' });
    }

    const compId = poolItem.companyId || 1;

    // Check if already exists in Product catalog
    let existing = await Product.findOne({ where: { sku: poolItem.sku, companyId: compId } });
    if (existing) {
      await poolItem.update({ status: 'CREATED', resolvedProductId: existing.id });
      return res.json({ success: true, message: `Product already exists in catalog. Linked successfully.`, product: existing });
    }

    const newProduct = await Product.create({
      companyId: compId,
      categoryId: categoryId || null,
      name: name || poolItem.name || poolItem.sku,
      sku: poolItem.sku,
      barcode: barcode || poolItem.sku,
      price: parseFloat(price != null ? price : poolItem.unitPrice || 0),
      costPrice: parseFloat(costPrice || (price > 0 ? (price * 0.6).toFixed(2) : 5.00)),
      description: description || `${name || poolItem.name} - Manually approved from Product Pool`,
      weight: parseFloat(weight || 200.00),
      weightUnit: 'g',
      status: status || 'ACTIVE',
      images: poolItem.imageUrl ? [poolItem.imageUrl] : null
    });

    // Ensure warehouse stock record exists
    try {
      const warehouse = await Warehouse.findOne({ where: { companyId: compId } });
      if (warehouse) {
        let location = await Location.findOne({ where: { warehouseId: warehouse.id } });
        await ProductStock.create({
          companyId: compId,
          productId: newProduct.id,
          warehouseId: warehouse.id,
          locationId: location ? location.id : null,
          quantity: 100,
          allocatedQty: 0,
          status: 'ACTIVE'
        });
      }
    } catch (_) {}

    // Link any unlinked OrderItems
    await OrderItem.update(
      { productId: newProduct.id },
      { where: { originalSku: poolItem.sku, productId: null } }
    ).catch(() => {});

    await poolItem.update({
      status: 'CREATED',
      resolvedProductId: newProduct.id,
      notes: 'Manually created and approved as new catalog product'
    });

    res.json({
      success: true,
      message: `Successfully created product "${newProduct.name}" (${newProduct.sku}) in catalog!`,
      product: newProduct
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Ignore / Dismiss a pool item
 */
async function ignore(req, res, next) {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const poolItem = await ProductPool.findByPk(id);
    if (!poolItem) {
      return res.status(404).json({ success: false, message: 'Pool item not found' });
    }

    await poolItem.update({
      status: 'IGNORED',
      notes: notes || 'Dismissed / Ignored by Admin'
    });

    res.json({
      success: true,
      message: `Item "${poolItem.sku}" marked as Ignored.`,
      poolItem
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete a pool item
 */
async function remove(req, res, next) {
  try {
    const { id } = req.params;
    const poolItem = await ProductPool.findByPk(id);
    if (!poolItem) {
      return res.status(404).json({ success: false, message: 'Pool item not found' });
    }

    await poolItem.destroy();
    res.json({ success: true, message: 'Pool item removed successfully' });
  } catch (err) {
    next(err);
  }
}

/**
 * Trigger manual scan for unmatched orders
 */
async function scan(req, res, next) {
  try {
    const companyId = (req.user && req.user.role !== 'super_admin' && req.user.companyId) ? req.user.companyId : 1;
    const addedCount = await scanUnmatchedOrders(companyId);

    // Also enrich with full product names and images from ShipStation
    let enrichedCount = 0;
    try {
      const shipstationService = require('../modules/integrations/shipstation.service');
      if (shipstationService && typeof shipstationService.enrichPoolFromShipStation === 'function') {
        enrichedCount = await shipstationService.enrichPoolFromShipStation(companyId);
      }
    } catch (_) {}

    res.json({
      success: true,
      message: `Scan & enrichment complete! Found ${addedCount} order item(s), enriched ${enrichedCount} product details from ShipStation.`,
      addedCount,
      enrichedCount
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  scan,
  matchAlternative,
  matchBundle,
  createProduct,
  ignore,
  remove
};

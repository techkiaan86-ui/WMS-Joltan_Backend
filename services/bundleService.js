const { Bundle, BundleItem, Product, ProductStock } = require('../models');
const { Op } = require('sequelize');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role !== 'super_admin') where.companyId = reqUser.companyId;
  else if (query.companyId) where.companyId = query.companyId;
  if (query.search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.search}%` } },
      { sku: { [Op.like]: `%${query.search}%` } },
    ];
  }
  const bundles = await Bundle.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [{
      association: 'BundleItems',
      include: [{
        association: 'Product',
        attributes: ['id', 'name', 'sku', 'costPrice', 'price'],
        include: [{
          association: 'ProductStocks',
          attributes: ['quantity', 'reserved']
        }]
      }],
    }],
  });
  return bundles.map(b => {
    const j = b.toJSON();
    let minBuildable = Infinity;
    if (j.BundleItems && j.BundleItems.length > 0) {
      j.bundleItems = j.BundleItems.map(it => {
        const prod = it.Product;
        const totalStock = (prod?.ProductStocks || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
        const reqQty = Number(it.quantity) || 1;
        const buildable = Math.floor(totalStock / reqQty);
        if (buildable < minBuildable) {
          minBuildable = buildable;
        }
        return {
          id: it.id,
          productId: it.productId,
          quantity: it.quantity,
          child: it.Product,
          componentStock: totalStock,
          buildableQuantity: buildable
        };
      });
      delete j.BundleItems;
    } else {
      minBuildable = 0;
      j.bundleItems = [];
    }
    j.quantity = minBuildable === Infinity ? 0 : minBuildable;
    j.availableStock = j.quantity;
    return j;
  });
}

async function getById(id, reqUser) {
  const bundle = await Bundle.findByPk(id, {
    include: [{
      association: 'BundleItems',
      include: [{
        association: 'Product',
        attributes: ['id', 'name', 'sku', 'costPrice', 'price'],
        include: [{
          association: 'ProductStocks',
          attributes: ['quantity', 'reserved']
        }]
      }],
    }],
  });
  if (!bundle) throw new Error('Bundle not found');
  if (reqUser.role !== 'super_admin' && bundle.companyId !== reqUser.companyId) throw new Error('Bundle not found');
  const j = bundle.toJSON();
  let minBuildable = Infinity;
  if (j.BundleItems && j.BundleItems.length > 0) {
    j.bundleItems = j.BundleItems.map(it => {
      const prod = it.Product;
      const totalStock = (prod?.ProductStocks || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
      const reqQty = Number(it.quantity) || 1;
      const buildable = Math.floor(totalStock / reqQty);
      if (buildable < minBuildable) {
        minBuildable = buildable;
      }
      return {
        id: it.id,
        productId: it.productId,
        quantity: it.quantity,
        child: it.Product,
        componentStock: totalStock,
        buildableQuantity: buildable
      };
    });
    delete j.BundleItems;
  } else {
    minBuildable = 0;
    j.bundleItems = [];
  }
  j.quantity = minBuildable === Infinity ? 0 : minBuildable;
  j.availableStock = j.quantity;
  return j;
}

async function create(data, reqUser) {
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('companyId required');
  const existing = await Bundle.findOne({ where: { companyId, sku: (data.sku || '').trim() } });
  if (existing) throw new Error('Bundle SKU already exists for this company');
  const bundle = await Bundle.create({
    companyId,
    sku: (data.sku || '').trim(),
    name: data.name,
    description: data.description || null,
    costPrice: data.costPrice ?? 0,
    sellingPrice: data.sellingPrice ?? 0,
    status: data.status || 'ACTIVE',
  });
  const items = Array.isArray(data.bundleItems) ? data.bundleItems.filter(i => i.productId && i.quantity > 0) : [];
  for (const it of items) {
    await BundleItem.create({ bundleId: bundle.id, productId: it.productId, quantity: it.quantity });
  }
  return getById(bundle.id, reqUser);
}

async function update(id, data, reqUser) {
  const bundle = await Bundle.findByPk(id);
  if (!bundle) throw new Error('Bundle not found');
  if (reqUser.role !== 'super_admin' && bundle.companyId !== reqUser.companyId) throw new Error('Bundle not found');
  await bundle.update({
    name: data.name ?? bundle.name,
    sku: data.sku !== undefined ? data.sku.trim() : bundle.sku,
    description: data.description !== undefined ? data.description : bundle.description,
    costPrice: data.costPrice !== undefined ? data.costPrice : bundle.costPrice,
    sellingPrice: data.sellingPrice !== undefined ? data.sellingPrice : bundle.sellingPrice,
    status: data.status ?? bundle.status,
  });
  if (Array.isArray(data.bundleItems)) {
    await BundleItem.destroy({ where: { bundleId: bundle.id } });
    for (const it of data.bundleItems.filter(i => i.productId && i.quantity > 0)) {
      await BundleItem.create({ bundleId: bundle.id, productId: it.productId, quantity: it.quantity });
    }
  }
  return getById(bundle.id, reqUser);
}

async function remove(id, reqUser) {
  const bundle = await Bundle.findByPk(id);
  if (!bundle) throw new Error('Bundle not found');
  if (reqUser.role !== 'super_admin' && bundle.companyId !== reqUser.companyId) throw new Error('Bundle not found');
  await BundleItem.destroy({ where: { bundleId: bundle.id } });
  await bundle.destroy();
  return { message: 'Bundle deleted' };
}

async function bulkUpload(data, reqUser) {
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('companyId required');

  const rawBundles = Array.isArray(data.bundles) ? data.bundles : [];
  if (rawBundles.length === 0) throw new Error('No bundles data provided for bulk upload');

  const companyProducts = await Product.findAll({
    where: { companyId },
    attributes: ['id', 'sku', 'name', 'costPrice', 'price'],
  });

  const skuToProductMap = new Map();
  companyProducts.forEach(p => {
    if (p.sku) {
      skuToProductMap.set(p.sku.trim().toLowerCase(), p);
    }
  });

  const results = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (let idx = 0; idx < rawBundles.length; idx++) {
    const row = rawBundles[idx];
    const rowNum = idx + 1;
    const sku = (row.sku || '').trim();
    const name = (row.name || '').trim();

    if (!sku || !name) {
      results.skipped++;
      results.errors.push({ row: rowNum, message: 'Missing SKU or Name' });
      continue;
    }

    const resolvedItems = [];
    const itemsInput = Array.isArray(row.bundleItems) ? row.bundleItems : [];

    for (const item of itemsInput) {
      const q = Number(item.quantity) || 0;
      if (q <= 0) continue;

      let pId = item.productId;
      if (!pId && item.productSku) {
        const prod = skuToProductMap.get(String(item.productSku).trim().toLowerCase());
        if (prod) {
          pId = prod.id;
        }
      }

      if (pId) {
        resolvedItems.push({ productId: pId, quantity: q });
      } else if (item.productSku) {
        results.errors.push({
          row: rowNum,
          message: `Product SKU "${item.productSku}" not found in company inventory.`,
        });
      }
    }

    let costPrice = row.costPrice != null && row.costPrice !== '' ? Number(row.costPrice) : 0;
    if ((costPrice === 0 || isNaN(costPrice)) && resolvedItems.length > 0) {
      let calcCost = 0;
      for (const it of resolvedItems) {
        const p = companyProducts.find(pr => pr.id === it.productId);
        if (p && p.costPrice != null) {
          calcCost += Number(p.costPrice) * it.quantity;
        }
      }
      if (calcCost > 0) costPrice = Math.round(calcCost * 100) / 100;
    }

    const sellingPrice = Number(row.sellingPrice) || 0;
    const status = (row.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const description = row.description || null;

    try {
      const existing = await Bundle.findOne({ where: { companyId, sku } });
      if (existing) {
        await existing.update({
          name,
          description,
          costPrice,
          sellingPrice,
          status,
        });

        await BundleItem.destroy({ where: { bundleId: existing.id } });
        for (const it of resolvedItems) {
          await BundleItem.create({
            bundleId: existing.id,
            productId: it.productId,
            quantity: it.quantity,
          });
        }
        results.updated++;
      } else {
        const newBundle = await Bundle.create({
          companyId,
          sku,
          name,
          description,
          costPrice,
          sellingPrice,
          status,
        });

        for (const it of resolvedItems) {
          await BundleItem.create({
            bundleId: newBundle.id,
            productId: it.productId,
            quantity: it.quantity,
          });
        }
        results.created++;
      }
    } catch (err) {
      results.skipped++;
      results.errors.push({ row: rowNum, message: err.message || 'Failed to save bundle' });
    }
  }

  return results;
}

async function convertFromProduct(productId, data, reqUser) {
  const companyId = reqUser.companyId || data.companyId || 1;
  const product = await Product.findByPk(productId);
  if (!product) throw new Error('Product not found');
  if (reqUser.role !== 'super_admin' && product.companyId !== companyId) throw new Error('Product not found');

  // CASE 1: Linking this product as a component recipe child of an existing bundle (Like Product Pool match-bundle)
  if (data.bundleId) {
    const targetBundle = await Bundle.findByPk(data.bundleId);
    if (!targetBundle) throw new Error('Selected target bundle not found');
    if (reqUser.role !== 'super_admin' && targetBundle.companyId !== companyId) throw new Error('Bundle not found');

    const compQty = parseInt(data.quantity || data.componentQuantity || 1, 10) || 1;
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

    // Recalculate bundle cost price from all its components
    const allBundleItems = await BundleItem.findAll({
      where: { bundleId: targetBundle.id },
      include: [{ association: 'Product' }]
    });
    let calculatedBundleCost = 0;
    for (const bi of allBundleItems) {
      const pCost = bi.Product?.costPrice != null ? Number(bi.Product.costPrice) : (Number(bi.Product?.price || 0) * 0.6);
      calculatedBundleCost += pCost * (bi.quantity || 1);
    }
    if (calculatedBundleCost > 0) {
      await targetBundle.update({ costPrice: Number(calculatedBundleCost.toFixed(2)) });
    }

    return getById(targetBundle.id, reqUser);
  }

  // CASE 2: Creating or updating a bundle with this SKU/Name
  const bundleSku = (data.sku || product.sku).trim();
  const bundleName = (data.name || data.bundleName || product.name).trim();

  // Find or create Bundle record
  let bundle = await Bundle.findOne({ where: { companyId: product.companyId, sku: bundleSku } });
  if (!bundle) {
    bundle = await Bundle.create({
      companyId: product.companyId,
      sku: bundleSku,
      name: bundleName,
      description: data.description || product.description || `Converted from Product ${product.sku}`,
      costPrice: data.costPrice != null ? data.costPrice : (product.costPrice || 0),
      sellingPrice: data.sellingPrice != null ? data.sellingPrice : (product.price || 0),
      status: 'ACTIVE'
    });
  } else {
    await bundle.update({
      name: bundleName,
      description: data.description || bundle.description,
      costPrice: data.costPrice != null ? data.costPrice : bundle.costPrice,
      sellingPrice: data.sellingPrice != null ? data.sellingPrice : bundle.sellingPrice,
      status: 'ACTIVE'
    });
  }

  // Attach components/items if provided (support both bundleItems and items)
  const incomingItems = Array.isArray(data.bundleItems) ? data.bundleItems : (Array.isArray(data.items) ? data.items : null);
  if (incomingItems && incomingItems.length > 0) {
    await BundleItem.destroy({ where: { bundleId: bundle.id } });
    let calculatedCost = 0;
    for (const it of incomingItems.filter(i => i.productId && i.quantity > 0)) {
      await BundleItem.create({ bundleId: bundle.id, productId: it.productId, quantity: it.quantity });
      const compProduct = await Product.findByPk(it.productId);
      if (compProduct) {
        const compCost = compProduct.costPrice != null ? Number(compProduct.costPrice) : (Number(compProduct.price || 0) * 0.6);
        calculatedCost += compCost * Number(it.quantity);
      }
    }
    if (calculatedCost > 0) {
      await bundle.update({ costPrice: Number(calculatedCost.toFixed(2)) });
    }
  }

  // Mark Product as BUNDLE
  await product.update({ productType: 'BUNDLE' });

  return getById(bundle.id, reqUser);
}

module.exports = { list, getById, create, update, remove, bulkUpload, convertFromProduct };


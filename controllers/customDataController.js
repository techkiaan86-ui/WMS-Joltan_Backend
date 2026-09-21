const { CustomizationMapping } = require('../models');
const csvParser = require('csv-parser');
const { Readable } = require('stream');

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  try {
    const { sequelize } = require('../config/db');
    const { Product, CustomSkuRule, CustomizationMapping } = require('../models');

    // 1. Ensure columns exist in customization_mappings table
    await sequelize.query("ALTER TABLE customization_mappings ADD COLUMN expected_count INT NULL").catch(() => {});
    await sequelize.query("ALTER TABLE customization_mappings ADD COLUMN expectedCount INT NULL").catch(() => {});
    await sequelize.query("ALTER TABLE customization_mappings ADD COLUMN costPrice DECIMAL(10, 2) NULL").catch(() => {});
    await sequelize.query("ALTER TABLE customization_mappings ADD COLUMN cost_price DECIMAL(10, 2) NULL").catch(() => {});

    // 2. Synchronize snake_case and camelCase columns
    await sequelize.query("UPDATE customization_mappings SET expected_count = expectedCount WHERE expected_count IS NULL AND expectedCount IS NOT NULL").catch(() => {});
    await sequelize.query("UPDATE customization_mappings SET expectedCount = expected_count WHERE expectedCount IS NULL AND expected_count IS NOT NULL").catch(() => {});
    await sequelize.query("UPDATE customization_mappings SET costPrice = cost_price WHERE (costPrice IS NULL OR costPrice = 0) AND cost_price IS NOT NULL AND cost_price > 0").catch(() => {});
    await sequelize.query("UPDATE customization_mappings SET cost_price = costPrice WHERE (cost_price IS NULL OR cost_price = 0) AND costPrice IS NOT NULL AND costPrice > 0").catch(() => {});

    // 3. Dynamic Backfill Cost Price from products table where costPrice is NULL or 0
    try {
      await sequelize.query(`
        UPDATE customization_mappings cm
        JOIN products p ON LOWER(TRIM(cm.processedSku)) = LOWER(TRIM(p.sku))
        SET cm.costPrice = COALESCE(p.cost_price, p.price),
            cm.cost_price = COALESCE(p.cost_price, p.price)
        WHERE (cm.costPrice IS NULL OR cm.costPrice = 0)
          AND COALESCE(p.cost_price, p.price) IS NOT NULL
          AND COALESCE(p.cost_price, p.price) > 0
      `).catch(async () => {
        const unpriced = await CustomizationMapping.findAll({
          where: { costPrice: null }
        });
        if (unpriced.length > 0) {
          const skus = [...new Set(unpriced.map(u => u.processedSku).filter(Boolean))];
          const prods = await Product.findAll({ where: { sku: skus } });
          const pMap = new Map(prods.map(p => [p.sku.toLowerCase(), p.costPrice || p.price]));
          for (const item of unpriced) {
            const price = pMap.get((item.processedSku || '').toLowerCase());
            if (price) {
              await item.update({ costPrice: price }).catch(() => {});
            }
          }
        }
      });
    } catch (_) {}

    // 4. Dynamic Backfill expected_count from custom_sku_rules
    try {
      await sequelize.query(`
        UPDATE customization_mappings cm
        JOIN custom_sku_rules r ON LOWER(TRIM(cm.originalSku)) = LOWER(TRIM(r.sku))
        SET cm.expected_count = r.expected_count,
            cm.expectedCount = r.expected_count
        WHERE cm.expected_count IS NULL OR cm.expectedCount IS NULL
      `).catch(() => {});
    } catch (_) {}

    // 5. Dynamic Backfill expected_count from originalSku naming patterns (e.g. SF_4 -> 4, EK_12 -> 12, UF_6 -> 6, NA_M_12 -> 12)
    try {
      const uncounted = await CustomizationMapping.findAll({
        attributes: ['id', 'originalSku', 'expectedCount']
      });
      for (const item of uncounted) {
        if (!item.expectedCount && item.originalSku) {
          const match = String(item.originalSku).match(/(?:^|[_-])(\d+)(?:[_-]|$)/);
          if (match && parseInt(match[1], 10) > 0) {
            const count = parseInt(match[1], 10);
            await sequelize.query(`
              UPDATE customization_mappings 
              SET expected_count = ${count}, expectedCount = ${count} 
              WHERE id = ${item.id}
            `).catch(() => {});
          }
        }
      }
    } catch (_) {}

    schemaEnsured = true;
  } catch (err) {
    console.warn('[ensureSchema Warning]:', err.message);
  }
}

async function list(req, res, next) {
  try {
    await ensureSchema();
    const { search, page = 1, pageSize = 50 } = req.query;
    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;

    const where = {};
    if (req.user && req.user.companyId && req.user.role !== 'super_admin') {
      where.companyId = req.user.companyId;
    }

    const { count, rows } = await CustomizationMapping.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      limit,
      offset
    });

    // Enforce dynamic resolution for costPrice and expectedCount
    const { Product, CustomSkuRule } = require('../models');
    const processedSkus = [...new Set(rows.map(r => r.processedSku).filter(Boolean))];
    let products = [];
    try {
      products = await Product.findAll({
        where: { sku: processedSkus },
        attributes: ['sku', 'costPrice', 'price', 'packSize']
      });
    } catch (_) {}
    const productMap = new Map();
    for (const p of products) {
      if (p.sku) productMap.set(p.sku.trim().toLowerCase(), p);
    }

    let skuRules = [];
    try {
      skuRules = await CustomSkuRule.findAll({
        where: { companyId: req.user?.companyId || 1 }
      });
    } catch (_) {}
    const ruleMap = new Map();
    for (const r of skuRules) {
      if (r.sku) ruleMap.set(r.sku.trim().toLowerCase(), r.expectedCount);
    }

    const enrichedItems = rows.map(r => {
      const item = r.toJSON ? r.toJSON() : { ...r };

      // 1. Dynamic Cost Price resolution
      if (item.costPrice == null || Number(item.costPrice) === 0) {
        if (item.cost_price != null && Number(item.cost_price) > 0) {
          item.costPrice = item.cost_price;
        } else {
          const prod = item.processedSku ? productMap.get(item.processedSku.trim().toLowerCase()) : null;
          if (prod) {
            item.costPrice = prod.costPrice != null && Number(prod.costPrice) > 0 ? prod.costPrice : (prod.price || null);
          }
        }
      }

      // 2. Dynamic Pack Items (expectedCount) resolution
      if (item.expectedCount == null) {
        if (item.expected_count != null) {
          item.expectedCount = item.expected_count;
        } else {
          const orig = (item.originalSku || '').trim().toLowerCase();
          if (orig && ruleMap.has(orig)) {
            item.expectedCount = ruleMap.get(orig);
          } else if (orig) {
            const match = orig.match(/(?:^|[_-])(\d+)(?:[_-]|$)/);
            if (match && parseInt(match[1], 10) > 0) {
              item.expectedCount = parseInt(match[1], 10);
            }
          }
        }
      }

      return item;
    });

    res.json({
      success: true,
      data: {
        items: enrichedItems,
        total: count,
        page: parseInt(page),
        pageSize: limit
      }
    });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    await ensureSchema();
    const companyId = req.user?.companyId || 1;
    const { originalSku, asin, optionValue, processedSku, outOfStock, extra, costPrice, expectedCount } = req.body;

    if (!asin || !optionValue || !processedSku) {
      return res.status(400).json({ success: false, message: 'ASIN, optionValue, and processedSku are required' });
    }

    let countVal = expectedCount !== undefined && expectedCount !== null && expectedCount !== '' ? parseInt(expectedCount, 10) : null;
    if (countVal === null && originalSku) {
      const m = String(originalSku).match(/(?:^|[_-])(\d+)(?:[_-]|$)/);
      if (m) countVal = parseInt(m[1], 10);
    }

    let finalCost = costPrice ? parseFloat(costPrice) : null;
    if (finalCost === null && processedSku) {
      try {
        const { Product } = require('../models');
        const p = await Product.findOne({ where: { sku: processedSku.trim() } });
        if (p) finalCost = p.costPrice != null ? p.costPrice : (p.price || null);
      } catch (_) {}
    }

    const item = await CustomizationMapping.create({
      companyId,
      originalSku: originalSku || null,
      asin: asin.trim(),
      optionValue: optionValue.trim(),
      processedSku: processedSku.trim(),
      outOfStock: Boolean(outOfStock),
      extra: extra || null,
      costPrice: finalCost,
      expectedCount: countVal
    });

    // Synchronize both columns in DB
    const { sequelize } = require('../config/db');
    await sequelize.query(
      `UPDATE customization_mappings 
       SET expected_count = ?, expectedCount = ?, costPrice = ?, cost_price = ?
       WHERE id = ?`,
      { replacements: [countVal, countVal, finalCost, finalCost, item.id] }
    ).catch(() => {});

    // If expectedCount was specified and parent originalSku exists, synchronize sibling mappings
    if (countVal !== null && originalSku) {
      await sequelize.query(
        `UPDATE customization_mappings 
         SET expected_count = ?, expectedCount = ?
         WHERE companyId = ? AND LOWER(TRIM(originalSku)) = LOWER(?)`,
        { replacements: [countVal, countVal, companyId, originalSku.trim()] }
      ).catch(() => {});
    }

    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    await ensureSchema();
    const item = await CustomizationMapping.findByPk(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Mapping not found' });

    const { originalSku, asin, optionValue, processedSku, outOfStock, extra, costPrice, expectedCount } = req.body;
    let countVal = expectedCount !== undefined 
      ? (expectedCount !== null && expectedCount !== '' ? parseInt(expectedCount, 10) : null) 
      : item.expectedCount;

    const parsedCost = costPrice !== undefined 
      ? (costPrice !== null && costPrice !== '' ? parseFloat(costPrice) : null) 
      : item.costPrice;

    await item.update({
      originalSku: originalSku !== undefined ? originalSku : item.originalSku,
      asin: asin !== undefined ? asin.trim() : item.asin,
      optionValue: optionValue !== undefined ? optionValue.trim() : item.optionValue,
      processedSku: processedSku !== undefined ? processedSku.trim() : item.processedSku,
      outOfStock: outOfStock !== undefined ? Boolean(outOfStock) : item.outOfStock,
      extra: extra !== undefined ? extra : item.extra,
      costPrice: parsedCost,
      expectedCount: countVal
    });

    // Synchronize both camelCase and snake_case columns
    const { sequelize } = require('../config/db');
    await sequelize.query(
      `UPDATE customization_mappings 
       SET expected_count = ?, expectedCount = ?, costPrice = ?, cost_price = ?
       WHERE id = ?`,
      { replacements: [countVal, countVal, parsedCost, parsedCost, item.id] }
    ).catch(() => {});

    // Synchronize expectedCount across all rows with this parent SKU
    if (countVal !== null && (originalSku || item.originalSku)) {
      const targetSku = (originalSku || item.originalSku).trim();
      await sequelize.query(
        `UPDATE customization_mappings 
         SET expected_count = ?, expectedCount = ?
         WHERE companyId = ? AND LOWER(TRIM(originalSku)) = LOWER(?)`,
        { replacements: [countVal, countVal, item.companyId, targetSku] }
      ).catch(() => {});
    }

    // Synchronize costPrice across all rows with this processed SKU
    if (parsedCost !== null && (processedSku || item.processedSku)) {
      const targetProcSku = (processedSku || item.processedSku).trim();
      await sequelize.query(
        `UPDATE customization_mappings 
         SET costPrice = ?, cost_price = ?
         WHERE companyId = ? AND LOWER(TRIM(processedSku)) = LOWER(?)`,
        { replacements: [parsedCost, parsedCost, item.companyId, targetProcSku] }
      ).catch(() => {});
    }

    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const item = await CustomizationMapping.findByPk(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Mapping not found' });

    await item.destroy();
    res.json({ success: true, message: 'Mapping deleted successfully' });
  } catch (err) {
    next(err);
  }
}

async function uploadCsv(req, res, next) {
  try {
    await ensureSchema();
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'CSV file required' });
    }

    const companyId = req.user?.companyId || 1;
    const { Product, CustomSkuRule } = require('../models');

    // Preload products to auto-fill costPrice if missing in CSV
    let allProds = [];
    try {
      allProds = await Product.findAll({ attributes: ['sku', 'costPrice', 'price'] });
    } catch (_) {}
    const prodCostMap = new Map();
    for (const p of allProds) {
      if (p.sku) prodCostMap.set(p.sku.trim().toLowerCase(), p.costPrice != null ? p.costPrice : p.price);
    }

    const results = [];
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);

    bufferStream
      .pipe(csvParser())
      .on('data', (row) => {
        // Headers matching data.csv: sku, ASIN, optionValue, SKU (processedSku), Pack Items, OUT of Stock, Extra, cost price
        const originalSku = (row.sku || row.OriginalSku || row.originalSku || row.original_sku || row.PARENT_SKU || '').trim();
        const asin = (row.ASIN || row.asin || row.Asin || '').trim();
        const optionValue = (row.optionValue || row.OptionValue || row.option_value || row['Option Value'] || '').trim();
        const processedSku = (row.SKU || row.processedSku || row.ProcessedSku || row.processed_sku || row['Processed SKU'] || '').trim();
        const outOfStockStr = String(row['OUT of Stock'] || row.outOfStock || row['out_of_stock'] || '').trim().toUpperCase();
        const extra = (row.Extra || row.extra || '').trim();
        const costPriceStr = row['cost price'] || row.costPrice || row['cost_price'] || '';
        
        const rawCount = row['Pack Items'] || row['pack_items'] || row['Expected Items'] || row.expectedCount || row.expected_count;
        let countVal = null;
        if (rawCount) {
          countVal = parseInt(rawCount, 10);
        } else if (originalSku) {
          const m = String(originalSku).match(/(?:^|[_-])(\d+)(?:[_-]|$)/);
          if (m) countVal = parseInt(m[1], 10);
        }

        let parsedCost = costPriceStr ? parseFloat(costPriceStr) : null;
        if (parsedCost === null && processedSku) {
          const autoCost = prodCostMap.get(processedSku.toLowerCase());
          if (autoCost != null) parsedCost = parseFloat(autoCost);
        }

        if (processedSku && (asin || originalSku)) {
          results.push({
            companyId,
            originalSku: originalSku || null,
            asin: asin || null,
            optionValue: optionValue || '',
            processedSku: processedSku,
            outOfStock: outOfStockStr === 'TRUE' || outOfStockStr === '1' || outOfStockStr === 'YES',
            extra: extra || null,
            costPrice: parsedCost,
            expectedCount: countVal
          });
        }
      })
      .on('end', async () => {
        let inserted = 0;
        let updated = 0;
        for (const record of results) {
          const whereClause = {
            companyId: record.companyId,
            optionValue: record.optionValue
          };
          if (record.asin) {
            whereClause.asin = record.asin;
          } else if (record.originalSku) {
            whereClause.originalSku = record.originalSku;
          }

          const existing = await CustomizationMapping.findOne({ where: whereClause });
          if (existing) {
            await existing.update({
              originalSku: record.originalSku || existing.originalSku,
              asin: record.asin || existing.asin,
              processedSku: record.processedSku,
              outOfStock: record.outOfStock,
              extra: record.extra || existing.extra,
              costPrice: record.costPrice !== null ? record.costPrice : existing.costPrice,
              expectedCount: record.expectedCount !== null ? record.expectedCount : existing.expectedCount
            });

            // Sync both columns
            const { sequelize } = require('../config/db');
            await sequelize.query(
              `UPDATE customization_mappings 
               SET expected_count = COALESCE(?, expected_count), 
                   expectedCount = COALESCE(?, expectedCount), 
                   costPrice = COALESCE(?, costPrice), 
                   cost_price = COALESCE(?, cost_price)
               WHERE id = ?`,
              { replacements: [record.expectedCount, record.expectedCount, record.costPrice, record.costPrice, existing.id] }
            ).catch(() => {});

            updated++;
          } else {
            const newItem = await CustomizationMapping.create(record);
            const { sequelize } = require('../config/db');
            await sequelize.query(
              `UPDATE customization_mappings 
               SET expected_count = ?, expectedCount = ?, costPrice = ?, cost_price = ?
               WHERE id = ?`,
              { replacements: [record.expectedCount, record.expectedCount, record.costPrice, record.costPrice, newItem.id] }
            ).catch(() => {});
            inserted++;
          }
        }

        // Auto-run customization extraction on all pending orders with new CSV mappings
        let orderResult = { totalUpdated: 0, scannedOrders: 0 };
        try {
          const amazonCustomService = require('../services/amazonCustomService');
          orderResult = await amazonCustomService.processAllPendingOrders(companyId);
        } catch (procErr) {
          console.error('[uploadCsv] Auto extraction error:', procErr.message);
        }

        const msg = orderResult.totalUpdated > 0
          ? `Imported ${inserted} new, updated ${updated} mappings. Extracted & updated ${orderResult.totalUpdated} order items!`
          : `Import complete: ${inserted} added, ${updated} updated.`;

        res.json({ 
          success: true, 
          message: msg,
          inserted,
          updated,
          updatedOrders: orderResult.totalUpdated,
          scannedOrders: orderResult.scannedOrders
        });
      });
  } catch (err) {
    next(err);
  }
}

function escapeCsvField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/\r\n|\r|\n/g, ' ').trim();
  return `"${str.replace(/"/g, '""')}"`;
}

async function exportCsv(req, res, next) {
  try {
    await ensureSchema();
    const where = {};
    if (req.user && req.user.companyId && req.user.role !== 'super_admin') {
      where.companyId = req.user.companyId;
    }

    const items = await CustomizationMapping.findAll({ where, order: [['id', 'ASC']] });

    const { Product, CustomSkuRule } = require('../models');
    const processedSkus = [...new Set(items.map(r => r.processedSku).filter(Boolean))];
    let products = [];
    try {
      products = await Product.findAll({
        where: { sku: processedSkus },
        attributes: ['sku', 'costPrice', 'price']
      });
    } catch (_) {}
    const productMap = new Map();
    for (const p of products) {
      if (p.sku) productMap.set(p.sku.trim().toLowerCase(), p);
    }

    let skuRules = [];
    try {
      skuRules = await CustomSkuRule.findAll({
        where: { companyId: req.user?.companyId || 1 }
      });
    } catch (_) {}
    const ruleMap = new Map();
    for (const r of skuRules) {
      if (r.sku) ruleMap.set(r.sku.trim().toLowerCase(), r.expectedCount);
    }

    // Deduplicate and filter out redundant PENDING_SKU records if a valid mapping exists
    const validPairs = new Set();
    for (const item of items) {
      if (item.processedSku && item.processedSku !== 'PENDING_SKU') {
        const pairKey = `${(item.asin || '').trim().toLowerCase()}||${(item.optionValue || '').trim().toLowerCase()}`;
        validPairs.add(pairKey);
      }
    }

    const seenExportKeys = new Set();
    let csvContent = 'sku,ASIN,optionValue,SKU,Pack Items,OUT of Stock,Extra,cost price\n';

    for (const item of items) {
      const asinClean = (item.asin || '').trim();
      const optClean = (item.optionValue || '').trim();
      const procClean = (item.processedSku || '').trim();
      const origClean = (item.originalSku || '').trim();
      const pairKey = `${asinClean.toLowerCase()}||${optClean.toLowerCase()}`;

      // Skip redundant pending placeholder if an active mapping exists
      if (procClean === 'PENDING_SKU' && validPairs.has(pairKey)) {
        continue;
      }

      // Avoid exact duplicates in export
      const dedupeKey = `${origClean.toLowerCase()}||${asinClean.toLowerCase()}||${optClean.toLowerCase()}||${procClean.toLowerCase()}`;
      if (seenExportKeys.has(dedupeKey)) {
        continue;
      }
      seenExportKeys.add(dedupeKey);

      // Resolve expectedCount dynamically
      let packCount = item.expectedCount != null ? item.expectedCount : item.expected_count;
      if (packCount == null) {
        const orig = origClean.toLowerCase();
        if (orig && ruleMap.has(orig)) {
          packCount = ruleMap.get(orig);
        } else if (origClean) {
          const match = origClean.match(/(?:^|[_-])(\d+)(?:[_-]|$)/);
          if (match) packCount = parseInt(match[1], 10);
        }
      }

      // Resolve costPrice dynamically
      let costPrice = item.costPrice != null ? item.costPrice : item.cost_price;
      if (costPrice == null || Number(costPrice) === 0) {
        const prod = procClean ? productMap.get(procClean.toLowerCase()) : null;
        if (prod) costPrice = prod.costPrice != null ? prod.costPrice : prod.price;
      }

      const row = [
        escapeCsvField(origClean),
        escapeCsvField(asinClean),
        escapeCsvField(optClean),
        escapeCsvField(procClean),
        packCount != null ? packCount : '',
        item.outOfStock ? 'TRUE' : 'FALSE',
        escapeCsvField(item.extra || ''),
        costPrice != null && !isNaN(costPrice) ? Number(costPrice).toFixed(2) : ''
      ].join(',');
      csvContent += row + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=customization_data.csv');
    res.status(200).send(csvContent);
  } catch (err) {
    next(err);
  }
}

async function bulkDelete(req, res, next) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No mapping IDs provided for deletion' });
    }
    const { Op } = require('sequelize');
    const where = { id: { [Op.in]: ids } };
    if (req.user && req.user.companyId && req.user.role !== 'super_admin') {
      where.companyId = req.user.companyId;
    }
    const count = await CustomizationMapping.destroy({ where });
    res.json({ success: true, message: `Successfully deleted ${count} mapping(s)`, count });
  } catch (err) {
    next(err);
  }
}

// ─── Custom SKU Pack Rules (Expected Counts) ──────────────────────────────────
async function listSkuRules(req, res, next) {
  try {
    const { CustomSkuRule } = require('../models');
    const companyId = req.user?.companyId || 1;
    // Auto sync table if not exists
    await CustomSkuRule.sync().catch(() => {});
    const rules = await CustomSkuRule.findAll({
      where: { companyId },
      order: [['sku', 'ASC']]
    });
    res.json({ success: true, data: rules });
  } catch (err) {
    next(err);
  }
}

async function saveSkuRule(req, res, next) {
  try {
    const { CustomSkuRule } = require('../models');
    const companyId = req.user?.companyId || 1;
    await CustomSkuRule.sync().catch(() => {});
    const { id, sku, expectedCount, description } = req.body;
    if (!sku || expectedCount === undefined || expectedCount === null) {
      return res.status(400).json({ success: false, message: 'SKU and expected item count are required' });
    }
    const cleanSku = String(sku).trim();
    const count = parseInt(expectedCount, 10);
    if (isNaN(count) || count <= 0) {
      return res.status(400).json({ success: false, message: 'Expected item count must be a positive integer' });
    }

    let rule = null;
    if (id) {
      rule = await CustomSkuRule.findOne({ where: { id, companyId } });
      if (rule) {
        await rule.update({
          sku: cleanSku,
          expectedCount: count,
          description: description || null
        });
      }
    }
    if (!rule) {
      const existing = await CustomSkuRule.findOne({ where: { companyId, sku: cleanSku } });
      if (existing) {
        await existing.update({
          expectedCount: count,
          description: description || null
        });
        rule = existing;
      } else {
        rule = await CustomSkuRule.create({
          companyId,
          sku: cleanSku,
          expectedCount: count,
          description: description || null
        });
      }
    }
    res.json({ success: true, data: rule, message: 'Pack rule saved successfully' });
  } catch (err) {
    next(err);
  }
}

async function deleteSkuRule(req, res, next) {
  try {
    const { CustomSkuRule } = require('../models');
    const companyId = req.user?.companyId || 1;
    const rule = await CustomSkuRule.findOne({ where: { id: req.params.id, companyId } });
    if (!rule) return res.status(404).json({ success: false, message: 'Rule not found' });
    await rule.destroy();
    res.json({ success: true, message: 'Pack rule deleted successfully' });
  } catch (err) {
    next(err);
  }
}

async function processAllOrders(req, res, next) {
  try {
    const companyId = req.user?.companyId || 1;
    const amazonCustomService = require('../services/amazonCustomService');
    const result = await amazonCustomService.processAllPendingOrders(companyId);
    res.json({
      success: true,
      message: result.totalUpdated > 0
        ? `Extraction complete! Updated ${result.totalUpdated} order item(s) to actual SKUs.`
        : `Extraction complete: All candidate orders are already up to date.`,
      data: result
    });
  } catch (err) {
    console.error('[processAllOrders Error]:', err);
    res.status(500).json({
      success: false,
      message: `Extraction failed: ${err.message}`
    });
  }
}

module.exports = {
  list,
  create,
  update,
  remove,
  bulkDelete,
  uploadCsv,
  exportCsv,
  listSkuRules,
  saveSkuRule,
  deleteSkuRule,
  processAllOrders
};


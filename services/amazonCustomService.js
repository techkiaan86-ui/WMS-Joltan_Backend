const axios = require('axios');
const zlib = require('zlib');
const { CustomizationMapping, SalesOrder, OrderItem, Product, ProductPool } = require('../models');
const { Op } = require('sequelize');

/**
 * Robust ZIP parser in native Node.js using Central Directory record traversal.
 * Handles standard ZIPs, streaming ZIPs with Data Descriptors (bit 3), and Amazon S3 seller central zips.
 */
function extractZipFiles(buffer) {
  const files = {};
  if (!buffer || buffer.length < 22) return files;

  // 1. First attempt: Find End of Central Directory (EOCD) signature: 0x06054b50 ("PK\x05\x06")
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    try {
      const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
      const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
      let offset = cdOffset;

      for (let i = 0; i < totalEntries && offset < buffer.length - 46; i++) {
        const sig = buffer.readUInt32LE(offset);
        if (sig !== 0x02014b50) break; // Central Directory File Header Signature

        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const fileNameLen = buffer.readUInt16LE(offset + 28);
        const extraLen = buffer.readUInt16LE(offset + 30);
        const commentLen = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);

        const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLen);
        offset += 46 + fileNameLen + extraLen + commentLen;

        // Read file data from local header
        if (localHeaderOffset + 30 <= buffer.length) {
          const localSig = buffer.readUInt32LE(localHeaderOffset);
          if (localSig === 0x04034b50) {
            const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
            const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
            const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

            if (dataOffset + compressedSize <= buffer.length) {
              const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
              let fileBuffer = null;

              if (compressionMethod === 0) {
                fileBuffer = compressedData;
              } else if (compressionMethod === 8) {
                try {
                  fileBuffer = zlib.inflateRawSync(compressedData);
                } catch (e) {
                  try {
                    fileBuffer = zlib.unzipSync(compressedData);
                  } catch (_) {}
                }
              }

              if (fileBuffer) {
                files[fileName] = fileBuffer;
              }
            }
          }
        }
      }

      if (Object.keys(files).length > 0) {
        return files;
      }
    } catch (cdErr) {
      console.warn('[ZIP Central Directory Parse Warning]:', cdErr.message);
    }
  }

  // 2. Fallback attempt: Traverse Local File Headers sequentially
  let offset = 0;
  while (offset < buffer.length - 30) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const fileNameOffset = offset + 30;
    const fileName = buffer.toString('utf8', fileNameOffset, fileNameOffset + fileNameLen);
    const dataOffset = fileNameOffset + fileNameLen + extraLen;

    if (compressedSize > 0 && dataOffset + compressedSize <= buffer.length) {
      const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
      let fileBuffer = null;

      if (compressionMethod === 0) {
        fileBuffer = compressedData;
      } else if (compressionMethod === 8) {
        try {
          fileBuffer = zlib.inflateRawSync(compressedData);
        } catch (_) {}
      }

      if (fileBuffer) {
        files[fileName] = fileBuffer;
      }
      offset = dataOffset + compressedSize;
    } else {
      offset += 1;
    }
  }

  return files;
}

function extractCustomizedUrl(source) {
  if (!source) return null;
  if (typeof source === 'object') {
    if (Array.isArray(source)) {
      for (const opt of source) {
        const val = String(opt?.value || opt?.customizationUrl || opt?.url || '');
        if (val.startsWith('http')) return val.trim();
      }
    } else {
      source = JSON.stringify(source);
    }
  }
  const str = String(source);
  const match = str.match(/https?:\/\/[^\s"',;]+(?:\.zip|[^\s"',;]*(?:custom|amazon|sellercentral)[^\s"',;]*)/i);
  if (match) return match[0].trim();
  if (str.includes('CustomizedURL:') || str.includes('customized-url')) {
    const splitMatch = str.match(/https?:\/\/[^\s"',;]+/i);
    if (splitMatch) return splitMatch[0].trim();
  }
  return null;
}

// In-memory cache for downloaded customization URL results to prevent duplicate network calls
const urlCache = new Map();

/**
 * Download and parse Amazon Customization ZIP or JSON URL.
 * Implements Zoltan's exact Python logic:
 *   - Downloads customized-url (with generous 15s timeout & in-memory cache)
 *   - Extracts JSON inside ZIP
 *   - Traverses version3.0 / version2.0 surfaces -> areas -> optionValue
 *   - Matches against ASIN + optionValue (and originalSku + optionValue) in CustomizationMapping
 *   - Returns array of matched product SKUs (ignoring 'DISP_No_thx')
 */
async function parseAmazonCustomizationZip(customizedUrl, originalSku = null, companyId = 1, preloadedMappings = null) {
  if (!customizedUrl || typeof customizedUrl !== 'string') return [];

  const cleanUrl = customizedUrl.trim();
  if (urlCache.has(cleanUrl)) {
    return urlCache.get(cleanUrl);
  }

  const matchedSkus = [];
  try {
    const response = await axios.get(cleanUrl, {
      responseType: 'arraybuffer',
      timeout: 15000, // 15s timeout: ample time for Amazon S3 presigned zip download
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const responseBuffer = Buffer.from(response.data);
    let extractedFiles = {};

    // Check if the response is directly JSON (or text)
    const previewStr = responseBuffer.slice(0, 10).toString('utf8').trim();
    if (previewStr.startsWith('{') || previewStr.startsWith('[')) {
      extractedFiles['customization.json'] = responseBuffer;
    } else {
      extractedFiles = extractZipFiles(responseBuffer);
    }

    // Preload mappings if not already provided
    const compId = companyId || 1;
    let allMappings = preloadedMappings;
    if (!allMappings) {
      allMappings = await CustomizationMapping.findAll({ where: { companyId: compId } });
    }

    for (const [fileName, fileBuffer] of Object.entries(extractedFiles)) {
      if (!fileName.toLowerCase().endsWith('.json')) {
        continue;
      }

      let data;
      try {
        data = JSON.parse(fileBuffer.toString('utf8'));
      } catch (e) {
        continue;
      }

      // 1. Read product ASIN
      const asin = String(data.asin || data.ASIN || data.asinId || '').trim();

      // 2. Navigate to selected customization options (Zoltan's exact Python traversal)
      const customizationInfo = data.customizationInfo || {};
      const version = customizationInfo['version3.0'] || customizationInfo['version2.0'] || customizationInfo['version1.0'] || customizationInfo || {};
      const surfaces = version.surfaces || data.surfaces || [];

      const optionValues = [];

      for (const surface of surfaces) {
        const areas = surface.areas || [];
        for (const area of areas) {
          if (area.customizationType === 'Options' || area.optionValue || area.optionName) {
            const optVal = area.optionValue || area.optionName || area.value || area.label || area.text;
            if (optVal) {
              optionValues.push(String(optVal).trim());
            }
          }
        }
      }

      if (optionValues.length === 0 && (version.customizationData || data.customizationData)) {
        const cData = version.customizationData || data.customizationData;
        const children = cData.children || [];
        for (const ch of children) {
          const opt = ch.optionValue || ch.optionName || ch.inputValue || ch.value;
          if (opt) optionValues.push(String(opt).trim());
        }
      }

      // 3. Match each selected option in-memory
      for (const optionValue of optionValues) {
        if (!optionValue || optionValue === 'DISP_No_thx') continue;

        const optClean = String(optionValue).trim().toLowerCase();
        const asinClean = String(asin).trim().toLowerCase();
        const origClean = String(originalSku || '').trim().toLowerCase();

        // Match priority:
        // 1. ASIN + optionValue (Zoltan Python primary)
        // 2. originalSku + optionValue
        // 3. optionValue alone
        let mapping = allMappings.find(m => {
          const mOpt = String(m.optionValue || '').trim().toLowerCase();
          const mAsin = String(m.asin || '').trim().toLowerCase();
          const mOrig = String(m.originalSku || '').trim().toLowerCase();

          return (
            (asinClean && mAsin === asinClean && mOpt === optClean) ||
            (origClean && mOrig === origClean && mOpt === optClean) ||
            (mOpt === optClean)
          );
        });

        // If not found in DB, auto-capture mapping entry asynchronously
        if (!mapping) {
          try {
            CustomizationMapping.create({
              companyId: compId,
              originalSku: originalSku || null,
              asin: asin || null,
              optionValue,
              processedSku: 'PENDING_SKU',
              outOfStock: false,
              extra: `Auto-captured from Order (Original: ${originalSku || 'N/A'})`
            }).then(newMap => {
              allMappings.push(newMap);
            }).catch(() => {});
          } catch (e) {}
        }

        if (mapping && mapping.processedSku && mapping.processedSku !== 'PENDING_SKU') {
          const sku = mapping.processedSku.trim();
          if (sku && sku !== 'DISP_No_thx') {
            matchedSkus.push({
              asin,
              optionValue,
              processedSku: sku,
              outOfStock: mapping.outOfStock,
              costPrice: mapping.costPrice
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Amazon Custom ZIP Parse Warning]: ${err.message}`);
  }

  // Cache result in memory (limit cache size to 500)
  if (urlCache.size > 500) urlCache.clear();
  urlCache.set(cleanUrl, matchedSkus);

  return matchedSkus;
}

/**
 * Process Amazon Order Customizations for a single SalesOrder.
 * Replaces parent/placeholder SKUs (e.g. SF_3, NA_M_12) with the actual resolved product SKU (e.g. ABC-12345).
 */
async function processOrderCustomizations(salesOrderIdOrOrder, preloadedMappings = null) {
  let order = null;
  if (typeof salesOrderIdOrOrder === 'object' && salesOrderIdOrOrder !== null && salesOrderIdOrOrder.OrderItems) {
    order = salesOrderIdOrOrder;
  } else {
    order = await SalesOrder.findByPk(salesOrderIdOrOrder, {
      include: [{ association: 'OrderItems', include: ['Product'] }]
    });
  }

  if (!order || !order.OrderItems || order.OrderItems.length === 0) return { updatedCount: 0 };

  let updatedCount = 0;
  const compId = order.companyId || 1;

  // Preload mappings once if not provided
  let allMappings = preloadedMappings;
  if (!allMappings) {
    allMappings = await CustomizationMapping.findAll({ where: { companyId: compId } });
  }

  for (const item of order.OrderItems) {
    const rawSku = (item.originalSku || (item.Product ? item.Product.sku : item.sku) || '').trim();

    // Detect customized URL comprehensively across all possible fields
    let customUrl = item.customizedUrl || null;
    if (!customUrl) {
      customUrl = extractCustomizedUrl(item.customizedUrl) ||
                  extractCustomizedUrl(order.notes) ||
                  extractCustomizedUrl(order.internalNotes) ||
                  extractCustomizedUrl(order.notesFromBuyer) ||
                  extractCustomizedUrl(order.customerNotes) ||
                  extractCustomizedUrl(order.externalRef) ||
                  extractCustomizedUrl(order.customField2) ||
                  extractCustomizedUrl(order.customField3) ||
                  extractCustomizedUrl(order.giftNote);
    }

    // Parse ZIP / Custom data using Zoltan's Python logic
    let matches = [];
    if (customUrl) {
      matches = await parseAmazonCustomizationZip(customUrl, rawSku, compId, allMappings);
    }

    // Direct mapping fallback by originalSku (e.g. SF_3, NA_M_12) if URL download wasn't needed or available
    if ((!matches || matches.length === 0) && rawSku) {
      const cleanRaw = rawSku.toLowerCase();
      const directMatch = allMappings.find(m => 
        String(m.originalSku || '').trim().toLowerCase() === cleanRaw &&
        m.processedSku && 
        m.processedSku !== 'PENDING_SKU'
      );
      if (directMatch) {
        matches = [{
          asin: directMatch.asin,
          optionValue: directMatch.optionValue,
          processedSku: directMatch.processedSku.trim()
        }];
      }
    }

    if (matches && matches.length > 0) {
      const firstMatch = matches[0];
      const newSku = firstMatch.processedSku;

      if (!newSku || newSku === 'DISP_No_thx' || newSku === rawSku) continue;

      // 1. Find or create the target Product with the actual SKU
      let targetProduct = await Product.findOne({ where: { sku: newSku, companyId: compId } });
      if (!targetProduct) {
        targetProduct = await Product.findOne({ where: { sku: newSku } });
      }
      if (!targetProduct) {
        try {
          targetProduct = await Product.create({
            companyId: compId,
            name: `${newSku} (Custom Product)`,
            sku: newSku,
            barcode: newSku,
            price: item.unitPrice || 0,
            status: 'ACTIVE',
            productType: 'SINGLE',
            description: `Extracted from Amazon Customization for Order #${order.orderNumber}`
          });
        } catch (pErr) {
          // Ignore if created concurrently
        }
      }

      // 2. Update OrderItem with actual product SKU
      await item.update({
        originalSku: newSku, // Now updated to actual SKU!
        customizedUrl: customUrl || item.customizedUrl,
        productId: targetProduct ? targetProduct.id : item.productId,
        batchNumber: firstMatch.optionValue || item.batchNumber
      });

      // 3. Remove raw parent SKU (e.g. SF_3, NA_M_12) from ProductPool
      ProductPool.destroy({
        where: {
          sku: [rawSku, 'SF_3', 'NA_M_12'].filter(Boolean),
          companyId: compId
        }
      }).catch(() => {});

      // 4. Update order internal notes: remove unmatched SKU warning
      if (order.internalNotes && order.internalNotes.includes(`Unmatched SKU "${rawSku}"`)) {
        try {
          const cleanedNotes = order.internalNotes
            .replace(new RegExp(`\\[WARNING: Unmatched SKU "${rawSku}"[^\\]]*\\]\\s*\\|?\\s*`, 'g'), '')
            .trim();
          order.update({ internalNotes: cleanedNotes }).catch(() => {});
        } catch (noteErr) {}
      }

      updatedCount++;
    }
  }

  return { updatedCount };
}

/**
 * Process all existing orders that have unextracted parent SKUs (e.g. SF_3, NA_M_12) or customized URLs.
 * High Performance Implementation:
 *   - Preloads CustomizationMapping into memory
 *   - Only queries orders having candidate parent SKUs or customized URLs (skipping hundreds of irrelevant orders)
 *   - Executes in fast parallel chunks with Promise.all
 */
async function ensureCustomizationSchema() {
  try {
    await CustomizationMapping.sync();
  } catch (_) {}
  try {
    const { sequelize } = require('../config/db');
    await sequelize.query("ALTER TABLE order_items ADD COLUMN original_sku VARCHAR(255) NULL").catch(() => {});
    await sequelize.query("ALTER TABLE order_items ADD COLUMN customized_url TEXT NULL").catch(() => {});
  } catch (_) {}
}

async function processAllPendingOrders(companyId) {
  const compId = companyId || 1;

  // Auto-heal schema if running before complete server sync
  await ensureCustomizationSchema();

  // 1. Preload all mappings in 1 query
  let allMappings = [];
  try {
    allMappings = await CustomizationMapping.findAll({
      where: { companyId: compId }
    });
  } catch (mErr) {
    console.warn('[processAllPendingOrders] CustomizationMapping fetch warning:', mErr.message);
  }

  const parentSkuSet = new Set(
    allMappings
      .map(m => m.originalSku)
      .filter(Boolean)
      .concat(['SF_3', 'NA_M_12'])
  );

  const targetOrderIdsSet = new Set();

  // 2. Find candidate order items that need resolution
  try {
    const parentSkus = Array.from(parentSkuSet);
    const candidateItems = await OrderItem.findAll({
      where: {
        [Op.or]: [
          { customizedUrl: { [Op.ne]: null } },
          { originalSku: { [Op.in]: parentSkus } },
          { originalSku: { [Op.like]: 'SF_%' } },
          { originalSku: { [Op.like]: 'NA_%' } },
          { originalSku: 'SF_3' },
          { originalSku: 'NA_M_12' }
        ]
      },
      attributes: ['salesOrderId'],
      limit: 500
    });
    candidateItems.forEach(i => i.salesOrderId && targetOrderIdsSet.add(i.salesOrderId));
  } catch (itemErr) {
    console.warn('[processAllPendingOrders] candidateItems query warning:', itemErr.message);
  }

  // Also find items linked to products with parent SKUs (e.g. SF_3, NA_M_12)
  try {
    const parentProducts = await Product.findAll({
      where: {
        sku: { [Op.in]: ['SF_3', 'NA_M_12', ...Array.from(parentSkuSet)] }
      },
      attributes: ['id']
    });

    if (parentProducts.length > 0) {
      const pItems = await OrderItem.findAll({
        where: {
          productId: { [Op.in]: parentProducts.map(p => p.id) }
        },
        attributes: ['salesOrderId'],
        limit: 500
      });
      pItems.forEach(i => i.salesOrderId && targetOrderIdsSet.add(i.salesOrderId));
    }
  } catch (prodErr) {
    console.warn('[processAllPendingOrders] parentProducts query warning:', prodErr.message);
  }

  // 3. Find candidate orders with warning or customizedURL / links in notes
  try {
    const candidateNoteOrders = await SalesOrder.findAll({
      where: {
        companyId: compId,
        [Op.or]: [
          { notes: { [Op.like]: '%http%' } },
          { internalNotes: { [Op.like]: '%http%' } },
          { notesFromBuyer: { [Op.like]: '%http%' } },
          { notes: { [Op.like]: '%SF_%' } },
          { internalNotes: { [Op.like]: '%SF_%' } },
          { internalNotes: { [Op.like]: '%NA_%' } },
          { internalNotes: { [Op.like]: '%Unmatched SKU%' } }
        ]
      },
      attributes: ['id'],
      limit: 200
    });
    candidateNoteOrders.forEach(o => o.id && targetOrderIdsSet.add(o.id));
  } catch (orderErr) {
    console.warn('[processAllPendingOrders] candidateNoteOrders query warning:', orderErr.message);
  }

  const targetOrderIds = Array.from(targetOrderIdsSet);

  // If no candidate orders found, return instantly (< 5ms)
  if (targetOrderIds.length === 0) {
    return { totalUpdated: 0, scannedOrders: 0 };
  }

  // 4. Load full records ONLY for candidate orders
  const orders = await SalesOrder.findAll({
    where: {
      id: { [Op.in]: targetOrderIds },
      companyId: compId
    },
    include: [{ association: 'OrderItems', include: ['Product'] }]
  });

  let totalUpdated = 0;
  // Process in parallel chunks of 5
  const CHUNK_SIZE = 5;
  for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
    const chunk = orders.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(o => processOrderCustomizations(o, allMappings))
    );
    for (const res of chunkResults) {
      if (res?.updatedCount > 0) {
        totalUpdated += res.updatedCount;
      }
    }
  }

  return { totalUpdated, scannedOrders: orders.length };
}

module.exports = {
  extractZipFiles,
  parseAmazonCustomizationZip,
  processOrderCustomizations,
  processAllPendingOrders
};


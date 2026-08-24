const fs = require('fs');
const path = require('path');
const { sequelize, Customer, Product, SalesOrder, OrderItem, IntegrationConfig } = require('../models');

async function runAuditAndCleanup() {
  console.log('====================================================');
  console.log('--- WMS CLIENT VS CUSTOMER & PRODUCT OWNER CLEANUP ---');
  console.log('====================================================\n');

  try {
    // 1. Ensure DB schema includes is_client column
    console.log('[1/5] Ensuring Database Schema Migration for Customer.is_client...');
    await sequelize.sync({ alter: true });
    console.log('--> DB Schema updated successfully!\n');

    // 2. Identify 3PL Clients vs End Customers
    console.log('[2/5] Categorizing Customer Records into 3PL Clients vs End-Customers...');
    
    // Find all clientIds currently referenced in Products
    const products = await Product.findAll({ attributes: ['id', 'sku', 'name', 'clientId'] });
    const productClientIds = new Set(
      products.map(p => p.clientId).filter(id => id !== null && id !== undefined)
    );

    // Find all customers
    const allCustomers = await Customer.findAll();
    console.log(`Total records in 'customers' table: ${allCustomers.length}`);

    let clientsMarkedCount = 0;
    let customersMarkedCount = 0;

    for (const cust of allCustomers) {
      const name = (cust.name || '').trim();
      const code = (cust.code || '').trim();
      const hasProductLink = productClientIds.has(cust.id);
      const hasClientAttributes = Boolean(
        cust.header_image_url ||
        cust.packing_slip_footer ||
        cust.tier ||
        cust.segment ||
        cust.code ||
        cust.creditLimit > 0 ||
        cust.type === 'B2B'
      );

      // Determine if record is a 3PL Client
      let isClient = false;
      if (hasProductLink || hasClientAttributes) {
        isClient = true;
      } else if (!name.toLowerCase().includes('customer') && name.length < 30 && !name.includes('@')) {
        // Check if created without shipping address lines (manual client entry)
        if (!cust.address || cust.address.length < 5) {
          isClient = true;
        }
      }

      await cust.update({ isClient });
      if (isClient) {
        clientsMarkedCount++;
        console.log(`  [3PL Client Identified] ID: ${cust.id} | Name: "${cust.name}" | Code: ${cust.code || 'N/A'}`);
      } else {
        customersMarkedCount++;
      }
    }

    console.log(`\n--> Identified & Flagged ${clientsMarkedCount} 3PL Clients and ${customersMarkedCount} End-Consumer Customers.\n`);

    // 3. Product Client Owner Audit
    console.log('[3/5] Auditing Product Client Owners...');
    const mappedProducts = products.filter(p => p.clientId !== null);
    const unmappedProducts = products.filter(p => p.clientId === null);

    console.log(`Products WITH Client Owner: ${mappedProducts.length}`);
    console.log(`Products WITHOUT Client Owner: ${unmappedProducts.length}\n`);

    // 4. Auto-map products based on Sales Orders & Store Mappings
    console.log('[4/5] Inferring Client Owners for Unmapped Products via Sales Order History...');
    let autoMappedProductCount = 0;

    // Fetch all active 3PL clients for reference
    const active3PLClients = await Customer.findAll({ where: { isClient: true } });
    const clientMap = new Map(active3PLClients.map(c => [c.id, c]));

    // If there is only 1 primary 3PL client, or if order items link to a specific client
    for (const prod of unmappedProducts) {
      // Check if product was purchased in orders with clear client association
      const orderItems = await OrderItem.findAll({
        where: { productId: prod.id },
        include: [{ model: SalesOrder, as: 'SalesOrder' }]
      });

      const clientCandidateCounts = {};
      for (const item of orderItems) {
        const order = item.SalesOrder;
        if (order) {
          // If order has store mapping or customer reference
          const candidateClientId = order.clientId || (clientMap.has(order.customerId) ? order.customerId : null);
          if (candidateClientId) {
            clientCandidateCounts[candidateClientId] = (clientCandidateCounts[candidateClientId] || 0) + 1;
          }
        }
      }

      const candidateIds = Object.keys(clientCandidateCounts);
      if (candidateIds.length === 1) {
        const targetClientId = parseInt(candidateIds[0], 10);
        await prod.update({ clientId: targetClientId });
        autoMappedProductCount++;
        console.log(`  [Product Mapped] SKU: ${prod.sku} ("${prod.name}") --> Assigned Client ID: ${targetClientId}`);
      } else if (active3PLClients.length === 1) {
        // Single 3PL Client in system, assign automatically
        const targetClientId = active3PLClients[0].id;
        await prod.update({ clientId: targetClientId });
        autoMappedProductCount++;
        console.log(`  [Single Client Auto-Map] SKU: ${prod.sku} --> Assigned Client ID: ${targetClientId} (${active3PLClients[0].name})`);
      }
    }

    console.log(`\n--> Auto-mapped ${autoMappedProductCount} unmapped products to their respective 3PL Clients.\n`);

    // 5. Final Report Summary
    console.log('[5/5] Generating Summary Report...');
    const finalProductsWithClient = await Product.count({ where: { clientId: { [sequelize.Sequelize.Op.ne]: null } } });
    const finalProductsWithoutClient = await Product.count({ where: { clientId: null } });

    const summaryReport = {
      timestamp: new Date().toISOString(),
      customersTotal: allCustomers.length,
      clientsIdentified: clientsMarkedCount,
      endCustomersIdentified: customersMarkedCount,
      productsTotal: products.length,
      productsWithClientOwnerBefore: mappedProducts.length,
      productsWithClientOwnerAfter: finalProductsWithClient,
      productsWithoutClientOwnerAfter: finalProductsWithoutClient,
      autoMappedProductsCount: autoMappedProductCount,
      active3PLClientsList: active3PLClients.map(c => ({ id: c.id, name: c.name, code: c.code }))
    };

    const reportPath = path.join(__dirname, '../cleanup_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(summaryReport, null, 2));
    console.log(`Summary Report saved to ${reportPath}`);
    console.log('\nCLEANUP & AUDIT COMPLETED SUCCESSFULLY!');

  } catch (err) {
    console.error('Audit Error:', err);
  } finally {
    await sequelize.close();
  }
}

runAuditAndCleanup();

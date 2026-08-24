const fs = require('fs');
const path = require('path');
const { sequelize, Customer, Product, SalesOrder, IntegrationConfig } = require('../models');

async function backupDatabase() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, `backup_${timestamp}`);

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  console.log(`[Backup] Starting full backup to ${backupDir}...`);

  try {
    const customers = await Customer.findAll({ raw: true });
    fs.writeFileSync(path.join(backupDir, 'customers.json'), JSON.stringify(customers, null, 2));
    console.log(`[Backup] Saved ${customers.length} customers`);

    const products = await Product.findAll({ raw: true });
    fs.writeFileSync(path.join(backupDir, 'products.json'), JSON.stringify(products, null, 2));
    console.log(`[Backup] Saved ${products.length} products`);

    const salesOrders = await SalesOrder.findAll({ raw: true });
    fs.writeFileSync(path.join(backupDir, 'sales_orders.json'), JSON.stringify(salesOrders, null, 2));
    console.log(`[Backup] Saved ${salesOrders.length} sales orders`);

    const configs = await IntegrationConfig.findAll({ raw: true });
    fs.writeFileSync(path.join(backupDir, 'integration_configs.json'), JSON.stringify(configs, null, 2));
    console.log(`[Backup] Saved ${configs.length} integration configs`);

    console.log(`[Backup] Backup completed successfully in ${backupDir}`);
  } catch (err) {
    console.error('[Backup Error]:', err);
  } finally {
    await sequelize.close();
  }
}

backupDatabase();

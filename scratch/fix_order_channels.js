const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { sequelize } = require('../config/db');

async function run() {
  try {
    console.log('Connecting to database...');
    await sequelize.authenticate();
    console.log('Connected.');

    // 1. Temu backfill (PO- or TEMU-)
    const [resTemu] = await sequelize.query(`
      UPDATE sales_orders 
      SET sales_channel = 'ShipStation (Temu)', marketplace = 'Temu' 
      WHERE order_number LIKE 'PO%' OR order_number LIKE 'TEMU%';
    `);
    console.log(`Updated Temu orders: ${resTemu.affectedRows || resTemu.changedRows || 0}`);

    // 2. Shopify Wholesale backfill (FW-)
    const [resWholesale] = await sequelize.query(`
      UPDATE sales_orders 
      SET sales_channel = 'ShipStation (Shopify Wholesale)', marketplace = 'Shopify Wholesale' 
      WHERE order_number LIKE 'FW%';
    `);
    console.log(`Updated Shopify Wholesale orders: ${resWholesale.affectedRows || resWholesale.changedRows || 0}`);

    // 3. Shopify Retail backfill (F- or SHPF- or SHOPIFY-)
    const [resShopify] = await sequelize.query(`
      UPDATE sales_orders 
      SET sales_channel = 'ShipStation (Shopify)', marketplace = 'Shopify' 
      WHERE (order_number LIKE 'F%' OR order_number LIKE 'SHPF%' OR order_number LIKE 'SHOPIFY%')
        AND order_number NOT LIKE 'FW%';
    `);
    console.log(`Updated Shopify Retail orders: ${resShopify.affectedRows || resShopify.changedRows || 0}`);

    // Check samples
    const [samples] = await sequelize.query(`
      SELECT id, order_number, sales_channel, marketplace 
      FROM sales_orders 
      WHERE order_number LIKE 'PO%' OR order_number LIKE 'F%' 
      LIMIT 10;
    `);
    console.log('Sample updated rows:', samples);

    process.exit(0);
  } catch (e) {
    console.error('Error running fix:', e);
    process.exit(1);
  }
}

run();

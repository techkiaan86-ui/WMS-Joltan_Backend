require('dotenv').config();
const { sequelize, SalesOrder, OrderItem, Product, ProductPool } = require('./models');

async function check() {
  try {
    await sequelize.authenticate();
    console.log('[DB] Connected successfully to database.');

    const soCount = await SalesOrder.count();
    const oiCount = await OrderItem.count();
    const prodCount = await Product.count();
    const poolCount = await ProductPool.count();

    console.log('--- WMS Current Status ---');
    console.log('Total Sales Orders:', soCount);
    console.log('Total Order Items:', oiCount);
    console.log('Total Products in Catalog:', prodCount);
    console.log('Total Items in Product Pool:', poolCount);

    const poolItems = await ProductPool.findAll({ limit: 10, order: [['id', 'DESC']] });
    console.log('\nLast Product Pool Items:');
    for (const p of poolItems) {
      console.log(`- SKU: ${p.sku}, Name: ${p.name}, Status: ${p.status}, Order: ${p.orderNumber}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error during database check:', err.message);
    process.exit(1);
  }
}

check();

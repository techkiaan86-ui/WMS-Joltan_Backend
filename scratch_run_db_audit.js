const { SalesOrder, Customer, sequelize } = require('./models');
const { Op } = require('sequelize');

(async () => {
  try {
    const startDate = '2026-08-18';
    const endDate = '2026-08-24';

    const orders = await SalesOrder.findAll({
      where: {
        [Op.or]: [
          { orderDate: { [Op.gte]: startDate, [Op.lte]: endDate } },
          { createdAt: { [Op.gte]: `${startDate} 00:00:00`, [Op.lte]: `${endDate} 23:59:59` } }
        ]
      },
      order: [['orderDate', 'DESC'], ['createdAt', 'DESC']]
    });

    const totalAllInDb = await SalesOrder.count();
    console.log(`=== AUDIT SUMMARY ===`);
    console.log(`Total Orders in DB (All Dates): ${totalAllInDb}`);
    console.log(`Orders in Range (18 Aug 2026 - 24 Aug 2026): ${orders.length}`);

    const grouped = {};
    orders.forEach(o => {
      const d = o.orderDate ? String(o.orderDate).split('T')[0] : String(o.createdAt).split('T')[0];
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(o);
    });

    for (const d of Object.keys(grouped).sort().reverse()) {
      console.log(`\nDate: ${d} | Count: ${grouped[d].length}`);
      grouped[d].forEach((o, i) => {
        console.log(`  ${i+1}. Order#: ${o.orderNumber} | Customer: ${o.recipientName} | Status: ${o.status} | Total: £${o.totalAmount} | Channel: ${o.salesChannel || o.marketplace}`);
      });
    }

    if (totalAllInDb > 0 && orders.length === 0) {
      console.log('\nSample Latest 10 Orders in Database:');
      const latest = await SalesOrder.findAll({ order: [['id', 'DESC']], limit: 10 });
      latest.forEach((o, i) => {
        console.log(`  ${i+1}. Order#: ${o.orderNumber} | Date: ${o.orderDate} | Status: ${o.status} | Customer: ${o.recipientName}`);
      });
    }
  } catch (err) {
    console.error('Audit Error:', err.message);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
})();

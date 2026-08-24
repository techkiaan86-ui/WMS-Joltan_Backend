const { SalesOrder, Customer, Product, OrderItem, sequelize } = require('./models');
const { Op } = require('sequelize');

(async () => {
  try {
    console.log('========================================================================');
    console.log('AUDITING WMS DATABASE SALES ORDERS FROM 18-AUG-2026 TO 24-AUG-2026');
    console.log('========================================================================\n');

    const startDate = '2026-08-18';
    const endDate = '2026-08-24';

    const orders = await SalesOrder.findAll({
      where: {
        [Op.or]: [
          { orderDate: { [Op.gte]: startDate, [Op.lte]: endDate } },
          { createdAt: { [Op.gte]: `${startDate} 00:00:00`, [Op.lte]: `${endDate} 23:59:59` } }
        ]
      },
      include: [
        { model: Customer, as: 'Customer', attributes: ['name', 'email'] }
      ],
      order: [['orderDate', 'DESC'], ['createdAt', 'DESC']]
    });

    console.log(`TOTAL ORDERS FOUND IN RANGE (18 Aug 2026 - 24 Aug 2026): ${orders.length}\n`);

    if (orders.length === 0) {
      console.log('No orders currently found in DB for date range 18-Aug-2026 to 24-Aug-2026.');
      
      // Let's also check ALL orders in DB regardless of date
      const totalAll = await SalesOrder.count();
      console.log(`\nTotal orders in entire database (all dates): ${totalAll}`);

      const latest10 = await SalesOrder.findAll({
        order: [['createdAt', 'DESC']],
        limit: 10
      });
      console.log('\nTop 10 Latest Orders in Database across all dates:');
      latest10.forEach((o, idx) => {
        console.log(`  [${idx+1}] Order#: ${o.orderNumber} | Date: ${o.orderDate} | Status: ${o.status} | Recipient: ${o.recipientName} | CreatedAt: ${o.createdAt}`);
      });
    } else {
      // Group by date
      const grouped = {};
      orders.forEach(o => {
        const d = o.orderDate ? String(o.orderDate).split('T')[0] : String(o.createdAt).split('T')[0];
        if (!grouped[d]) grouped[d] = [];
        grouped[d].push(o);
      });

      for (const d of Object.keys(grouped).sort().reverse()) {
        console.log(`\n📅 DATE: ${d} (${grouped[d].length} orders)`);
        console.log('------------------------------------------------------------------------');
        grouped[d].forEach((o, i) => {
          console.log(`  [${i+1}] Order #: ${o.orderNumber} | Customer: ${o.recipientName || o.Customer?.name || 'N/A'} | Status: ${o.status} | Total: £${o.totalAmount} | Channel: ${o.salesChannel || o.marketplace}`);
        });
      }
    }

  } catch (err) {
    console.error('Audit Error:', err.message);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
})();

const { SalesOrder, Company } = require('./models');

(async () => {
  try {
    const totalCount = await SalesOrder.count();
    console.log('====================================================');
    console.log(`TOTAL SALES ORDERS IN DB: ${totalCount}`);
    console.log('====================================================');

    const orders = await SalesOrder.findAll({
      order: [['id', 'DESC']],
      limit: 20
    });

    orders.forEach((o, i) => {
      console.log(`[${i+1}] ID: ${o.id} | Order#: ${o.orderNumber} | CompanyID: ${o.companyId} | OrderDate: ${o.orderDate} | Status: ${o.status} | CreatedAt: ${o.createdAt}`);
    });

    const companies = await Company.findAll();
    console.log('\n--- COMPANIES IN DB ---');
    companies.forEach(c => console.log(`Company ID: ${c.id} | Name: ${c.name}`));

  } catch (err) {
    console.error('Error inspecting DB:', err.message);
  } finally {
    process.exit(0);
  }
})();

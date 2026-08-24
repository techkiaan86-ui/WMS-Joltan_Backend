const { sequelize, Customer, Product, SalesOrder, IntegrationConfig } = require('./models');

(async () => {
  try {
    console.log('=== DATABASE INSPECTION REPORT ===\n');

    // 1. Customers count & samples
    const totalCustomers = await Customer.count();
    console.log(`Total records in 'customers' table: ${totalCustomers}`);

    const customerTypes = await Customer.findAll({
      attributes: ['type', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['type'],
      raw: true
    });
    console.log('Customer count by type:', customerTypes);

    const sampleCustomers = await Customer.findAll({
      limit: 15,
      order: [['id', 'DESC']],
      attributes: ['id', 'name', 'code', 'type', 'email', 'phone', 'city', 'country', 'createdAt']
    });
    console.log('\nSample Customers (latest 15):', JSON.stringify(sampleCustomers, null, 2));

    // 2. Products count & client mapping status
    const totalProducts = await Product.count();
    const productsWithClient = await Product.count({ where: { clientId: { [sequelize.Sequelize.Op.ne]: null } } });
    const productsWithoutClient = await Product.count({ where: { clientId: null } });

    console.log(`\nTotal Products: ${totalProducts}`);
    console.log(`Products WITH Client Owner (clientId != null): ${productsWithClient}`);
    console.log(`Products WITHOUT Client Owner (clientId == null): ${productsWithoutClient}`);

    const productSamplesWithClient = await Product.findAll({
      where: { clientId: { [sequelize.Sequelize.Op.ne]: null } },
      limit: 5,
      attributes: ['id', 'sku', 'name', 'clientId']
    });
    console.log('\nSample Products WITH Client:', JSON.stringify(productSamplesWithClient, null, 2));

    const productSamplesWithoutClient = await Product.findAll({
      where: { clientId: null },
      limit: 10,
      attributes: ['id', 'sku', 'name', 'categoryId', 'marketplaceSkus', 'createdAt']
    });
    console.log('\nSample Products WITHOUT Client:', JSON.stringify(productSamplesWithoutClient, null, 2));

    // 3. SalesOrders client vs customer mapping
    const totalOrders = await SalesOrder.count();
    console.log(`\nTotal Sales Orders: ${totalOrders}`);

    const sampleOrders = await SalesOrder.findAll({
      limit: 5,
      order: [['id', 'DESC']],
      attributes: ['id', 'orderNumber', 'customerId', 'salesChannel', 'recipientName', 'shipstationStoreId', 'shipstationOrderId']
    });
    console.log('\nSample Sales Orders:', JSON.stringify(sampleOrders, null, 2));

    // 4. Check IntegrationConfigs for ShipStation store mappings
    const configs = await IntegrationConfig.findAll({ where: { platform: 'SHIPSTATION' } });
    console.log('\nShipStation Configs count:', configs.length);
    configs.forEach(c => {
      console.log('Config ID:', c.id, 'CompanyId:', c.companyId, 'Credentials:', JSON.stringify(c.credentials));
    });

  } catch (err) {
    console.error('Inspection Error:', err);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
})();

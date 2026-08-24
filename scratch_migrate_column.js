const { sequelize, Customer } = require('./models');

(async () => {
  try {
    console.log('[Migration] Checking and adding is_client column...');
    const isMysql = sequelize.getDialect() === 'mysql';
    const addColSql = isMysql
      ? 'ALTER TABLE `customers` ADD COLUMN `is_client` TINYINT(1) DEFAULT 0'
      : 'ALTER TABLE customers ADD COLUMN is_client INTEGER DEFAULT 0';
    
    try {
      await sequelize.query(addColSql);
      console.log('[Migration Success] Column is_client added to customers table.');
    } catch (e) {
      console.log('[Migration Note] Column add result:', e.message);
    }

    // Run classification
    const allCustomers = await Customer.findAll();
    let clientsCount = 0;
    for (const cust of allCustomers) {
      const isClient = Boolean(
        cust.header_image_url ||
        cust.packing_slip_footer ||
        cust.tier ||
        cust.segment ||
        cust.code ||
        cust.creditLimit > 0 ||
        cust.type === 'B2B' ||
        [6, 7, 8, 9].includes(cust.id)
      );
      await cust.update({ isClient });
      if (isClient) clientsCount++;
    }
    console.log(`[Migration Result] Total Customers: ${allCustomers.length} | 3PL Clients: ${clientsCount}`);

  } catch (err) {
    console.error('[Migration Error]:', err.message);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
})();

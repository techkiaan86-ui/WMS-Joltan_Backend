require('dotenv').config();
const { sequelize } = require('./config/db');

/**
 * Cleanup Database Script
 * Safely removes all operational, testing, product, and order data
 * while strictly PRESERVING:
 *  - users table (all user accounts, logins, and passwords intact)
 *  - companies table (maintains company structure linked to users)
 *  - base warehouses, zones, and locations (maintains warehouse structure)
 *
 * Usage:
 *   node cleanup_db.js
 *   npm run db:clean
 */

async function cleanupDatabase() {
  console.log('\n======================================================');
  console.log('       WMS DATABASE CLEANUP & RESET UTILITY           ');
  console.log('======================================================');
  console.log(`Connecting to database (${process.env.DB_DIALECT || 'mysql'})...`);

  try {
    await sequelize.authenticate();
    const dialect = sequelize.getDialect();
    console.log(`[DB] Connected successfully (${dialect.toUpperCase()}).\n`);

    // Tables strictly preserved
    const PRESERVED_TABLES = ['users', 'companies', 'warehouses', 'zones', 'locations', 'courier_mappings', 'despatch_note_templates', 'integration_configs'];

    // All company, operational, testing, and transactional tables to wipe clean
    const TABLES_TO_CLEAN = [
      'order_items',
      'sales_orders',
      'pick_list_items',
      'pick_lists',
      'packing_tasks',
      'shipments',
      'returns',
      'purchase_order_items',
      'purchase_orders',
      'goods_receipt_items',
      'goods_receipts',
      'batches',
      'inventory_adjustments',
      'inventory_logs',
      'inventories',
      'product_stocks',
      'movements',
      'cycle_counts',
      'replenishment_tasks',
      'replenishment_configs',
      'reports',
      'supplier_products',
      'audit_logs',
      'product_pool',
      'bundle_items',
      'bundles',
      'products',
      'customization_mappings',
      'integration_logs',
      'saved_addresses',
      'end_customers',
      'production_orders',
      'production_order_items',
      'production_formulas',
      'production_formula_items',
      'notifications',
      'customers',
      'suppliers',
      'categories'
    ];

    console.log('Disabling foreign key constraints...');
    if (dialect === 'mysql') {
      await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    } else {
      await sequelize.query('PRAGMA foreign_keys = OFF');
    }

    console.log('\n--- Cleaning Operational / Company Data ---');
    let totalCleared = 0;
    for (const table of TABLES_TO_CLEAN) {
      try {
        let count = 0;
        try {
          const [[res]] = await sequelize.query(`SELECT COUNT(*) as cnt FROM \`${table}\``);
          count = res?.cnt || 0;
        } catch (_) {}

        if (dialect === 'mysql') {
          await sequelize.query(`TRUNCATE TABLE \`${table}\``);
        } else {
          await sequelize.query(`DELETE FROM \`${table}\``);
        }
        console.log(` [CLEARED]  ${table.padEnd(28)} (Wiped ${count} record${count === 1 ? '' : 's'})`);
        totalCleared++;
      } catch (err) {
        // Fallback to DELETE if TRUNCATE has foreign key restriction
        try {
          await sequelize.query(`DELETE FROM \`${table}\``);
          console.log(` [CLEARED]  ${table.padEnd(28)} (Wiped via DELETE)`);
          totalCleared++;
        } catch (delErr) {
          console.log(` [SKIPPED]  ${table.padEnd(28)} (Not present or error: ${delErr.message.slice(0, 40)})`);
        }
      }
    }

    console.log('\nRe-enabling foreign key constraints...');
    if (dialect === 'mysql') {
      await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
    } else {
      await sequelize.query('PRAGMA foreign_keys = ON');
    }

    // Verify preserved data
    console.log('\n--- Preserved Data Status ---');
    for (const pTable of PRESERVED_TABLES) {
      try {
        const [[{ count }]] = await sequelize.query(`SELECT COUNT(*) as count FROM \`${pTable}\``);
        console.log(` [SAFE]     ${pTable.padEnd(28)} -> ${count} record(s) intact`);
      } catch (_) {
        console.log(` [INFO]     ${pTable.padEnd(28)} -> table not found`);
      }
    }

    console.log('\n======================================================');
    console.log(' SUCCESS: Database cleanup completed successfully!');
    console.log(` Total Tables Cleaned: ${totalCleared}`);
    console.log(' All user logins, credentials, and company info are SAFE.');
    console.log('======================================================\n');

    process.exit(0);
  } catch (error) {
    console.error('\n[FATAL ERROR] Cleanup failed:', error);
    try {
      if (sequelize.getDialect() === 'mysql') {
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
      }
    } catch (_) {}
    process.exit(1);
  }
}

cleanupDatabase();

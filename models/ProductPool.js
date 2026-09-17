const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const ProductPool = sequelize.define('ProductPool', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'company_id' },
  sku: { type: DataTypes.STRING, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: true },
  channel: { type: DataTypes.STRING, defaultValue: 'SHIPSTATION' },
  orderNumber: { type: DataTypes.STRING, allowNull: true, field: 'order_number' },
  imageUrl: { type: DataTypes.TEXT, allowNull: true, field: 'image_url' },
  barcode: { type: DataTypes.STRING, allowNull: true },
  unitPrice: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0, field: 'unit_price' },
  costPrice: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0, field: 'cost_price' },
  weight: { type: DataTypes.STRING, allowNull: true },
  rawDetails: { type: DataTypes.TEXT, allowNull: true, field: 'raw_details' },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'PENDING',
    // PENDING, MATCHED_ALT, MATCHED_BUNDLE, CREATED, IGNORED
  },
  resolvedProductId: { type: DataTypes.INTEGER, allowNull: true, field: 'resolved_product_id' },
  resolvedBundleId: { type: DataTypes.INTEGER, allowNull: true, field: 'resolved_bundle_id' },
  notes: { type: DataTypes.TEXT, allowNull: true },
  createdAt: { type: DataTypes.DATE, field: 'created_at' },
  updatedAt: { type: DataTypes.DATE, field: 'updated_at' }
}, {
  tableName: 'product_pool',
  timestamps: true,
  underscored: true,
  indexes: [
    { name: 'idx_product_pool_company_sku', fields: ['company_id', 'sku'] },
    { name: 'idx_product_pool_status', fields: ['status'] },
  ],
});

module.exports = ProductPool;

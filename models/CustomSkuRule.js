const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const CustomSkuRule = sequelize.define('CustomSkuRule', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  companyId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 1
  },
  sku: {
    type: DataTypes.STRING,
    allowNull: false
  },
  expectedCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  description: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'custom_sku_rules',
  timestamps: true,
  underscored: true
});

module.exports = CustomSkuRule;

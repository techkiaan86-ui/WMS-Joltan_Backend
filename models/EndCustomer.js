const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const EndCustomer = sequelize.define('EndCustomer', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false, field: 'company_id' },
  clientId: { type: DataTypes.INTEGER, allowNull: true, field: 'client_id' },
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: true },
  phone: { type: DataTypes.STRING, allowNull: true },
  addressLine1: { type: DataTypes.STRING, allowNull: true, field: 'address_line1' },
  addressLine2: { type: DataTypes.STRING, allowNull: true, field: 'address_line2' },
  addressLine3: { type: DataTypes.STRING, allowNull: true, field: 'address_line3' },
  town: { type: DataTypes.STRING, allowNull: true },
  county: { type: DataTypes.STRING, allowNull: true },
  postcode: { type: DataTypes.STRING, allowNull: true },
  country: { type: DataTypes.STRING, allowNull: true },
  status: { type: DataTypes.STRING, defaultValue: 'ACTIVE' },
}, {
  tableName: 'end_customers',
  timestamps: true,
  underscored: true,
});

module.exports = EndCustomer;

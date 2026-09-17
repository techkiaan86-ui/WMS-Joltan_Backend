const express = require('express');
const router = express.Router();
const bundleController = require('../controllers/bundleController');
const { authenticate, requireRole } = require('../middlewares/auth');

router.use(authenticate);
router.get('/', requireRole('super_admin', 'company_admin', 'inventory_manager', 'viewer'), bundleController.list);
router.post('/convert-from-product/:productId', requireRole('super_admin', 'company_admin', 'inventory_manager'), bundleController.convertFromProduct);
router.post('/bulk', requireRole('super_admin', 'company_admin', 'inventory_manager'), bundleController.bulkUpload);
router.post('/', requireRole('super_admin', 'company_admin', 'inventory_manager'), bundleController.create);
router.get('/:id', requireRole('super_admin', 'company_admin', 'inventory_manager', 'viewer'), bundleController.getById);
router.put('/:id', requireRole('super_admin', 'company_admin', 'inventory_manager'), bundleController.update);
router.delete('/:id', requireRole('super_admin', 'company_admin', 'inventory_manager'), bundleController.remove);

module.exports = router;

try {
  require('../services/orderService');
  console.log('✅ orderService syntax OK');
  require('../controllers/courierMappingController');
  console.log('✅ courierMappingController syntax OK');
  require('../modules/orders/routes');
  console.log('✅ modules/orders/routes syntax OK');
  require('../modules/integrations/shipstation.service');
  console.log('✅ shipstation.service syntax OK');
} catch (err) {
  console.error('❌ Error requiring module:', err);
  process.exit(1);
}

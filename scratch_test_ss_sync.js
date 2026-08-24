const shipstationService = require('./modules/integrations/shipstation.service');

(async () => {
  console.log('[Testing ShipStation Sync] Triggering live order sync...');
  try {
    const res = await shipstationService.syncOrdersFromShipStation(1);
    console.log('[Test Sync Result]:', res);
  } catch (e) {
    console.error('[Test Sync Error]:', e);
  } finally {
    process.exit(0);
  }
})();

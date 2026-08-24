const axios = require('axios');

const apiKey = 'dP0Y7s5vtA4sp+Orbzo1kQlrDX7zsdhZB6M+Kdoiagg';

async function checkShipStationDates() {
  console.log('====================================================');
  console.log('CHECKING LATEST SHIPSTATION ORDERS & SHIPMENTS DATES');
  console.log('====================================================\n');

  const headers = {
    'api-key': apiKey,
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  // 1. Check /v2/orders sorted by create_date DESC
  try {
    console.log('--- 1. Querying /v2/orders (Latest Created Orders) ---');
    const url1 = 'https://api.shipstation.com/v2/orders?page=1&page_size=20&sort_by=create_date&sort_dir=desc';
    const res1 = await axios.get(url1, { headers, timeout: 10000 });
    const orders1 = res1.data?.orders || [];
    console.log(`Total reported in /v2/orders: ${res1.data?.total || orders1.length}`);
    orders1.slice(0, 15).forEach((o, i) => {
      console.log(`  [${i+1}] Order #: ${o.order_number || o.orderNumber} | CreateDate: ${o.create_date || o.order_date} | OrderDate: ${o.order_date || o.orderDate} | Status: ${o.order_status || o.status}`);
    });
  } catch (err) {
    console.error('Error fetching /v2/orders:', err.response?.data || err.message);
  }

  console.log('\n----------------------------------------------------\n');

  // 2. Check /v2/shipments sorted by created_at DESC
  try {
    console.log('--- 2. Querying /v2/shipments (Latest Shipments) ---');
    const url2 = 'https://api.shipstation.com/v2/shipments?page=1&page_size=20&sort_by=created_at&sort_dir=desc';
    const res2 = await axios.get(url2, { headers, timeout: 10000 });
    const shipments = res2.data?.shipments || [];
    console.log(`Total reported in /v2/shipments: ${res2.data?.total || shipments.length}`);
    shipments.slice(0, 15).forEach((s, i) => {
      console.log(`  [${i+1}] Shipment #: ${s.shipment_number || s.shipmentId || s.id} | Order #: ${s.order_number || s.orderNumber} | CreatedAt: ${s.created_at || s.ship_date} | ShipDate: ${s.ship_date}`);
    });
  } catch (err) {
    console.error('Error fetching /v2/shipments:', err.response?.data || err.message);
  }

  console.log('\n----------------------------------------------------\n');

  // 3. Check V1 ssapi.shipstation.com/orders sorted by OrderDate DESC
  try {
    console.log('--- 3. Querying ssapi.shipstation.com/orders (V1 Endpoint) ---');
    const v1Auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
    const url3 = 'https://ssapi.shipstation.com/orders?page=1&pageSize=20&sortBy=OrderDate&sortDir=DESC';
    const res3 = await axios.get(url3, { headers: { Authorization: v1Auth }, timeout: 10000 });
    const orders3 = res3.data?.orders || [];
    console.log(`Total reported in V1 /orders: ${res3.data?.total || orders3.length}`);
    orders3.slice(0, 15).forEach((o, i) => {
      console.log(`  [${i+1}] Order #: ${o.orderNumber || o.orderId} | OrderDate: ${o.orderDate} | CreateDate: ${o.createDate} | Status: ${o.orderStatus}`);
    });
  } catch (err) {
    console.error('Error fetching V1 /orders:', err.response?.data || err.message);
  }
}

checkShipStationDates();

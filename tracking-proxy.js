const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3005;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const AFTERSHIP_API_KEY = process.env.AFTERSHIP_API_KEY;

const missingEnvironmentVariables = [
  ['SHOPIFY_STORE', SHOPIFY_STORE],
  ['SHOPIFY_ACCESS_TOKEN', SHOPIFY_ACCESS_TOKEN],
  ['AFTERSHIP_API_KEY', AFTERSHIP_API_KEY]
].filter(([, value]) => !value).map(([name]) => name);

if (missingEnvironmentVariables.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnvironmentVariables.join(', ')}`);
}

// Helper to perform HTTPS requests with optional body
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Alias for GET
function httpsGet(options) {
  return httpsRequest(options, null);
}

// Fetch tracking data from AfterShip using the 2026-07 two-step flow:
// Step 1: POST tracking number + slug → get tracking ID (works even if already exists, code 4003 also returns the ID)
// Step 2: GET /trackings/:id → full checkpoint data
async function getAfterShipTracking(trackingNumber, slug) {
  if (!AFTERSHIP_API_KEY || !trackingNumber) return null;

  const carrierSlug = (slug || 'dtdc').toLowerCase();
  const headers = {
    'as-api-key': AFTERSHIP_API_KEY,
    'Content-Type': 'application/json'
  };

  try {
    // Step 1: POST to create/retrieve the tracking — always returns id even if it already exists (code 4003)
    const postBody = JSON.stringify({ tracking_number: trackingNumber, slug: carrierSlug });
    console.log(`[AfterShip] Step 1: POST tracking for AWB ${trackingNumber} (slug: ${carrierSlug})`);

    const postRes = await httpsRequest({
      hostname: 'api.aftership.com',
      path: '/tracking/2026-07/trackings',
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(postBody) }
    }, postBody);

    // Both 201 (created) and 4003 (already exists) return the tracking ID.
    // Keep the nested fallback for compatibility with older AfterShip payloads.
    const trackingId = postRes.data && postRes.data.data && (
      postRes.data.data.id ||
      (postRes.data.data.tracking && postRes.data.data.tracking.id)
    );
    if (!trackingId) {
      console.warn('[AfterShip] Step 1: No tracking ID returned', postRes.data);
      return null;
    }

    console.log(`[AfterShip] Step 2: GET tracking details for ID ${trackingId}`);

    // Helper to GET by ID
    const fetchById = () => httpsRequest({
      hostname: 'api.aftership.com',
      path: `/tracking/2026-07/trackings/${trackingId}`,
      method: 'GET',
      headers
    }, null);

    // Step 2: GET full tracking details by ID
    let getRes = await fetchById();

    // AfterShip can return the tracking record before its checkpoints are ready,
    // including for an existing record during a refresh. Briefly retry the GET so
    // the first page load receives shipment data whenever the carrier has it.
    const retryDelays = [1000, 2000, 2500];
    for (const delay of retryDelays) {
      const tracking = getRes.data && getRes.data.data;
      const hasCheckpoints = tracking && Array.isArray(tracking.checkpoints) && tracking.checkpoints.length > 0;
      if (getRes.status !== 200 || hasCheckpoints) break;

      console.log(`[AfterShip] No checkpoints yet – retrying Step 2 in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      getRes = await fetchById();
    }

    if (getRes.status === 200 && getRes.data && getRes.data.data) {
      return parseAfterShipTracking(getRes.data.data);
    }

    console.warn('[AfterShip] Step 2: Unexpected response', getRes.status, getRes.data);
  } catch (err) {
    console.error('[AfterShip Error]', err.message);
  }

  return null;
}

function parseAfterShipTracking(tracking) {
  return {
    id: tracking.id,
    tracking_number: tracking.tracking_number,
    slug: tracking.slug,
    tag: tracking.tag, // 'InTransit', 'OutForDelivery', 'Delivered', etc.
    subtag_message: tracking.subtag_message,
    order_number: tracking.order_number,
    courier_tracking_link: tracking.courier_tracking_link,
    origin: tracking.origin_raw_location || tracking.origin_city,
    destination: tracking.destination_raw_location || `${tracking.destination_city || ''}, ${tracking.destination_state || ''}`,
    expected_delivery: tracking.aftership_estimated_delivery_date || tracking.latest_estimated_delivery,
    checkpoints: (tracking.checkpoints || []).map(cp => ({
      time: cp.checkpoint_time,
      location: cp.location || (cp.city ? `${cp.city}, ${cp.country_name || ''}` : ''),
      message: cp.message,
      tag: cp.tag,
      subtag_message: cp.subtag_message
    }))
  };
}

const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shopify-Access-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  let orderQuery = null;
  const match = pathname.match(/^\/api\/order\/(.+)/);
  if (match) {
    orderQuery = decodeURIComponent(match[1]).trim().replace(/^#/, '');
  } else if (pathname === '/api/order' && parsedUrl.query.id) {
    orderQuery = parsedUrl.query.id.trim().replace(/^#/, '');
  }

  if (!orderQuery) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing order ID or number parameter' }));
    return;
  }

  console.log(`[Proxy] Fetching order '${orderQuery}'...`);

  try {
    let rawOrder = null;

    // Check if numeric order ID
    if (/^[0-9]+$/.test(orderQuery)) {
      const byId = await httpsGet({
        hostname: SHOPIFY_STORE,
        path: `/admin/api/2026-10/orders/${orderQuery}.json`,
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      if (byId.status === 200 && byId.data && byId.data.order) {
        rawOrder = byId.data.order;
      }
    }

    // If not found by direct ID, search by order name/number (e.g. #18786 or 18786)
    if (!rawOrder) {
      const searchRes = await httpsGet({
        hostname: SHOPIFY_STORE,
        path: `/admin/api/2026-10/orders.json?name=%23${encodeURIComponent(orderQuery)}&status=any`,
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      if (searchRes.status === 200 && searchRes.data && searchRes.data.orders && searchRes.data.orders.length > 0) {
        rawOrder = searchRes.data.orders[0];
      }
    }

    if (!rawOrder) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Order not found' }));
      return;
    }

    // Extract fulfillment tracking info
    const fulfillments = rawOrder.fulfillments || [];
    // Orders may contain an older fulfillment without tracking before the actual
    // shipped fulfillment. Pick the first fulfillment that has any tracking number.
    const trackedFulfillment = fulfillments.find(fulfillment => (
      fulfillment.tracking_number ||
      (Array.isArray(fulfillment.tracking_numbers) && fulfillment.tracking_numbers.length > 0)
    )) || null;
    const trackingNumber = trackedFulfillment && (
      trackedFulfillment.tracking_number || trackedFulfillment.tracking_numbers[0]
    );
    // Derive AfterShip carrier slug from Shopify fulfillment tracking_company
    // e.g. "DTDC India" or "DTDC" → "dtdc"
    const carrierSlug = trackedFulfillment && trackedFulfillment.tracking_company
      ? trackedFulfillment.tracking_company.toLowerCase().replace(/\s+india$/i, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      : 'dtdc';

    // Fetch live AfterShip checkpoints & tracking status (two-step: POST → GET by ID)
    console.log(`[Proxy] Fetching AfterShip tracking for AWB: ${trackingNumber || 'N/A'}, slug: ${carrierSlug}`);
    const aftershipTracking = await getAfterShipTracking(trackingNumber, carrierSlug);

    const sanitized = {
      id: rawOrder.id,
      name: rawOrder.name,
      order_number: rawOrder.order_number,
      created_at: rawOrder.created_at,
      financial_status: rawOrder.financial_status,
      fulfillment_status: rawOrder.fulfillment_status,
      currency: rawOrder.currency,
      total_price: rawOrder.total_price,
      subtotal_price: rawOrder.subtotal_price,
      total_shipping_price_set: rawOrder.total_shipping_price_set,
      line_items: (rawOrder.line_items || []).map(item => ({
        id: item.id,
        title: item.title,
        name: item.name,
        variant_title: item.variant_title,
        quantity: item.quantity,
        price: item.price,
        sku: item.sku,
        vendor: item.vendor
      })),
      shipping_address: rawOrder.shipping_address ? {
        name: rawOrder.shipping_address.name,
        city: rawOrder.shipping_address.city,
        province: rawOrder.shipping_address.province,
        zip: rawOrder.shipping_address.zip,
        country: rawOrder.shipping_address.country
      } : null,
      fulfillments: fulfillments.map(f => ({
        id: f.id,
        status: f.status,
        tracking_company: f.tracking_company,
        tracking_number: f.tracking_number,
        tracking_numbers: f.tracking_numbers,
        tracking_url: f.tracking_url,
        tracking_urls: f.tracking_urls,
        updated_at: f.updated_at
      })),
      aftership: aftershipTracking
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order: sanitized }));

  } catch (err) {
    console.error('[Proxy Error]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error while retrieving order' }));
  }
});

server.listen(PORT, () => {
  console.log(`[Tracking Proxy] Running on http://localhost:${PORT}`);
  console.log(`[Tracking Proxy] AfterShip integration enabled`);
});

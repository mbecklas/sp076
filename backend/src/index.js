/*
 * SP076 shop backend: one Cloudflare Worker.
 *
 *   GET  /api/editions          which numbers are sold or on hold
 *   POST /api/checkout          hold a number and open Stripe Checkout
 *   POST /api/release           give a held number back (customer cancelled)
 *   GET  /api/order             order status for the "thank you" screen
 *   POST /api/stripe/webhook    Stripe says paid / expired -> sell or free the number, send to Gelato
 *   POST /api/gelato/webhook    Gelato says shipped -> store tracking, email the customer
 *   GET  /files/...             signed, expiring links to the print files (for Gelato only)
 */

const HOLD_SECONDS = 32 * 60;          // a number is held this long while its owner is in checkout
const CHECKOUT_SECONDS = 31 * 60;      // Stripe's session ends before the hold does (Stripe minimum is 30 min)
const MAX_HOLDS_PER_VISITOR = 2;
const FILE_LINK_SECONDS = 14 * 24 * 3600;
const SIZES = ['S', 'M', 'L', 'XL'];
const pad = n => String(n).padStart(3, '0');
const now = () => Math.floor(Date.now() / 1000);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const route = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;
      let res;
      if (route === 'GET /api/editions') res = await listEditions(env);
      else if (route === 'POST /api/checkout') res = await startCheckout(request, env);
      else if (route === 'POST /api/release') res = await releaseHold(request, env);
      else if (route === 'GET /api/order') res = await orderStatus(url, env);
      else if (route === 'POST /api/stripe/webhook') return await stripeWebhook(request, env, ctx);
      else if (route === 'POST /api/gelato/webhook') return await gelatoWebhook(request, url, env);
      else if (request.method === 'GET' && url.pathname.startsWith('/files/')) return await printFile(url, env);
      else res = json({ error: 'Not found' }, 404);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      console.error(err.stack || err);
      return json({ error: 'Something went wrong on our side. Please try again.' }, 500, cors);
    }
  },
};

/* ------------------------------------------------------------------ editions */

async function listEditions(env) {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT id, status, reserved_until FROM editions WHERE status = 'sold' OR (status = 'reserved' AND reserved_until > ?)`
  ).bind(t).all();
  const sold = results.filter(r => r.status === 'sold').map(r => r.id);
  const held = results.filter(r => r.status === 'reserved').map(r => r.id);
  return json({ total: 100, sold, held, available: 100 - sold.length - held.length }, 200, { 'Cache-Control': 'no-store' });
}

/* ------------------------------------------------------------------ checkout */

async function startCheckout(request, env) {
  const body = await request.json().catch(() => ({}));
  const edition = Number(body.edition), size = String(body.size || '').toUpperCase();
  if (!Number.isInteger(edition) || edition < 1 || edition > 100) return json({ error: 'Pick a number from 1 to 100.' }, 400);
  if (!SIZES.includes(size)) return json({ error: 'Pick a size: S, M, L or XL.' }, 400);

  const t = now(), ipHash = await sha256(`${env.IP_SALT || 'sp076'}:${request.headers.get('CF-Connecting-IP') || ''}`);
  const mine = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM editions WHERE status = 'reserved' AND reserved_until > ? AND ip_hash = ?`
  ).bind(t, ipHash).first();
  if (mine.n >= MAX_HOLDS_PER_VISITOR) return json({ error: 'You already have numbers on hold. Finish or cancel that checkout first.' }, 429);

  // Hold the number in one atomic step: only succeeds if it is free (or its old hold ran out).
  const hold = crypto.randomUUID();
  const taken = await env.DB.prepare(
    `UPDATE editions SET status = 'reserved', reserved_until = ?, hold_token = ?, session_id = NULL, size = ?, ip_hash = ?
     WHERE id = ? AND (status = 'available' OR (status = 'reserved' AND reserved_until <= ?))`
  ).bind(t + HOLD_SECONDS, hold, size, ipHash, edition, t).run();
  if (taken.meta.changes !== 1) {
    const row = await env.DB.prepare(`SELECT status FROM editions WHERE id = ?`).bind(edition).first();
    return json({ error: row && row.status === 'sold' ? `Nº ${pad(edition)} is sold.` : `Someone is checking out nº ${pad(edition)} right now. Try another number, or check back in half an hour.` }, 409);
  }

  try {
    const site = env.SITE_URL;
    const session = await stripe(env, 'POST', '/v1/checkout/sessions', {
      mode: 'payment',
      client_reference_id: hold,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: env.CURRENCY,
          unit_amount: Number(env.PRICE_CENTS),
          product_data: { name: `SP076 hoodie nº ${pad(edition)}/100`, description: `Size ${size}. One of one: this number is never made again.` },
        },
      }],
      shipping_address_collection: { allowed_countries: env.SHIP_COUNTRIES.split(',').map(s => s.trim()) },
      shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: 'Tracked shipping', fixed_amount: { amount: Number(env.SHIPPING_CENTS), currency: env.CURRENCY } } }],
      phone_number_collection: { enabled: true },   // couriers need a phone number
      metadata: { edition: String(edition), size, hold },
      payment_intent_data: { metadata: { edition: String(edition), size } },
      expires_at: t + CHECKOUT_SECONDS,
      success_url: `${site}?order=paid&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}?order=cancelled&hold=${hold}&edition=${edition}`,
    });
    await env.DB.prepare(`UPDATE editions SET session_id = ? WHERE id = ? AND hold_token = ?`).bind(session.id, edition, hold).run();
    return json({ url: session.url, hold, holdUntil: t + HOLD_SECONDS });
  } catch (err) {
    await env.DB.prepare(`UPDATE editions SET status = 'available', reserved_until = NULL, hold_token = NULL WHERE id = ? AND hold_token = ?`).bind(edition, hold).run();
    throw err;
  }
}

async function releaseHold(request, env) {
  const { hold } = await request.json().catch(() => ({}));
  if (!hold) return json({ error: 'Missing hold.' }, 400);
  const row = await env.DB.prepare(`SELECT id, session_id FROM editions WHERE hold_token = ? AND status = 'reserved'`).bind(hold).first();
  if (!row) return json({ released: false });
  // Close the Stripe page first so it can't be paid after the number is freed.
  if (row.session_id) {
    try { await stripe(env, 'POST', `/v1/checkout/sessions/${row.session_id}/expire`, {}); }
    catch (err) { const s = await stripe(env, 'GET', `/v1/checkout/sessions/${row.session_id}`).catch(() => null); if (s && s.status === 'complete') return json({ released: false }); }
  }
  await freeHold(env, row.id, hold);
  return json({ released: true, edition: row.id });
}

const freeHold = (env, edition, hold) => env.DB.prepare(
  `UPDATE editions SET status = 'available', reserved_until = NULL, hold_token = NULL, session_id = NULL, size = NULL, ip_hash = NULL
   WHERE id = ? AND hold_token = ? AND status = 'reserved'`
).bind(edition, hold).run();

async function orderStatus(url, env) {
  const id = url.searchParams.get('session_id');
  if (!id) return json({ error: 'Missing session_id.' }, 400);
  const order = await env.DB.prepare(
    `SELECT edition, size, reference, created_at, gelato_status, tracking_url FROM orders WHERE id = ?`
  ).bind(id).first();
  if (order) return json({ status: order.tracking_url ? 'shipped' : 'paid', ...order });
  return json({ status: 'pending' });   // Stripe's webhook hasn't arrived yet; the page asks again
}

/* ------------------------------------------------------------------ Stripe webhook */

async function stripeWebhook(request, env, ctx) {
  const raw = await request.text();
  if (!(await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('Bad signature', { status: 400 });
  }
  const event = JSON.parse(raw), session = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
      if (session.payment_status !== 'paid') break;          // delayed payment methods finish below
    // falls through
    case 'checkout.session.async_payment_succeeded':
      await recordPaidOrder(session, env);
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const { edition, hold } = session.metadata || {};
      if (edition && hold) await freeHold(env, Number(edition), hold);
      break;
    }
  }
  return new Response('ok');
}

async function recordPaidOrder(session, env) {
  const edition = Number(session.metadata.edition), size = session.metadata.size;
  const details = session.customer_details || {};
  const ship = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || {};
  const reference = `SP076-${pad(edition)}-${session.id.slice(-4).toUpperCase()}`;

  // Sell the number and store the order together. INSERT OR IGNORE makes a repeated webhook harmless.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO orders (id, edition, size, email, name, phone, address_json, amount_total, currency, created_at, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(session.id, edition, size, details.email || null, ship.name || details.name || null, details.phone || null,
      JSON.stringify(ship.address || details.address || {}), session.amount_total, session.currency, now(), reference),
    env.DB.prepare(`UPDATE editions SET status = 'sold', reserved_until = NULL, hold_token = NULL, ip_hash = NULL WHERE id = ?`).bind(edition),
  ]);

  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(session.id).first();
  if (order.gelato_order_id) return;            // already sent on an earlier delivery of this webhook
  try {
    const g = await createGelatoOrder(order, env);
    await env.DB.prepare(`UPDATE orders SET gelato_order_id = ?, gelato_status = ?, gelato_error = NULL WHERE id = ?`)
      .bind(g.id, g.fulfillmentStatus || g.status || 'created', session.id).run();
  } catch (err) {
    await env.DB.prepare(`UPDATE orders SET gelato_error = ? WHERE id = ?`).bind(String(err.message).slice(0, 500), session.id).run();
    throw err;   // a 500 makes Stripe deliver the webhook again later, which retries Gelato
  }
}

/* ------------------------------------------------------------------ Gelato */

async function createGelatoOrder(order, env) {
  const products = JSON.parse(env.GELATO_PRODUCTS || '{}'), productUid = products[order.size];
  if (!productUid) throw new Error(`No Gelato product UID set for size ${order.size} (GELATO_PRODUCTS).`);
  const addr = JSON.parse(order.address_json || '{}');
  const [firstName, ...rest] = String(order.name || '').trim().split(/\s+/);
  const files = [
    { type: env.GELATO_FRONT_FILE_TYPE || 'default', url: await signedFileUrl(env, `front/SP076-${pad(order.edition)}-front.png`) },
    { type: env.GELATO_BACK_FILE_TYPE || 'back', url: await signedFileUrl(env, `back/SP076-${pad(order.edition)}-back.png`) },
  ];
  const body = {
    orderType: env.GELATO_ORDER_TYPE || 'draft',
    orderReferenceId: order.reference,
    customerReferenceId: order.email || order.reference,
    currency: (order.currency || env.CURRENCY).toUpperCase(),
    items: [{ itemReferenceId: `${order.reference}-1`, productUid, quantity: 1, files }],
    shippingAddress: {
      firstName: firstName || 'Customer', lastName: rest.join(' ') || '-',
      addressLine1: addr.line1 || '', addressLine2: addr.line2 || '',
      city: addr.city || '', postCode: addr.postal_code || '', state: addr.state || '',
      country: addr.country || '', email: order.email || '', phone: order.phone || '',
    },
  };
  if (env.GELATO_SHIPMENT_METHOD) body.shipmentMethodUid = env.GELATO_SHIPMENT_METHOD;
  const res = await fetch(env.GELATO_API_URL || 'https://order.gelatoapis.com/v4/orders', {   // override only for local testing
    method: 'POST', headers: { 'X-API-KEY': env.GELATO_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gelato ${res.status}: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

async function gelatoWebhook(request, url, env) {
  // Gelato calls https://<worker>/api/gelato/webhook?token=<GELATO_WEBHOOK_TOKEN>
  if (!env.GELATO_WEBHOOK_TOKEN || !timingSafeEqual(url.searchParams.get('token') || '', env.GELATO_WEBHOOK_TOKEN)) {
    return new Response('Forbidden', { status: 403 });
  }
  const e = await request.json().catch(() => ({}));
  const ref = e.orderReferenceId, gid = e.orderId;
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE reference = ? OR gelato_order_id = ?`).bind(ref || '', gid || '').first();
  if (!order) return new Response('unknown order');      // 200 so Gelato doesn't keep retrying
  if (e.fulfillmentStatus) await env.DB.prepare(`UPDATE orders SET gelato_status = ? WHERE id = ?`).bind(e.fulfillmentStatus, order.id).run();
  const trackingUrl = e.trackingUrl || (e.items && e.items[0] && e.items[0].fulfillments && e.items[0].fulfillments[0] && e.items[0].fulfillments[0].trackingUrl);
  const trackingCode = e.trackingCode || (e.items && e.items[0] && e.items[0].fulfillments && e.items[0].fulfillments[0] && e.items[0].fulfillments[0].trackingCode);
  if (trackingUrl || trackingCode) {
    await env.DB.prepare(`UPDATE orders SET tracking_url = ?, tracking_code = ? WHERE id = ?`).bind(trackingUrl || null, trackingCode || null, order.id).run();
    if (!order.shipped_email_at && order.email) {
      const sent = await sendShippedEmail(env, order, trackingUrl, trackingCode);
      if (sent) await env.DB.prepare(`UPDATE orders SET shipped_email_at = ? WHERE id = ?`).bind(now(), order.id).run();
    }
  }
  return new Response('ok');
}

async function sendShippedEmail(env, order, trackingUrl, trackingCode) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  const n = pad(order.edition);
  const text = [
    `Your SP076 hoodie nº ${n}/100 is on its way.`, '',
    trackingUrl ? `Track it here: ${trackingUrl}` : `Tracking code: ${trackingCode}`, '',
    `Order ${order.reference}`, `This number is yours now. It won't be made again.`,
  ].join('\n');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: order.email, subject: `SP076 nº ${n} has shipped`, text }),
  });
  if (!res.ok) console.error('Resend', res.status, await res.text());
  return res.ok;
}

/* ------------------------------------------------------------------ print files */

// Links look like /files/back/SP076-042-back.png?exp=1767225600&sig=…  and only work until exp.
async function signedFileUrl(env, key) {
  const exp = now() + FILE_LINK_SECONDS;
  const sig = await hmacHex(env.FILE_SIGNING_SECRET, `${key}:${exp}`);
  return `${env.WORKER_URL.replace(/\/+$/, '')}/files/${key}?exp=${exp}&sig=${sig}`;
}

async function printFile(url, env) {
  if (!env.FILE_SIGNING_SECRET) return new Response('Print files are not set up yet', { status: 503 });
  const key = decodeURIComponent(url.pathname.slice('/files/'.length));
  const exp = Number(url.searchParams.get('exp')), sig = url.searchParams.get('sig') || '';
  if (!/^(front|back)\/SP076-\d{3}-(front|back)\.png$/.test(key) || !exp || exp < now()) return new Response('Link expired', { status: 403 });
  if (!timingSafeEqual(sig, await hmacHex(env.FILE_SIGNING_SECRET, `${key}:${exp}`))) return new Response('Forbidden', { status: 403 });
  // Files ship with the Worker as private assets; an R2 bucket bound as PRINTS is used instead if present.
  let body;
  if (env.PRINTS) { const obj = await env.PRINTS.get(key); body = obj && obj.body; }
  else { const r = await env.ASSETS.fetch(new Request(new URL(`/${key}`, url))); body = r.ok ? r.body : null; }
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' } });
}

/* ------------------------------------------------------------------ helpers */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
}

// Stripe's API takes form-encoded bodies with bracketed keys: line_items[0][price_data][currency]=eur
function formEncode(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out); else out.append(key, String(v));
  }
  return out;
}

async function stripe(env, method, path, params) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : formEncode(params || {}),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${out.error && out.error.message}`);
  return out;
}

async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')).map(([k, ...v]) => [k, v.join('=')]));
  const t = Number(parts.t);
  if (!t || Math.abs(now() - t) > 300) return false;              // reject old or replayed events
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return header.split(',').some(p => p.startsWith('v1=') && timingSafeEqual(p.slice(3), expected));
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export { formEncode, verifyStripeSignature, hmacHex, timingSafeEqual };

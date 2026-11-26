// Run with:  npm test   (uses Node's built-in test runner, no install needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formEncode, verifyStripeSignature, hmacHex, timingSafeEqual } from '../src/index.js';

const secret = 'whsec_test_secret';
const body = JSON.stringify({ type: 'checkout.session.completed' });
const sign = async (t, payload = body, key = secret) => `t=${t},v1=${await hmacHex(key, `${t}.${payload}`)}`;
const nowS = () => Math.floor(Date.now() / 1000);

test('accepts a correctly signed, fresh Stripe event', async () => {
  assert.equal(await verifyStripeSignature(body, await sign(nowS()), secret), true);
});

test('rejects a tampered body', async () => {
  assert.equal(await verifyStripeSignature(body + ' ', await sign(nowS()), secret), false);
});

test('rejects the wrong secret', async () => {
  assert.equal(await verifyStripeSignature(body, await sign(nowS(), body, 'whsec_other'), secret), false);
});

test('rejects an old (replayed) event', async () => {
  assert.equal(await verifyStripeSignature(body, await sign(nowS() - 600), secret), false);
});

test('rejects a missing header or secret', async () => {
  assert.equal(await verifyStripeSignature(body, null, secret), false);
  assert.equal(await verifyStripeSignature(body, await sign(nowS()), ''), false);
});

test('encodes nested params the way Stripe expects', () => {
  const p = formEncode({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'eur' } }], shipping_address_collection: { allowed_countries: ['NL', 'DE'] }, skip: null });
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('line_items[0][quantity]'), '1');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(p.get('shipping_address_collection[allowed_countries][1]'), 'DE');
  assert.equal(p.has('skip'), false);
});

test('timingSafeEqual compares exactly', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNapamsResult, normalizeProductName, LookupError } from '../lib/napams-result.mjs';
import { createHandler } from '../netlify/functions/napams.mjs';
import { createLaunchOptions } from '../lib/napams-browser.mjs';

const fixture = readFileSync(new URL('./fixtures/napams-found.txt', import.meta.url), 'utf8');
const repeatedDialog = fixture.replaceAll('Profectiv Mega Growth Anti-Dandruff Spray', 'HOLLANDIA YOGHURT DRINK SWEETENED' + ' (01-7506)'.repeat(6)).replace('A2-5680', '01-7506');
const request = number => new Request('https://checker.example/api/napams?nrn=' + encodeURIComponent(number));

test('real browser packages provide an argument array without disabling web security', async () => {
  const options = await createLaunchOptions('/tmp/test-chromium');
  assert.ok(Array.isArray(options.args));
  assert.ok(options.args.length > 0);
  assert.ok(options.args.every(arg => typeof arg === 'string'));
  assert.equal(options.args.includes('--disable-web-security'), false);
  assert.equal(options.args.includes('--allow-running-insecure-content'), false);
});

test('parses the live official A2-5680 dialog without inventing registration status', () => {
  const result = parseNapamsResult(fixture, 'A2-5680');
  assert.equal(result.state, 'found');
  assert.equal(result.record.product_name, 'Profectiv Mega Growth Anti-Dandruff Spray');
  assert.equal(result.record.manufacturer_name, 'Godrej Nigeria Limited');
  assert.equal(result.record.category, 'Cosmetics');
  assert.equal(result.record.expiry_date, '2031-06-29');
  assert.equal(result.record.status, null);
});
test('normalizes repeated upstream registration suffixes without altering legitimate name content', () => {
  const expected = 'HOLLANDIA YOGHURT DRINK SWEETENED (01-7506)';
  assert.equal(parseNapamsResult(repeatedDialog, '01-7506').record.product_name, expected);
  assert.equal(normalizeProductName(expected, '01-7506'), expected);
  assert.equal(normalizeProductName(normalizeProductName(expected + ' (01-7506)', '01-7506'), '01-7506'), expected);
  assert.equal(normalizeProductName('Drink (Sweetened) (01-7506) (01-7506)', '01-7506'), 'Drink (Sweetened) (01-7506)');
  for (const name of ['Drink (Sweetened)', 'Drink (01-7506) Edition', 'Drink (A2-5680) (A2-5680)', 'Drink (01-7506) (250 ml)'])
    assert.equal(normalizeProductName(name, '01-7506'), name);
});
test('repeated API cache hits retain the normalized title and original timestamp', async () => {
  let calls = 0;
  const handler = createHandler(async number => { calls++; return parseNapamsResult(repeatedDialog, number, '2026-10-10T20:00:00.000Z'); });
  const first = await (await handler(request('01-7506'))).json();
  for (let i = 0; i < 3; i++) {
    const cached = await (await handler(request('01-7506'))).json();
    assert.deepEqual(cached, first);
    assert.equal(cached.record.product_name, 'HOLLANDIA YOGHURT DRINK SWEETENED (01-7506)');
  }
  assert.equal(calls, 1);
});
test('accepts only an explicit negative result, never CAPTCHA, blank or mismatched records', () => {
  assert.equal(parseNapamsResult('Product not found!!', 'X0-0000000000').state, 'not_found');
  for (const text of ['', 'NAFDAC is unavailable', 'Some products not found', 'Product Name: test'])
    assert.throws(() => parseNapamsResult(text, 'A2-5680'), { code: 'unexpected_response' });
  assert.throws(() => parseNapamsResult('Captcha failed', 'A2-5680'), { code: 'verification_required' });
  assert.throws(() => parseNapamsResult(fixture, 'A4-1667'), { code: 'unexpected_response' });
});
test('API validates input before starting a browser', async () => {
  let calls = 0;
  const handler = createHandler(async () => { calls++; });
  assert.equal((await handler(request(''))).status, 400);
  assert.equal((await handler(request('https://example.com'))).status, 400);
  assert.equal((await handler(new Request('https://checker.example/api/napams', { method: 'POST' }))).status, 405);
  assert.equal(calls, 0);
});
test('API caches successful public records and preserves source timestamp', async () => {
  const handler = createHandler(async number => parseNapamsResult(fixture, number, '2026-09-23T19:00:00.000Z'));
  const response = await handler(request('a2–5680'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Netlify-CDN-Cache-Control'), /max-age=300/);
  assert.equal((await response.json()).record.checked_at, '2026-09-23T19:00:00.000Z');
});
test('API never caches CAPTCHA failures or reports them as no match', async () => {
  const handler = createHandler(async () => { throw new LookupError('verification_required', 'Captcha failed'); });
  const response = await handler(request('A2-5680'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Netlify-CDN-Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.state, 'unavailable');
  assert.equal(body.code, 'verification_required');
});
test('slow verification sends bytes before the result and then completes as valid JSON', async () => {
  let complete, calls = 0;
  const deferred = new Promise(resolve => { complete = resolve; });
  const handler = createHandler(async number => { calls++; await deferred; return parseNapamsResult(fixture, number); }, { streamAfterMs: 1, heartbeatMs: 5 });
  const response = await handler(request('A2-5680'));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('Netlify-CDN-Cache-Control'), 'no-store');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value).trim(), '');
  complete();
  let text = new TextDecoder().decode(first.value);
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
  assert.equal(JSON.parse(text).state, 'found');
  const cached = await handler(request('A2-5680'));
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).state, 'found');
  assert.equal(calls, 1);
});
test('a slow CAPTCHA failure remains unavailable and is never cached', async () => {
  let reject, calls = 0;
  const deferred = new Promise((resolve, fail) => { reject = fail; });
  const handler = createHandler(async () => { calls++; await deferred; }, { streamAfterMs: 1, heartbeatMs: 5 });
  const response = await handler(request('A2-5680'));
  assert.equal(response.status, 202);
  reject(new LookupError('verification_required', 'Captcha failed'));
  const body = await response.json();
  assert.equal(body.state, 'unavailable');
  assert.equal(body.code, 'verification_required');
  assert.equal(response.headers.get('Netlify-CDN-Cache-Control'), 'no-store');
  const repeated = await handler(request('A2-5680'));
  assert.equal(repeated.status, 503);
  assert.equal(calls, 2);
});

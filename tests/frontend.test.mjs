import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseNapamsResult } from '../lib/napams-result.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const officialDialog = readFileSync(new URL('./fixtures/napams-found.txt', import.meta.url), 'utf8');
// Live captured NAPAMS text is a test fixture only, never an application fallback.
const napamsRecord = parseNapamsResult(officialDialog, 'A2-5680');
const greenRecord = { product_id: 4112, NAFDAC: 'A4-1667', product_name: 'Fleming 457 mg/5 mL Powder for Oral Suspension', status: 'Inactive' };

function setup({ greenFailure = false, napamsState = 'found', greenRows, sourceRecord = napamsRecord } = {}) {
  const requests = [], opened = [];
  const dom = new JSDOM(html, {
    url: 'https://checker.example/', runScripts: 'dangerously',
    beforeParse(window) {
      window.AbortSignal = AbortSignal;
      window.AbortController = AbortController;
      window.open = (...args) => opened.push(args);
      window.fetch = async raw => {
        const url = new URL(raw, window.location.href); requests.push(url);
        if (url.pathname === '/api/napams') {
          if (napamsState === 'missing') return new Response('Not found', { status: 404 });
          if (napamsState === 'gateway_timeout' || (napamsState === 'gateway_then_found' && requests.filter(url => url.pathname === '/api/napams').length === 1)) return new Response('Gateway timeout', { status: 502, headers: { 'Content-Type': 'text/html' } });
          if (napamsState === 'verification_required') return Response.json({ state: 'unavailable', code: 'verification_required' }, { status: 503 });
          if ((napamsState === 'cold_then_found' && requests.filter(url => url.pathname === '/api/napams').length === 1) || napamsState === 'upstream_timeout') return new Response('\n' + JSON.stringify({ state: 'unavailable', code: 'upstream_timeout' }), { status: 202, headers: { 'Content-Type': 'application/json' } });
          if (napamsState === 'not_found') return Response.json({ state: 'not_found', record: null });
          if (napamsState === 'stream_found' || napamsState === 'truncated_stream') return new Response('\n\n' + (napamsState === 'stream_found' ? JSON.stringify(sourceRecord) : ''), { status: 202, headers: { 'Content-Type': 'application/json' } });
          return Response.json(sourceRecord);
        }
        if (url.pathname === '/nafdac/greenbook') {
          if (greenFailure) throw Error('source unavailable');
          const rows = greenRows ?? (url.searchParams.get('search[value]') === 'A2-5680' ? [] : [greenRecord]);
          return Response.json({ data: rows, recordsFiltered: rows.length });
        }
        if (url.pathname.startsWith('/nafdac/record/')) return new Response('<h1>Manufacturer Name</h1><p>Medreich Limited</p>');
        return Response.json([]);
      };
    }
  });
  return { dom, document: dom.window.document, requests, opened };
}
async function submit(client, values) {
  for (const [id, value] of Object.entries(values)) client.document.getElementById(id).value = value;
  client.document.getElementById('lookup').requestSubmit();
  for (let i = 0; i < 100 && client.document.getElementById('check').disabled; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(client.document.getElementById('check').disabled, false);
}

test('both inputs are visible alternatives; number-only still finds Greenbook records', async t => {
  const c = setup(); t.after(() => c.dom.window.close());
  for (const id of ['nrn', 'product']) {
    assert.equal(c.document.getElementById(id).closest('details'), null);
    assert.equal(c.document.getElementById(id).required, false);
  }
  assert.equal(c.document.getElementById('choice-join').textContent, 'or');
  await submit(c, { nrn: 'A4-1667' });
  assert.match(c.document.getElementById('record-name').textContent, /Fleming/);
  assert.equal(c.requests.some(url => url.pathname === '/api/napams'), false);
});
test('name-only searches the product-name column and does not require a number', async t => {
  const c = setup(); t.after(() => c.dom.window.close());
  await submit(c, { product: 'Fleming' });
  const query = c.requests.find(url => url.pathname === '/nafdac/greenbook');
  assert.equal(query.searchParams.get('search[value]'), '');
  assert.equal(query.searchParams.get('columns[0][search][value]'), 'Fleming');
  assert.match(c.document.getElementById('record-name').textContent, /Fleming/);
  assert.equal(c.requests.some(url => url.pathname === '/api/napams'), false);
});
test('A2-5680 fallback renders NAPAMS details in-page with no redirect', async t => {
  const c = setup(); t.after(() => c.dom.window.close());
  await submit(c, { nrn: 'A2-5680' });
  assert.equal(c.requests.filter(url => url.pathname === '/api/napams').length, 1);
  assert.match(c.document.getElementById('record-name').textContent, /Profectiv Mega Growth Anti-Dandruff Spray/);
  assert.match(c.document.getElementById('metadata').textContent, /Godrej Nigeria Limited/);
  assert.match(c.document.getElementById('metadata').textContent, /Registration expires2031-06-29/);
  assert.match(c.document.getElementById('record-source').textContent, /NAPAMS/);
  assert.equal(c.document.getElementById('record-tag').textContent, 'Registration record found');
  assert.equal(c.opened.length, 0);
});
test('an already-suffixed upstream title remains unchanged through repeated frontend cache hits', async t => {
  const dialog = officialDialog.replaceAll('Profectiv Mega Growth Anti-Dandruff Spray', 'HOLLANDIA YOGHURT DRINK SWEETENED' + ' (01-7506)'.repeat(6)).replace('A2-5680', '01-7506');
  const sourceRecord = parseNapamsResult(dialog, '01-7506');
  const original = structuredClone(sourceRecord);
  const c = setup({ greenRows: [], sourceRecord }); t.after(() => c.dom.window.close());
  for (let i = 0; i < 3; i++) {
    await submit(c, { nrn: '01-7506' });
    assert.equal(c.document.getElementById('record-name').textContent, 'HOLLANDIA YOGHURT DRINK SWEETENED (01-7506)');
    assert.equal(c.document.getElementById('record-tag').textContent, 'Registration record found');
  }
  assert.equal(c.requests.filter(url => url.pathname === '/api/napams').length, 1);
  assert.deepEqual(sourceRecord, original);
});
test('combined inputs compare product and manufacturer and change or to +', async t => {
  const c = setup(); t.after(() => c.dom.window.close());
  await submit(c, { nrn: 'A2-5680', product: 'Cola', maker: 'Unrelated Company' });
  assert.match(c.document.getElementById('comparison').textContent, /name you entered differs/);
  assert.match(c.document.getElementById('comparison').textContent, /manufacturer name differs/);
  c.document.getElementById('nrn').dispatchEvent(new c.dom.window.Event('input'));
  assert.equal(c.document.getElementById('choice-join').textContent, '+');
});
test('accepted JSON streams render complete results and classify truncated bodies as incomplete', async t => {
  for (const napamsState of ['stream_found', 'truncated_stream']) {
    const c = setup({ napamsState }); t.after(() => c.dom.window.close());
    await submit(c, { nrn: 'A2-5680' });
    assert.equal(c.document.getElementById('record-tag').textContent, napamsState === 'stream_found' ? 'Registration record found' : 'Check incomplete');
    if (napamsState === 'truncated_stream') {
      assert.equal(c.document.getElementById('record').hidden, true);
      assert.match(c.document.getElementById('record-message').textContent, /did not complete this lookup/);
      assert.doesNotMatch(c.document.getElementById('record-message').textContent, /Unexpected end|No matching record/);
    }
    assert.equal(c.requests.filter(url => url.pathname === '/api/napams').length, 1);
  }
});
test('CAPTCHA and missing backend produce incomplete, never not found', async t => {
  for (const napamsState of ['verification_required', 'missing']) {
    const c = setup({ napamsState }); t.after(() => c.dom.window.close());
    await submit(c, { nrn: 'A2-5680' });
    assert.equal(c.document.getElementById('record-tag').textContent, 'Check incomplete');
    assert.equal(c.document.getElementById('record').hidden, true);
    assert.doesNotMatch(c.document.getElementById('record-message').textContent, /No match|unregistered/);
    assert.equal(c.opened.length, 0);
    assert.equal(c.requests.filter(url => url.pathname === '/api/napams').length, 1);
  }
});
test('a gateway timeout is incomplete and does not claim the deployed backend is missing', async t => {
  const c = setup({ napamsState: 'gateway_timeout' }); t.after(() => c.dom.window.close());
  await submit(c, { nrn: 'A2-5680' });
  assert.equal(c.document.getElementById('record-tag').textContent, 'Check incomplete');
  const message = c.document.getElementById('record-message').textContent;
  assert.match(message, /did not complete this lookup/);
  assert.doesNotMatch(message, /unavailable on this deployment|No match|unregistered/);
  assert.equal(c.requests.filter(url => url.pathname === '/api/napams').length, 2);
});
test('one temporary gateway timeout recovers without an incomplete verdict', async t => {
  const c = setup({ napamsState: 'gateway_then_found' }); t.after(() => c.dom.window.close());
  await submit(c, { nrn: 'A2-5680' });
  assert.equal(c.document.getElementById('record-tag').textContent, 'Registration record found');
  assert.equal(c.requests.filter(url => url.pathname === '/api/napams').length, 2);
  assert.match(c.document.getElementById('record-name').textContent, /Profectiv/);
});
test('one explicit upstream timeout retries once and repeated timeouts remain incomplete', async t => {
  for (const napamsState of ['cold_then_found', 'upstream_timeout']) {
    const c = setup({ napamsState }); t.after(() => c.dom.window.close());
    await submit(c, { nrn: 'A2-5680' });
    assert.equal(c.document.getElementById('record-tag').textContent, napamsState === 'cold_then_found' ? 'Registration record found' : 'Check incomplete');
    assert.equal(c.requests.filter(url => url.pathname === '/api/napams').length, 2);
    if (napamsState === 'upstream_timeout') assert.equal(c.document.getElementById('record').hidden, true);
  }
});
test('NAPAMS fallback works after Greenbook failure; partial no-match stays incomplete', async t => {
  for (const napamsState of ['found', 'not_found']) {
    const c = setup({ greenFailure: true, napamsState }); t.after(() => c.dom.window.close());
    await submit(c, { nrn: 'A2-5680' });
    assert.equal(c.document.getElementById('record-tag').textContent, napamsState === 'found' ? 'Registration record found' : 'Check incomplete');
  }
});
test('explicit misses from both sources are distinguished from source failures', async t => {
  const c = setup({ greenRows: [], napamsState: 'not_found' }); t.after(() => c.dom.window.close());
  await submit(c, { nrn: 'A2-5680' });
  assert.equal(c.document.getElementById('record-tag').textContent, 'No matching record');
  assert.match(c.document.getElementById('record-message').textContent, /Neither Greenbook nor NAPAMS/);
});

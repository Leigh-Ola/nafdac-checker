import { lookupNapams } from '../../lib/napams-browser.mjs';
import { cleanNumber, validNumber, NAPAMS } from '../../lib/napams-result.mjs';

const json = (body, status = 200, cache = false) => Response.json(body, {
  status,
  headers: {
    'Cache-Control': cache ? 'public, max-age=0, must-revalidate' : 'no-store',
    'Netlify-CDN-Cache-Control': cache ? 'public, max-age=300, durable' : 'no-store',
    'Netlify-Vary': 'query=nrn',
    'X-Content-Type-Options': 'nosniff'
  }
});

// Exported factory lets tests verify the HTTP contract without driving or
// claiming to test a production browser. Only lookupNapams is used in production.
export function createHandler(lookup = lookupNapams, { streamAfterMs = 250, heartbeatMs = 5000 } = {}) {
  const recent = new Map();
  return async request => {
    if (request.method !== 'GET') return json({ state: 'error', code: 'method_not_allowed', message: 'Use GET.' }, 405);
    const number = cleanNumber(new URL(request.url).searchParams.get('nrn'));
    if (!validNumber(number)) return json({ state: 'error', code: 'invalid_number', message: 'Enter the registration number printed on the pack.' }, 400);
    const cached = recent.get(number);
    if (cached && Date.now() - cached.at < 300000) return json(cached.body, 200, true);
    recent.delete(number);
    const pending = (async () => { try {
      const body = await lookup(number);
      if (['found', 'not_found'].includes(body.state)) {
        if (recent.size >= 128) recent.delete(recent.keys().next().value);
        recent.set(number, { body, at: Date.now() });
      }
      return { body, status: 200, cache: true };
    } catch (error) {
      const code = error.code || 'upstream_unavailable';
      console.warn('NAPAMS lookup incomplete:', code);
      return { body: {
        state: 'unavailable', source: 'NAPAMS', sourceUrl: NAPAMS, code,
        message: code === 'verification_required'
          ? 'NAFDAC requires an interactive verification. The broader registration check could not finish here.'
          : 'NAFDAC’s broader registry could not complete this lookup. Try again later.',
        checkedAt: new Date().toISOString()
      }, status: 503, cache: false };
    } })();
    let timer;
    const immediate = await Promise.race([
      pending,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), streamAfterMs); })
    ]);
    clearTimeout(timer);
    if (immediate) return json(immediate.body, immediate.status, immediate.cache);

    // NAFDAC's form can outlast an idle gateway connection. Start an accepted
    // JSON response promptly and send harmless whitespace while it runs. The
    // final state still distinguishes a record, an explicit miss and a failure.
    // Pending responses are never cached; only completed source results are.
    const encoder = new TextEncoder();
    let heartbeat, cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('\n'));
        heartbeat = setInterval(() => { if (!cancelled) controller.enqueue(encoder.encode('\n')); }, heartbeatMs);
        void pending.then(result => {
          clearInterval(heartbeat);
          if (cancelled) return;
          controller.enqueue(encoder.encode(JSON.stringify(result.body)));
          controller.close();
        });
      },
      cancel() { cancelled = true; clearInterval(heartbeat); }
    });
    return new Response(stream, { status: 202, headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    } });
  };
}

export default createHandler();
export const config = {
  path: '/api/napams',
  nodeVersion: '22',
  // This project's live runtime stopped at 30 seconds even when 60 was requested.
  // The browser deadline returns an incomplete result before that cutoff.
  timeout: 30,
  rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ['ip', 'domain'] }
};

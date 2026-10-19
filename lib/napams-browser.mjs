import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NAPAMS, LookupError, parseNapamsResult } from './napams-result.mjs';

// Bundle the pinned official browser so a cold lookup does not need a network
// download before it can submit NAFDAC's form.
let lookupCount = 0;

export async function createLaunchOptions(executablePath) {
  return {
    executablePath,
    headless: 'shell',
    // Puppeteer 25 returns these arguments asynchronously.
    args: await puppeteer.defaultArgs({ args: chromium.args.filter(arg => !['--disable-web-security', '--allow-running-insecure-content'].includes(arg)), headless: 'shell' }),
    defaultViewport: { width: 1280, height: 900 },
    timeout: 15000
  };
}

export async function lookupNapams(number) {
  const startedAt = Date.now();
  const timing = { firstLookup: ++lookupCount === 1, browserBinaryCached: existsSync(join(tmpdir(), 'chromium')) };
  let browser, stopped = false, timer, stage = 'browser_binary';
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      if (browser) void browser.close().catch(() => {});
      reject(new LookupError('upstream_timeout', 'NAFDAC took too long to respond. This check is incomplete.'));
    }, 28000);
  });
  const work = async () => {
    const executablePath = process.env.CHROME_EXECUTABLE_PATH || await chromium.executablePath();
    timing.binaryReadyMs = Date.now() - startedAt;
    if (stopped) throw new LookupError('upstream_timeout', 'The lookup timed out.');
    stage = 'browser_launch';
    // Keep the browser's normal automation identity. No stealth, cookie/token
    // reuse, CAPTCHA solver or proxy rotation. Keep web security enabled.
    browser = await puppeteer.launch(await createLaunchOptions(executablePath));
    timing.browserReadyMs = Date.now() - startedAt;
    if (stopped) { await browser.close(); throw new LookupError('upstream_timeout', 'The lookup timed out.'); }
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    stage = 'upstream_navigation';
    const home = await page.goto(NAPAMS, { waitUntil: 'domcontentloaded', timeout: 18000 });
    timing.homeReadyMs = Date.now() - startedAt;
    if (!home?.ok()) {
      const error = new LookupError('upstream_unavailable', 'NAFDAC is temporarily unavailable.');
      error.upstreamStatus = home?.status() ?? null;
      throw error;
    }
    stage = 'form_submission';
    await page.waitForSelector('#CertificateNumber', { visible: true });
    await page.type('#CertificateNumber', number);
    await page.click('#verify-form button');

    // Use the published form, including its own cookies and scripts. Do not
    // construct a raw POST or obtain/replay a CAPTCHA token separately.
    stage = 'verification_result';
    try {
      await page.waitForFunction(() => {
        const modal = document.querySelector('#modalCenter');
        const visible = element => {
          if (!element) return false;
          const box = element.getBoundingClientRect(), css = getComputedStyle(element);
          return box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.display !== 'none';
        };
        if (visible(modal) && modal.innerText.trim()) return true;
        // Stop for a visible interactive reCAPTCHA challenge. Never interact
        // with the challenge or treat the invisible badge as a failure.
        return [...document.querySelectorAll('iframe')].some(frame =>
          visible(frame) && /recaptcha/i.test(frame.src) &&
          (/bframe/.test(frame.src) || /challenge/i.test(frame.title)) &&
          frame.getBoundingClientRect().height > 100
        );
      }, { timeout: 20000 });
    } catch (error) {
      if (error.name === 'TimeoutError') throw new LookupError('upstream_timeout', 'NAFDAC did not complete verification. Please try again later.');
      throw error;
    }
    const result = await page.evaluate(() => {
      const modal = document.querySelector('#modalCenter');
      if (!modal || getComputedStyle(modal).display === 'none' || getComputedStyle(modal).visibility === 'hidden') return '';
      return modal.innerText;
    });
    if (!result.trim()) throw new LookupError('verification_required', 'NAFDAC requires an interactive verification. This check is incomplete.');
    const parsed = parseNapamsResult(result, number);
    timing.state = parsed.state;
    return parsed;
  };
  try { return await Promise.race([work(), deadline]); }
  catch (error) {
    // Log diagnostic metadata only: no page content, cookies, CAPTCHA tokens,
    // user input, or exception messages containing upstream URLs.
    console.warn('NAPAMS browser diagnostic:', JSON.stringify({
      stage, errorName: error?.name || 'Error',
      upstreamStatus: error?.upstreamStatus ?? null
    }));
    throw error;
  }
  finally {
    // Timing metadata verifies the first browser download and lookup without
    // logging registration numbers, source content, cookies or tokens.
    console.info('NAPAMS lookup timing:', JSON.stringify({ ...timing, stage, durationMs: Date.now() - startedAt }));
    clearTimeout(timer);
    if (browser) await Promise.race([browser.close().catch(() => {}), new Promise(resolve => { const t = setTimeout(resolve, 500); t.unref?.(); })]);
  }
}

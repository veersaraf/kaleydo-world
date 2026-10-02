// The QR code's join page (http://<lan-ip>:<port>/join), in a headless phone:
//  - a phone that doesn't trust our CA gets the one-time setup, Continue says
//    "not yet", Skip explains Safari's warning and links to the https remote;
//  - a phone that trusts it (ignoreHTTPSErrors stands in for an installed,
//    trusted profile) goes straight on to the https remote, which runs.
//
//   BASE=http://localhost:4500 node scripts/e2e/join-page-test.mjs [shotDir]

import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const info = await (await fetch(BASE + '/api/info')).json();
if (!info.joinUrl) {
  console.log('no LAN address: skipping');
  process.exit(0);
}
console.log('join url:', info.joinUrl, '→', info.padUrl);
const joinUrl = info.joinUrl;
const httpsOrigin = new URL(info.padUrl).origin;

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const iPhoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const phoneCtx = (extra = {}) => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: iPhoneUA, ...extra });
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });

const browser = await launchChrome();

// ---------------------------------------------------------------- not trusted
{
  const ctx = await phoneCtx();
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !/ERR_CERT|net::|Failed to fetch|Failed to load resource/i.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(joinUrl);
  await shot(page, 'join-1-checking');
  await page.waitForSelector('#setup.on', { timeout: 8000 });
  check('an untrusting phone gets the setup', await page.isVisible('#setup.on'));
  await shot(page, 'join-2-setup');
  const href = await page.getAttribute('#dl', 'href');
  const prof = await fetch(new URL(href, joinUrl));
  check('the profile downloads as a configuration profile', prof.ok && prof.headers.get('content-type') === 'application/x-apple-aspen-config');
  await page.click('#cont');
  await page.waitForSelector('#notYet:not([hidden])', { timeout: 8000 });
  check('Continue re-checks and says "not yet"', await page.isVisible('#notYet'));
  await shot(page, 'join-3-not-yet');
  await page.click('#skip');
  check('Skip explains the warning', await page.isVisible('#skipped.on'));
  check('Skip goes to the https remote', (await page.getAttribute('#go', 'href')) === httpsOrigin + '/controller.html');
  await shot(page, 'join-4-skipped');
  // the next scan (skipped before): straight to the tap-through note
  await page.goto(joinUrl);
  await page.waitForSelector('#skipped.on', { timeout: 8000 });
  check('a phone that skipped before gets the tap-through note first', true);
  check('no script errors (CSP lets the page run)', !errors.length, errors.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- trusted
{
  const ctx = await phoneCtx({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(joinUrl);
  await page.waitForURL((u) => u.href.startsWith(httpsOrigin + '/controller.html'), { timeout: 10000 });
  check('a trusting phone goes straight to the https remote', true, page.url());
  await page.waitForSelector('.join-btn', { timeout: 15000 });
  check('the remote runs there (a secure context)', await page.evaluate(() => window.isSecureContext));
  await ctx.close();
}

// ---------------------------------------------------------------- the https remote, opened directly
{
  const ctx = await phoneCtx({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(httpsOrigin + '/c');
  await page.waitForSelector('.join-btn', { timeout: 15000 });
  check('the https remote works when opened directly', page.url().startsWith(httpsOrigin + '/controller.html'));
  await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

// Smoke test: the phone preview (src/tv/phone.ts). An iPhone-sized touch context opens the TV page: the loader says
// it's a preview, the match starts without menus, the pause button pauses it (Resume, or a tap outside the menu, goes
// back), taps timed to the ball (two for a serve) are swings, the pill is up, the match ends on the card with all its
// rows, Play again restarts. ?tv=1 on the phone and a desktop get the title.
//
//   BASE=http://localhost:3520 node scripts/e2e/phone-preview-e2e.mjs      (SHOTS=dir saves three screenshots)
import { launchChrome } from '../lib/chrome.mjs';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) fails++;
};

const browser = await launchChrome(['--use-angle=metal', '--autoplay-policy=no-user-gesture-required']);
const IPHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const errors = [];
const watch = (page, tag) => page.on('pageerror', (e) => errors.push(`[${tag}] ${e.message}`));

// ---------------------------------------------------------------- the phone
const ctx = await browser.newContext(IPHONE);
const page = await ctx.newPage();
watch(page, 'phone');
await page.goto(BASE + '/');
await page.waitForSelector('.boot-phone', { timeout: 15000 });
check((await page.textContent('.boot-phone')) === 'Phone preview · the full game plays on a laptop or TV', 'the loader says it is a preview');
check(await page.evaluate(() => document.documentElement.classList.contains('phone')), 'detected as a phone (coarse pointer, small screen)');
await page.waitForFunction(() => window.kaleido.match && !window.kaleido.attract, null, { timeout: 30000 });
check(!(await page.$('.screen')), 'the match starts with no title or menus');
check(await page.evaluate(() => window.kaleido.match.score.race === 3 && window.kaleido.match.players[0].name === 'You'), 'You vs CPU, first to 3');
check(await page.evaluate(() => !document.querySelector('.ph-pill').classList.contains('off')), 'the pill is up');
// pause: the button by the sound button; the menu; Resume, then a tap outside the menu
const pb = await page.evaluate(() => {
  const r = document.querySelector('.pausebtn').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, on: !document.querySelector('.pausebtn').classList.contains('off') };
});
check(pb.on && pb.w >= 44 && pb.h >= 44, 'the pause button is up, a 44 px target', `${pb.w}x${pb.h}`);
await page.touchscreen.tap(pb.x, pb.y);
await page.waitForSelector('.phpause', { timeout: 3000 });
await sleep(500);
const menu = await page.evaluate(() => ({ paused: window.kaleido.paused, items: [...document.querySelectorAll('.phpause .item > .txt > span:first-child')].map((e) => e.textContent) }));
check(menu.paused && ['Resume', 'Restart match', 'Send the link to my laptop', 'Open the full game here'].every((t) => menu.items.includes(t)) && menu.items.some((t) => t.startsWith('Sound')), 'it pauses, and the pause menu shows', menu.items.join(' | '));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/pause.png` });
await page.tap('.phpause .item:has-text("Resume")');
await page.waitForFunction(() => !document.querySelector('.screen') && !window.kaleido.paused, null, { timeout: 3000 });
check(true, 'Resume goes back to the match');
await page.touchscreen.tap(pb.x, pb.y);
await page.waitForSelector('.phpause', { timeout: 3000 });
await sleep(500);
await page.touchscreen.tap(195, 800);
await page.waitForFunction(() => !document.querySelector('.screen') && !window.kaleido.paused, null, { timeout: 3000 });
check(true, 'a tap outside the menu resumes too');
check(await page.evaluate(() => window.kaleido.quality.level <= 3), 'starts on a low quality rung', String(await page.evaluate(() => window.kaleido.quality.level)));
await page.evaluate(() => {
  window.__ev = [];
  const k = window.kaleido;
  const prev = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    window.__ev.push({ type: e.type, human: !!e.p?.human, serve: !!e.serve, perfect: !!e.perfect, why: e.why });
    prev(e);
  };
});

// play: tap to toss and tap at the top of the toss; in a rally, tap as the ball reaches the player
const tapAt = () => page.touchscreen.tap(195, 560);
let tosses = 0;
let rallyShot = false;
const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  const s = await page.evaluate(() => {
    const m = window.kaleido.match;
    const p = m.players[0];
    return { state: m.state, srv: m.server === p, tl: p.plan && !p.swing ? p.plan.t - m.t : null, toss: p.tossT >= 0 ? p.tossT + 0.78 - m.t : null, ts: window.kaleido.timeScale, card: !!document.querySelector('.phend') };
  });
  if (s.card) break;
  if (s.state === 'serve' && s.srv) {
    await sleep(500);
    await tapAt();
    tosses++;
    await sleep(150);
    continue;
  }
  if (s.state === 'toss' && s.srv && s.toss !== null) {
    if (s.toss > 0.03) await sleep(s.toss * 1000 - 30);
    await tapAt();
    await sleep(400);
    continue;
  }
  if (s.state === 'play' && s.tl !== null && s.tl < 0.7) {
    const wait = (s.tl / (s.ts || 1)) * 1000 - 30;
    if (wait > 0) await sleep(wait);
    await tapAt();
    if (!rallyShot && SHOTS) {
      rallyShot = true;
      await sleep(250);
      await page.screenshot({ path: `${SHOTS}/rally-pill.png` });
    }
    await sleep(300);
    continue;
  }
  await sleep(40);
}
const ev = await page.evaluate(() => window.__ev);
const mine = ev.filter((e) => e.type === 'hit' && e.human);
check(tosses > 0 && ev.some((e) => e.type === 'toss' && e.human), 'a tap tosses the serve', `${tosses} toss taps`);
check(mine.some((e) => e.serve), 'the next tap hits the serve');
check(mine.some((e) => !e.serve), 'taps in a rally are hits', `${mine.filter((e) => !e.serve).length} returns, ${mine.filter((e) => e.perfect).length} perfect, ${ev.filter((e) => e.type === 'whiff' && e.human).length} misses`);
check(await page.evaluate(() => window.kaleido.match.state === 'over'), 'the match ends', `${Math.round((Date.now() - t0) / 1000)} s of play`);
await page.waitForSelector('.phend', { timeout: 5000 });
await sleep(600);
const card = await page.evaluate(() => ({
  head: document.querySelector('.phend h2')?.textContent,
  btns: [...document.querySelectorAll('.phend .item > .txt > span:first-child, .phend button')].map((b) => b.textContent),
  code: !!document.querySelector('.ph-code'),
  full: document.querySelector('.ph-full')?.getAttribute('href'),
  fits: [...document.querySelectorAll('.phend .item, .phend button, .ph-code, .ph-full')].every((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.height >= 44;
  }),
}));
check(card.head === 'That was the taste.', 'the end card', card.head);
check(['Send the link to my laptop', 'Copy link', 'Play again', 'Join'].every((b) => card.btns.includes(b)) && card.code && card.full === '/?tv=1', 'with all its buttons', card.btns.join(' | '));
check(card.fits, 'all on screen, every target ≥ 44 px tall');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/end-card.png` });
const before = await page.evaluate(() => window.kaleido.match);
await page.tap('.phend .item:has-text("Play again")');
await page.waitForFunction(() => !document.querySelector('.phend') && window.kaleido.match.state !== 'over', null, { timeout: 5000 });
check(await page.evaluate((m) => window.kaleido.match !== m, before), 'Play again starts a new match');

// ---------------------------------------------------------------- ?tv=1 on the phone, and a desktop
const tvPage = await (await browser.newContext(IPHONE)).newPage();
watch(tvPage, 'phone ?tv=1');
await tvPage.goto(BASE + '/?tv=1');
await tvPage.waitForSelector('.screen.title', { timeout: 15000 });
check(!(await tvPage.evaluate(() => document.documentElement.classList.contains('phone'))), '?tv=1 loads the normal game on a phone');
const desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
watch(desk, 'desktop');
await desk.goto(BASE + '/');
await desk.waitForSelector('.screen.title', { timeout: 15000 });
check(!(await desk.$('.ph-pill')) && !(await desk.$('.boot-phone')), 'a desktop gets the normal title, no preview');
await sleep(1500);

check(errors.length === 0, 'no page errors', errors.join(' / '));
await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);

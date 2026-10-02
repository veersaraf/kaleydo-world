// What the remote's motion handler allocates: a sampling heap profile (CDP) of a few seconds of
// fake-phone motion (60 Hz devicemotion + deviceorientation) on the real remote page, counted by
// the allocating function in src/pad (the browser's own event objects are not JS allocations).
// Garbage on the phone means GC pauses, and on an iPhone a pause drops motion events.
//   BASE=http://localhost:3390 node scripts/perf/perf-pad-alloc.mjs [menu|bowl|duel] [seconds]
import { launchChrome } from '../lib/chrome.mjs';
import { phone } from '../lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3000';
const where = process.argv[2] || 'menu';
const secs = +(process.argv[3] || 10);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });

const padCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await padCtx.addInitScript(phone);
const pad = await padCtx.newPage();
await pad.goto(BASE + '/controller.html?auto');
await tv.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 });
await wait(1600);
if (where === 'bowl') {
  await tv.evaluate(() => window.flow.beginBowling('park', -1));
  await pad.waitForSelector('.panel.bowl.on', { timeout: 15000 });
} else if (where === 'duel') {
  await tv.evaluate(() => window.flow.beginDuel('park', 0.3));
  await pad.waitForSelector('.panel.sword.on', { timeout: 15000 });
}
// (a slow wiggle so the detectors have something to look at)
await pad.evaluate(() => window.__phone.hold?.({ top: [0.3, 0.9, 0.2], screen: [0, 0, 1], ms: 600 }));
// (long enough for the JIT to take over: unoptimized code boxes every number it computes)
await wait(+(process.env.WARM || 12) * 1000);

const cdp = await padCtx.newCDPSession(pad);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await pad.evaluate(() => {
  window.__motionCount = 0;
  addEventListener('devicemotion', () => window.__motionCount++);
});
await wait(secs * 1000);
const events = await pad.evaluate(() => window.__motionCount);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const by = new Map();
let total = 0;
(function walk(n) {
  const u = n.callFrame.url;
  if (n.selfSize && u.includes('/src/pad/')) {
    const key = `${n.callFrame.functionName || '(anon)'} ${u.split('/').pop().split('?')[0]}`;
    by.set(key, (by.get(key) || 0) + n.selfSize);
    total += n.selfSize;
  }
  n.children.forEach(walk);
})(profile.head);
console.log(`remote page in ${where}: ${(total / 1024).toFixed(1)} KB allocated by src/pad code over ${secs} s, ${events} motion events → ${((total * 1) / Math.max(1, events)).toFixed(0)} bytes per motion event`);
for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${(v / 1024).toFixed(1).padStart(8)} KB  ${k}`);
await browser.close();

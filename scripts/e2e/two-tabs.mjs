// Opens the TV and a phone remote (forced HTTP transport) side by side and checks they talk.
import { launchChrome, outDir } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const browser = await launchChrome(['--use-angle=metal', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const tv = await ctx.newPage();
const logs = [];
tv.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push('[tv ' + m.type() + '] ' + m.text()); });
tv.on('pageerror', (e) => logs.push('[tv pageerror] ' + e.message));
await tv.goto(BASE + '/');
await tv.waitForTimeout(1500);
await tv.mouse.click(600, 400); // title -> menu (+ unlock audio)
await tv.waitForTimeout(600);
const pad = await ctx.newPage();
pad.on('console', (m) => { if (m.type() === 'error') logs.push('[pad error] ' + m.text()); });
pad.on('pageerror', (e) => logs.push('[pad pageerror] ' + e.message));
await pad.setViewportSize({ width: 390, height: 844 });
await pad.goto(BASE + '/controller.html?transport=http&auto');
await pad.waitForTimeout(2500);
const padState = await pad.evaluate(() => ({ badge: document.querySelector('.badge')?.textContent, net: document.querySelector('.net b')?.textContent, mode: [...document.querySelectorAll('.panel.on')].map((e) => e.className) }));
const seats = await tv.evaluate(() => window.kaleido.input.seats.map((s) => s && { slot: s.slot, name: s.name, transport: s.transport, connected: s.connected }));
// press A on the pad (menu -> quick match setup)
await pad.evaluate(() => { const a = document.querySelector('.a-btn'); a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); a.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });
await tv.waitForTimeout(800);
const screen1 = await tv.evaluate(() => document.querySelector('.screen:not(.leaving) h2')?.textContent || document.querySelector('.screen:not(.leaving)')?.className);
// audio state + trigger some sounds
const audio = await tv.evaluate(() => { const f = window.flow; return { ctx: f.audio?.engine.ctx.state, song: f.audio?.music.song?.id }; });
await pad.screenshot({ path: outDir('two-tabs') + '/pad-menu.png' });
console.log(JSON.stringify({ padState, seats, screen1, audio }, null, 1));
console.log(logs.join('\n'));
await browser.close();

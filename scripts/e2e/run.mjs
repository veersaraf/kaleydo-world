// Runs the browser end-to-end tests against a server it starts itself, then stops the server.
//
//   npm run test:e2e                 the reliable phone-to-TV tests, against `server/server.mjs --dev`
//   npm run test:cloud               the Cloudflare worker (vite build + `wrangler dev`): cloud, rooms, quick match
//   node scripts/e2e/run.mjs bowl    only the tests whose name contains "bowl"
//   node scripts/e2e/run.mjs --list  show the tests
//
// Options / environment:
//   --verbose, -v      print every test's output, not only the failures' (also E2E_VERBOSE=1)
//   E2E_RETRIES=1      run a failed test once more before calling it failed (CI sets this)
//   E2E_TIMEOUT=240    seconds one test may take (default 240)
//   CHROME_PATH=...    drive this Chrome / Chromium instead of the installed Google Chrome
//   HEADED=1           show the browser windows
//
// The tests drive the real Google Chrome with playwright-core (a simulated phone — scripts/lib/fake-phone.mjs —
// against the TV page), so Chrome has to be installed. Each test reads BASE from the environment.
// Known flaky, kept out of the default list (run them by name): duel-phone-e2e, capture-e2e, doubles-net-e2e
// (the last judges a handful of swings per run and fails now and then on timing).

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (...names) => args.some((a) => names.includes(a));
const cloud = flag('--cloud');
const verbose = flag('--verbose', '-v') || !!process.env.E2E_VERBOSE;
const filters = args.filter((a) => !a.startsWith('-'));
const RETRIES = Number(process.env.E2E_RETRIES || 0);
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT || 240) * 1000;

/** [file, what it checks] */
const DEV_TESTS = [
  ['e2e-swing.mjs', 'a phone swings in the Swing Lab: swing-start before swing, feints, the next swing is unhurt'],
  ['bowl-phone-e2e.mjs', 'a phone bowls: grip, backswing, release, cancel, pause'],
  ['archery-phone-e2e.mjs', 'a phone draws and looses a bow'],
  ['baseball-phone-e2e.mjs', 'a phone bats: the TV times the swing right'],
  ['smash-phone-e2e.mjs', 'a phone smashes'],
  ['demo-e2e.mjs', 'the first-serve demo: a new player is shown the game by their own character'],
];
const CLOUD_TESTS = [
  ['cloud-e2e.mjs', 'the cloud worker end to end: a TV and a phone over the relay'],
  ['room-e2e.mjs', 'online rooms: guest TVs join by code'],
  ['mm-e2e.mjs', 'quick match: two TVs are paired by the lobby'],
];
let tests = cloud ? CLOUD_TESTS : DEV_TESTS;

if (flag('--list')) {
  for (const [f, what] of tests) console.log(`${f.padEnd(24)} ${what}`);
  process.exit(0);
}
if (filters.length) {
  const all = [...DEV_TESTS, ...CLOUD_TESTS, ['duel-phone-e2e.mjs', 'flaky'], ['capture-e2e.mjs', 'flaky'], ['doubles-net-e2e.mjs', 'flaky']];
  tests = all.filter(([f]) => filters.some((x) => f.includes(x)));
  if (!tests.length) {
    console.error(`no test matches ${filters.join(', ')} (see --list)`);
    process.exit(1);
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Spawn in its own process group, so one kill takes `npx wrangler` and its workerd with it. */
function start(cmd, cmdArgs, env) {
  const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const log = [];
  const keep = (b) => {
    log.push(String(b));
    if (log.length > 400) log.splice(0, 100);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.exited = new Promise((r) => child.once('exit', (code) => r(code ?? 1)));
  child.log = () => log.join('');
  child.stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const done = await Promise.race([child.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]);
    if (!done) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  };
  return child;
}

async function waitFor(url, child, seconds = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    if (child.exitCode !== null) throw new Error(`the server exited (code ${child.exitCode}) before it was up:\n${child.log()}`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`nothing answered at ${url} after ${seconds} s:\n${child.log()}`);
}

function run(file, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('scripts/e2e', file)], { cwd: ROOT, env: { ...process.env, BASE: base }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const out = [];
    child.stdout.on('data', (b) => out.push(String(b)));
    child.stderr.on('data', (b) => out.push(String(b)));
    const timer = setTimeout(() => {
      out.push(`\n[run.mjs] timed out after ${TIMEOUT_MS / 1000} s\n`);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? signal, output: out.join('') });
    });
  });
}

const servers = [];
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  await Promise.all(servers.map((s) => s.stop()));
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup().then(() => process.exit(130)));

async function main() {
  // Chrome first: a missing browser should say so in a second, not after a build.
  const probe = await launchChrome([]);
  await probe.close();

  let base;
  if (cloud) {
    console.log('building (vite build) ...');
    const build = start('npx', ['vite', 'build'], {});
    servers.push(build);
    if ((await build.exited) !== 0) throw new Error('vite build failed:\n' + build.log());
    const port = await freePort();
    const wr = start('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], { CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' });
    servers.push(wr);
    base = `http://127.0.0.1:${port}`;
    console.log(`wrangler dev on ${base} ...`);
    await waitFor(base + '/', wr, 180);
  } else {
    const [port, httpsPort, hmrPort] = [await freePort(), await freePort(), await freePort()];
    const srv = start('node', ['server/server.mjs', '--dev'], { PORT: String(port), HTTPS_PORT: String(httpsPort), HMR_PORT: String(hmrPort) });
    servers.push(srv);
    base = `http://127.0.0.1:${port}`;
    console.log(`dev server on ${base} ...`);
    await waitFor(base + '/api/info', srv, 60);
  }

  const results = [];
  for (const [file] of tests) {
    const t0 = Date.now();
    let r = await run(file, base);
    let tries = 1;
    while (!r.ok && tries <= RETRIES) {
      console.log(`  ... ${file} failed, retrying (${tries}/${RETRIES})`);
      if (verbose) process.stdout.write(r.output);
      r = await run(file, base);
      tries++;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ file, ok: r.ok, secs, tries });
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${file.padEnd(24)} ${secs.padStart(6)} s${tries > 1 ? `  (attempt ${tries})` : ''}`);
    if (!r.ok || verbose) {
      const text = r.output.trimEnd();
      console.log(text.split('\n').map((l) => '    ' + l).join('\n') + '\n');
      if (!r.ok) console.log(`    exit: ${r.code}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed${failed.length ? '; failed: ' + failed.map((f) => f.file).join(', ') : ''}`);
  return failed.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error('\n' + (e && e.message ? e.message : e));
} finally {
  await cleanup();
}
process.exit(code);

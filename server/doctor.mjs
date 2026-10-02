#!/usr/bin/env node
// Kaleydo World doctor: `npm run doctor` (or `node server/doctor.mjs`).
//
// Checks what running the game on this computer needs, one line each with a fix:
// Node's version, the installed packages, the build (offers to make it), the two
// ports, the network address phones will use (and whether it looks like Wi-Fi),
// the firewall (macOS), the local certificates, and prints the address the QR
// code opens. Exits 1 if anything is broken.
//
//   --build   build without asking if there's no build
//   PORT / HTTPS_PORT   the ports to check (default 3000 / 3443, as the server)

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { X509Certificate } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lanInterfaces } from './lan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const CERTS = path.join(ROOT, 'server', '.certs');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint('32'), red = paint('31'), yellow = paint('33'), dim = paint('2'), bold = paint('1'), cyan = paint('36');

let problems = 0;
let warnings = 0;
function ok(what, detail = '') {
  console.log(`  ${green('✓')} ${what}${detail ? '  ' + dim(detail) : ''}`);
}
function bad(what, fix) {
  problems++;
  console.log(`  ${red('✗')} ${what}`);
  if (fix) console.log(`      ${dim('fix:')} ${fix}`);
}
function warn(what, fix) {
  warnings++;
  console.log(`  ${yellow('!')} ${what}`);
  if (fix) console.log(`      ${dim('tip:')} ${fix}`);
}
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
  } catch {
    return '';
  }
};

console.log(`\n  ${bold('K A L E Y D O   W O R L D')}   ${dim('doctor')}\n`);

// ---------------------------------------------------------------- Node

{
  const [maj, min] = process.versions.node.split('.').map(Number);
  // (Vite needs ^20.19 or >= 22.12; Wrangler, for the Cloudflare commands, >= 22)
  const viteOK = (maj === 20 && min >= 19) || (maj === 22 && min >= 12) || maj >= 23;
  if (!viteOK) bad(`Node ${process.versions.node} is too old`, 'install Node 22 or newer (https://nodejs.org, or `nvm install 22`)');
  else if (maj < 22) warn(`Node ${process.versions.node}: fine for playing; the Cloudflare commands (cloud:dev, cloud:deploy) need 22+`, 'install Node 22 or newer when you want to host it online');
  else ok(`Node ${process.versions.node}`);
}

// ---------------------------------------------------------------- packages

const installed = fs.existsSync(path.join(ROOT, 'node_modules', 'vite', 'package.json')) && fs.existsSync(path.join(ROOT, 'node_modules', 'qrcode', 'package.json'));
if (installed) ok('packages installed');
else bad('packages are not installed', 'npm install');

// ---------------------------------------------------------------- build

const built = () => fs.existsSync(path.join(ROOT, 'dist', 'index.html')) && fs.existsSync(path.join(ROOT, 'dist', 'controller.html'));
if (built()) {
  const age = (Date.now() - fs.statSync(path.join(ROOT, 'dist', 'index.html')).mtimeMs) / 86400000;
  ok('game is built', `dist/, ${age < 1 ? 'today' : `${Math.floor(age)} day${age >= 2 ? 's' : ''} ago`} (npm start rebuilds it every time)`);
} else if (!installed) {
  bad('game is not built yet', 'npm install, then npm start (it builds, then serves)');
} else {
  let build = process.argv.includes('--build');
  if (!build && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`  ${yellow('?')} The game isn't built yet (no dist/). Build it now with npm run build? [Y/n] `)).trim().toLowerCase();
    rl.close();
    build = a === '' || a.startsWith('y');
  }
  if (build) {
    console.log(dim('\n  npm run build …\n'));
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    console.log('');
    if (r.status === 0 && built()) ok('game is built', 'dist/');
    else bad('the build failed (see above)', 'fix the error, or run npm run build to see it again');
  } else bad('game is not built yet', 'npm run build (npm start builds it for you)');
}

// ---------------------------------------------------------------- ports

/** a port is free if we can listen on it the way the server does (all interfaces) */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : e.code === 'EACCES' ? 'denied' : true));
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}

/** who is listening on a port: "node (pid 123)", or '' if we can't tell */
function whoListens(port) {
  if (process.platform === 'win32') {
    const line = run('netstat', ['-ano', '-p', 'tcp']).split('\n').find((l) => new RegExp(`:${port}\\s.*LISTENING`).test(l));
    const pid = line?.trim().split(/\s+/).pop();
    if (!pid) return '';
    const name = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).split(',')[0]?.replace(/"/g, '');
    return `${name || 'a program'} (pid ${pid})`;
  }
  const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).trim().split('\n').slice(1);
  if (!out.length || !out[0]) return '';
  const [cmd, pid] = out[0].split(/\s+/);
  return `${cmd} (pid ${pid})`;
}

/** is it Kaleydo World itself that's already running there? */
async function isKaleydo(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(1500) });
    const j = await res.json();
    return 'joinUrl' in j;
  } catch {
    return false;
  }
}

/** the pid of a Kaleydo World already serving the screen port (its https port is then fine to be taken) */
let kaleydoPid = '';
for (const [port, label, env] of [
  [HTTP_PORT, 'screen, http', 'PORT'],
  [HTTPS_PORT, 'phones, https', 'HTTPS_PORT'],
]) {
  const free = await portFree(port);
  if (free === true) ok(`port ${port} is free`, label);
  else if (free === 'denied') bad(`port ${port} needs special permission on this system`, `use a port above 1024: ${env}=${port === HTTP_PORT ? 3100 : 3543} npm start`);
  else if (port === HTTP_PORT && (await isKaleydo(port))) {
    kaleydoPid = whoListens(port).match(/pid (\d+)/)?.[1] ?? '?';
    warn(`port ${port} is taken by Kaleydo World itself: it's already running`, `open http://localhost:${port}, or stop the other copy (Ctrl+C in its terminal)`);
  } else {
    const who = whoListens(port);
    const pid = who.match(/pid (\d+)/)?.[1];
    if (pid && pid === kaleydoPid) {
      ok(`port ${port} is the running Kaleydo World's too`, label);
      continue;
    }
    bad(
      `port ${port} (${label}) is in use${who ? ` by ${who}` : ''}`,
      `${pid ? `stop it (${process.platform === 'win32' ? `taskkill /PID ${pid}` : `kill ${pid}`}), or ` : ''}start on other ports: PORT=3100 HTTPS_PORT=3543 npm start`,
    );
  }
}

// ---------------------------------------------------------------- network

function isWifi(name) {
  if (process.platform === 'darwin') {
    // "Hardware Port: Wi-Fi\nDevice: en0"
    const ports = run('networksetup', ['-listallhardwareports']);
    const m = ports.split(/\n\s*\n/).find((b) => new RegExp(`Device: ${name}\\b`).test(b));
    if (!m) return null;
    return /Hardware Port: (Wi-Fi|AirPort)/i.test(m);
  }
  if (process.platform === 'linux') {
    if (fs.existsSync(`/sys/class/net/${name}/wireless`) || /^wl/.test(name)) return true;
    if (/^(eth|en)/.test(name)) return false;
    return null;
  }
  if (process.platform === 'win32') return /wi-?fi|wireless|wlan/i.test(name) ? true : /ethernet/i.test(name) ? false : null;
  return null;
}

const isPrivate = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
const isVpn = (name) => /^(utun|tun|tap|wg|ppp|ipsec|tailscale|zt)/i.test(name);

const ifaces = lanInterfaces();
const primary = ifaces[0];
let joinUrl = null;
if (!primary) {
  bad('no network address: this computer is not on a network', 'connect to the Wi-Fi your phone is on, then run this again');
} else {
  joinUrl = `http://${primary.address}:${HTTP_PORT}/join`;
  const wifi = isWifi(primary.name);
  if (isVpn(primary.name)) warn(`phones would reach this computer at ${primary.address} (${primary.name}), which looks like a VPN`, 'connect to Wi-Fi, or turn the VPN off');
  else if (wifi === true) ok(`on Wi-Fi at ${primary.address}`, primary.name);
  else if (wifi === false) ok(`on a wired network at ${primary.address}`, `${primary.name}: fine if your phone's Wi-Fi is on the same router`);
  else ok(`on the network at ${primary.address}`, primary.name);
  if (!isPrivate(primary.address) && !isVpn(primary.name))
    warn(`${primary.address} isn't a usual home-network address`, 'if the phone can\'t connect: a guest or office Wi-Fi may keep devices apart, use a home network or a phone hotspot');
  const vpns = ifaces.filter((f) => f !== primary && isVpn(f.name));
  if (vpns.length) warn(`a VPN looks active (${vpns.map((v) => `${v.name} ${v.address}`).join(', ')})`, 'if the phone can\'t connect, turn the VPN off on this computer and on the phone');
}

// ---------------------------------------------------------------- firewall (macOS)

if (process.platform === 'darwin') {
  const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw';
  const state = run(fw, ['--getglobalstate']);
  const blockAll = run(fw, ['--getblockall']);
  if (/enabled/i.test(blockAll) && !/disabled/i.test(blockAll)) bad('the macOS firewall blocks all incoming connections: phones can\'t reach the game', 'System Settings → Network → Firewall → Options → turn off "Block all incoming connections"');
  else if (/enabled/i.test(state)) ok('macOS firewall is on', 'when macOS asks whether node may accept incoming connections, choose Allow');
  else if (state) ok('macOS firewall is off');
}

// ---------------------------------------------------------------- certificates

{
  const f = (n) => path.join(CERTS, n);
  const have = ['ca.crt', 'ca.key', 'leaf.crt', 'leaf.key'].map((n) => fs.existsSync(f(n)));
  if (have.every((x) => !x)) ok('certificates: none yet', 'the first npm start makes them (a local CA and a certificate for this address)');
  else if (!have.every(Boolean)) bad('certificates are incomplete (server/.certs)', 'delete server/.certs and start again: they are remade (phones that installed the old profile need the new one)');
  else {
    try {
      const ca = new X509Certificate(fs.readFileSync(f('ca.crt')));
      const leaf = new X509Certificate(fs.readFileSync(f('leaf.crt')));
      const cn = ca.subject.match(/CN=([^\n]+)/)?.[1] ?? 'local CA';
      const caLeft = (new Date(ca.validTo).getTime() - Date.now()) / 86400000;
      const leafLeft = (new Date(leaf.validTo).getTime() - Date.now()) / 86400000;
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(f('leaf.json'), 'utf8'));
      } catch {}
      if (caLeft < 0) bad(`the local CA "${cn}" has expired`, 'delete server/.certs and start again (then reinstall the profile on phones that had it)');
      else if (primary && meta && !meta.ips?.includes(primary.address))
        ok(`certificates: "${cn}"`, `made for another network; npm start remakes the address certificate for ${primary.address} by itself (the CA, and any phone's trust in it, stays)`);
      else if (leafLeft < 30) ok(`certificates: "${cn}"`, 'the address certificate is renewed by itself on the next start');
      else ok(`certificates: "${cn}"`, `valid until ${new Date(leaf.validTo).toISOString().slice(0, 10)}`);
    } catch {
      bad('certificates in server/.certs can\'t be read', 'delete server/.certs and start again');
    }
  }
}

// ---------------------------------------------------------------- summary

console.log('');
if (joinUrl) {
  console.log(`  ${bold('Screen')}   ${cyan(`http://localhost:${HTTP_PORT}`)}   ${dim('open on this computer')}`);
  console.log(`  ${bold('Phones')}   ${cyan(joinUrl)}   ${dim('what the QR code opens (same Wi-Fi)')}`);
  console.log('');
}
if (problems) console.log(`  ${red(`${problems} problem${problems > 1 ? 's' : ''}`)} to fix${warnings ? `, ${warnings} thing${warnings > 1 ? 's' : ''} to keep in mind` : ''}. More help: README.md → Troubleshooting\n`);
else if (kaleydoPid) console.log(`  ${green('All set.')} Kaleydo World is already running: open ${bold(`http://localhost:${HTTP_PORT}`)} and scan the QR code.\n`);
else console.log(`  ${green('All set.')} ${warnings ? `(${warnings} thing${warnings > 1 ? 's' : ''} to keep in mind.) ` : ''}Run ${bold('npm start')} and scan the QR code.\n`);
process.exit(problems ? 1 : 0);

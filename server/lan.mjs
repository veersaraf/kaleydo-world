// This machine's addresses on the local network, best first, and how to open a
// page in its browser. Shared by server.mjs and doctor.mjs.

import os from 'node:os';
import { exec } from 'node:child_process';

/** How likely an interface is to be the Wi-Fi / Ethernet the phones are on (lower = better). */
export function interfaceRank(name) {
  return name.startsWith('en') ? 0 : name.startsWith('eth') || name.startsWith('wl') ? 1 : name.startsWith('bridge') ? 3 : name.startsWith('utun') ? 5 : 2;
}

/** IPv4 LAN interfaces, best first: [{ name, address }] (no loopback, no link-local 169.254.x). */
export function lanInterfaces() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      found.push({ name, address: a.address });
    }
  }
  found.sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name));
  return found;
}

/** The LAN IPv4 addresses, best first. */
export function lanIPs() {
  return lanInterfaces().map((f) => f.address);
}

/** Open a URL in the default browser (macOS, Linux, Windows); quietly does nothing if that fails. */
export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

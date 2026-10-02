// Shared browser launcher for the end-to-end, perf and screenshot scripts.
//
//   import { launchChrome, BASE } from '../lib/chrome.mjs';
//   const browser = await launchChrome(['--autoplay-policy=no-user-gesture-required']);
//
// The scripts drive the real Google Chrome (playwright-core's `chrome` channel), headless.
// Pass the flags you need; the GPU flags are made platform-aware here:
//
//   macOS    `--use-angle=metal` stays (a real GPU)
//   Linux    `--use-angle=metal` becomes ANGLE on SwiftShader (software WebGL, what CI has), and
//            --no-sandbox (containers / CI runners)
//   Windows  `--use-angle=metal` becomes `--use-angle=d3d11`
//
// Environment:
//   CHROME_PATH   use this Chrome / Chromium binary instead of the installed `chrome` channel
//                 (CHROME_BIN is accepted too)
//   HEADED=1      show the window

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

/** Where the game is served (npm run dev: http://localhost:3000). */
export const BASE = process.env.BASE || 'http://localhost:3000';

export function platformArgs(args) {
  const out = [];
  for (const a of args) {
    if (a !== '--use-angle=metal') out.push(a);
    else if (process.platform === 'darwin') out.push(a);
    else if (process.platform === 'win32') out.push('--use-angle=d3d11');
  }
  if (process.platform === 'linux') {
    // Software WebGL is the only WebGL a CI runner has, whether or not the caller asked for the GPU.
    for (const a of ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox']) {
      if (!out.includes(a)) out.push(a);
    }
  }
  return out;
}

export async function launchChrome(args = [], opts = {}) {
  const executablePath = process.env.CHROME_PATH || process.env.CHROME_BIN || undefined;
  try {
    return await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: 'chrome' }),
      headless: !process.env.HEADED,
      ...opts,
      args: platformArgs(args),
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/not found|Executable doesn't exist|ENOENT|distribution/i.test(msg)) {
      console.error(
        '\nGoogle Chrome was not found. These scripts drive the real Chrome (playwright-core, channel "chrome").\n' +
          '  Install Google Chrome (https://www.google.com/chrome/), or point CHROME_PATH at a Chrome/Chromium binary:\n' +
          '    CHROME_PATH="/path/to/chrome" npm run test:e2e\n',
      );
      process.exit(1);
    }
    throw e;
  }
}

/**
 * Where a script writes its screenshots: the directory given as the first argument, else
 * `shots/<name>` (git-ignored) when `inRepo`, else a folder in the system temp dir. Created if missing.
 */
export function outDir(name, { inRepo = false, arg = process.argv[2] } = {}) {
  const dir = arg ? path.resolve(arg) : inRepo ? path.resolve('shots', name) : path.join(os.tmpdir(), 'kaleydo-' + name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

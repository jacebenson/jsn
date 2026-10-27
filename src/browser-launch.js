import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readBrowserSession } from './browser-auth.js';
import { normalizeInstanceURL } from './config.js';
import { errAuth, errUsage } from './errors.js';

const BROWSERS = [
  { name: 'Chromium', value: 'chromium', binaries: ['chromium', 'chromium-browser'] },
  { name: 'Google Chrome', value: 'chrome', binaries: ['google-chrome', 'google-chrome-stable', 'chrome'] },
  { name: 'Microsoft Edge', value: 'edge', binaries: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'] },
];

export async function findBrowsers({ platform = process.platform, env = process.env } = {}) {
  const found = [];
  for (const browser of BROWSERS) {
    const candidates = [];
    for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const binary of browser.binaries) candidates.push(path.join(dir, binary + (platform === 'win32' ? '.exe' : '')));
    }
    if (platform === 'darwin') {
      const app = { chromium: 'Chromium.app/Contents/MacOS/Chromium', chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome', edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }[browser.value];
      candidates.push(path.join('/Applications', app), path.join(os.homedir(), 'Applications', app));
    }
    if (platform === 'win32') {
      const app = { chromium: 'Chromium/Application/chrome.exe', chrome: 'Google/Chrome/Application/chrome.exe', edge: 'Microsoft/Edge/Application/msedge.exe' }[browser.value];
      for (const dir of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) candidates.push(path.join(dir, app));
    }
    for (const executable of candidates) {
      try {
        await fs.access(executable, fs.constants.X_OK);
        if (!(await fs.stat(executable)).isFile()) continue;
        found.push({ name: browser.name, value: browser.value, executable });
        break;
      } catch { /* Try another installation location. */ }
    }
  }
  return found;
}

export async function chooseBrowser({ browserName, interactive = false } = {}) {
  if (browserName && !BROWSERS.some(browser => browser.value === browserName)) {
    throw errUsage('Choose chromium, chrome, or edge with --browser-name. Firefox login is not supported yet.');
  }
  const browsers = await findBrowsers();
  if (browserName) {
    const browser = browsers.find(browser => browser.value === browserName);
    if (!browser) throw errUsage(`The selected browser (${browserName}) was not found. Install it or choose another browser.`);
    return browser;
  }
  if (!browsers.length) throw errUsage('No supported browser found. Install Chrome/Chromium or Edge, or use --gck to paste a browser request. Firefox login is not supported yet.');
  if (!interactive || browsers.length === 1) return browsers[0];
  const { select } = await import('@inquirer/prompts');
  const selected = await select({ message: 'Log in using which browser?', choices: browsers });
  return browsers.find(browser => browser.value === selected);
}

// Each login gets a fresh browser profile and an OS-assigned debugging port.
// Neither the user's regular browser nor a previous login account is reused.
export async function launchBrowserSession(instance, {
  browser, verify = async credentials => credentials, timeout = 300000,
  onProgress = () => {}, spawnBrowser = spawn, signal,
} = {}) {
  if (!browser?.executable) throw errUsage('Select an installed browser before login.');
  const origin = normalizeInstanceURL(instance);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-browser-login-'));
  await fs.chmod(directory, 0o700);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let child;
  let exited = false;
  let launchFailed = false;
  let closed = Promise.resolve();
  let lastCheck = '';
  const deadline = Date.now() + timeout;
  try {
    if (controller.signal.aborted) throw errAuth('Browser login cancelled.');
    child = spawnBrowser(browser.executable, [
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${directory}`, '--no-first-run', '--no-default-browser-check',
      '--new-window', origin,
    ], { stdio: 'ignore' });
    closed = new Promise(resolve => {
      child.once('error', () => { launchFailed = true; exited = true; resolve(); });
      child.once('close', () => { exited = true; resolve(); });
    });
    onProgress(`Opening ${browser.name}. Log in to ServiceNow in the new window; JSN will continue automatically.`);
    let browserUrl;
    while (Date.now() < deadline) {
      if (controller.signal.aborted) throw errAuth('Browser login cancelled.');
      if (exited) throw errAuth(launchFailed ? 'Could not launch the selected browser.' : 'The login window was closed before authentication completed.');
      if (!browserUrl) {
        try {
          const port = (await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
          if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536) browserUrl = `http://127.0.0.1:${port}`;
        } catch { /* Browser is still starting. */ }
      }
      if (browserUrl) {
        try {
          const credentials = await readBrowserSession(origin, { browserUrl, timeout: Math.min(2000, Math.max(1, deadline - Date.now())) });
          if (controller.signal.aborted) throw errAuth('Browser login cancelled.');
          const verified = await verify(credentials, {
            signal: controller.signal, timeout: Math.min(5000, Math.max(1, deadline - Date.now())),
          });
          if (controller.signal.aborted) throw errAuth('Browser login cancelled.');
          return verified;
        } catch (error) {
          if (controller.signal.aborted) throw errAuth('Browser login cancelled.');
          if (!error.browserLoginPending) throw error;
          lastCheck = error.message;
        }
      }
      try { await delay(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal: controller.signal }); } catch { throw errAuth('Browser login cancelled.'); }
    }
    throw errAuth(`Timed out waiting for browser login. ${lastCheck || 'Run browser login again when ready.'}`);
  } finally {
    process.removeListener('SIGINT', cancel);
    signal?.removeEventListener('abort', cancel);
    if (child && !exited) {
      child.kill();
      await Promise.race([closed, delay(2000, undefined, { ref: false })]);
      if (!exited) { child.kill('SIGKILL'); await Promise.race([closed, delay(1000, undefined, { ref: false })]); }
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

import { it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let readSession;
let ownedChild;
let closedGracefully;
let closeFails = false;
mock.module('../src/browser-auth.js', {
  namedExports: {
    readBrowserSession: (...args) => readSession(...args),
    closeLoginBrowser: async () => {
      if (closeFails) throw new Error('Close unavailable');
      closedGracefully = true; ownedChild.emit('close', 0);
    },
  },
});
const { launchBrowserSession, findBrowsers, chooseBrowser, browserCandidates } = await import('../src/browser-launch.js');
const browser = { name: 'Chromium', executable: '/fixture/chromium' };
const instance = 'https://fixture.service-now.com';
const credentials = { auth_method: 'gck', access_token: 'fixture', cookies: 'sid=fixture', auth_source: 'gck' };
let directory;
let killed;
const roots = [];

function spawnFixture(_executable, args, options) {
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(_executable, browser.executable);
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.equal(args.at(-1), instance);
  directory = args.find(arg => arg.startsWith('--user-data-dir=')).split('=')[1];
  fs.writeFileSync(path.join(directory, 'DevToolsActivePort'), '12345\r\n/devtools/browser/fixture');
  killed = false;
  closedGracefully = false;
  const child = new EventEmitter();
  ownedChild = child;
  child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', 0)); };
  return child;
}

afterEach(() => {
  closeFails = false;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('finds installed browsers from executables without launching or reading profiles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-browser-discovery-'));
  roots.push(root);
  for (const executable of ['chromium', 'google-chrome']) fs.writeFileSync(path.join(root, executable), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const browsers = await findBrowsers({ platform: 'linux', env: { PATH: root } });
  assert.deepEqual(browsers.map(browser => browser.value), ['chromium', 'chrome']);
  await assert.rejects(chooseBrowser({ browserName: 'firefox' }), /Firefox login is not supported/);
});

it('launches a fresh browser, waits for login, verifies, and cleans up only its own browser', async () => {
  let reads = 0;
  readSession = async (origin, { browserUrl }) => {
    assert.equal(origin, instance);
    assert.equal(browserUrl, 'http://127.0.0.1:12345');
    if (++reads === 1) throw Object.assign(new Error('Waiting for login'), { browserLoginPending: true });
    return credentials;
  };
  let verified = false;
  const result = await launchBrowserSession(instance, {
    browser, spawnBrowser: spawnFixture,
    verify: async creds => { verified = true; return { ...creds, username: 'limited' }; },
  });
  assert.equal(result.username, 'limited');
  assert.equal(verified, true);
  assert.equal(reads, 2);
  assert.equal(killed || closedGracefully, true);
  assert.equal(fs.existsSync(directory), false);
});

it('does not treat a guest session as completed login', async () => {
  let verifications = 0;
  readSession = async () => credentials;
  await launchBrowserSession(instance, {
    browser, spawnBrowser: spawnFixture,
    verify: async creds => {
      if (++verifications === 1) throw Object.assign(new Error('Guest session'), { browserLoginPending: true });
      return creds;
    },
  });
  assert.equal(verifications, 2);
  assert.equal(killed || closedGracefully, true);
});

it('fails account mismatches immediately and removes the temporary profile', async () => {
  readSession = async () => credentials;
  await assert.rejects(launchBrowserSession(instance, {
    browser, spawnBrowser: spawnFixture,
    verify: async () => { throw new Error('Account mismatch'); },
  }), /Account mismatch/);
  assert.equal(killed || closedGracefully, true);
  assert.equal(fs.existsSync(directory), false);
});

it('times out with a useful verification reason and cleans up', async () => {
  readSession = async () => { throw Object.assign(new Error('Current-user API access unavailable'), { browserLoginPending: true }); };
  await assert.rejects(launchBrowserSession(instance, { browser, spawnBrowser: spawnFixture, timeout: 30 }), /Timed out.*Current-user API access/);
  assert.equal(killed || closedGracefully, true);
  assert.equal(fs.existsSync(directory), false);
});

it('cancels login without retaining the temporary browser profile', async () => {
  const controller = new AbortController();
  readSession = async () => {
    controller.abort();
    throw Object.assign(new Error('Waiting'), { browserLoginPending: true });
  };
  await assert.rejects(launchBrowserSession(instance, { browser, spawnBrowser: spawnFixture, signal: controller.signal }), /cancelled/);
  assert.equal(killed || closedGracefully, true);
  assert.equal(fs.existsSync(directory), false);
});

it('reports browser launch failure and cleans up', async () => {
  await assert.rejects(launchBrowserSession(instance, {
    browser,
    spawnBrowser: () => { throw new Error('Executable could not start'); },
  }), /Executable could not start/);
});

it('does not return credentials if cancelled during account verification', async () => {
  const controller = new AbortController();
  readSession = async () => credentials;
  await assert.rejects(launchBrowserSession(instance, {
    browser, spawnBrowser: spawnFixture, signal: controller.signal,
    verify: async creds => { controller.abort(); return creds; },
  }), /cancelled/);
  assert.equal(killed || closedGracefully, true);
  assert.equal(fs.existsSync(directory), false);
});


it('generates Windows paths with semicolon PATH, mixed-case env, and spaces', () => {
  const env = {
    Path: 'C:\\Tools;"D:\\Browser Tools"',
    ProgramW6432: 'C:\\Program Files',
    ProgramFiles: 'C:\\Program Files (x86)',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\Test User\\AppData\\Local',
  };
  const candidates = browserCandidates({ platform: 'win32', env });
  const chrome = candidates.find(browser => browser.value === 'chrome').candidates;
  assert.ok(chrome.includes('C:\\Tools\\chrome.exe'));
  assert.ok(chrome.includes('D:\\Browser Tools\\chrome.exe'));
  assert.ok(chrome.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(chrome.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(chrome.includes('C:\\Users\\Test User\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
  assert.equal(chrome.filter(p => p.includes('Program Files (x86)')).length, 1);
  const edge = candidates.find(browser => browser.value === 'edge').candidates;
  assert.ok(edge.includes('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
});

it('requests graceful browser shutdown before forcing process termination', async () => {
  readSession = async () => credentials;
  await launchBrowserSession(instance, { browser, spawnBrowser: spawnFixture });
  assert.equal(closedGracefully, true);
  assert.equal(killed, false);
  assert.equal(fs.existsSync(directory), false);
});

it('passes an executable path with spaces directly, without shell quotes', async () => {
  readSession = async () => credentials;
  const executable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  await launchBrowserSession(instance, {
    browser: { ...browser, executable },
    spawnBrowser: (command, args, options) => {
      assert.equal(command, executable);
      assert.equal(options.shell, false);
      assert.equal(options.windowsVerbatimArguments, undefined);
      assert.ok(args.some(arg => arg.startsWith('--user-data-dir=') && !arg.includes('"')));
      return spawnFixture(browser.executable, args, options);
    },
  });
});

// Deterministic browser acquisition for real setup PTYs. Never launch a host
// browser or inspect its profile; verification/storage still use the real auth
// workflow against the test's isolated loopback server.
import fs from 'node:fs/promises';
import { browserCandidates } from '../../src/browser-launch.js';
import { AuthManager } from '../../src/auth.js';
const candidates = browserCandidates();
const paths = new Set(candidates.flatMap(browser => browser.candidates));
const access = fs.access.bind(fs);
const stat = fs.stat.bind(fs);
fs.access = async (filename, ...args) => {
  if (!paths.has(filename)) return access(filename, ...args);
  if (candidates.some(browser => browser.value === 'chrome' && browser.candidates[0] === filename)) return;
  throw Object.assign(new Error('No fixture browser'), { code: 'ENOENT' });
};
fs.stat = async (filename, ...args) => paths.has(filename) ? { isFile: () => true } : stat(filename, ...args);
AuthManager.prototype.loginWithBrowser = function (instance, _options, username) {
  if (!instance.startsWith('http://127.0.0.1:')) throw new Error('Browser fixture requires loopback');
  return this.loginWithGck(instance, `Cookie: sid=offline-fixture\nX-UserToken: ${'a'.repeat(32)}`, username);
};

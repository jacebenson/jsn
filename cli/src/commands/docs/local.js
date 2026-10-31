import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../../errors.js';
import { configuredDocsService, docsServiceUrl } from './client.js';
import os from 'node:os';

function storageDirectory() { return path.join(process.env.JSN_DATA_HOME || path.join(os.homedir(), '.jsn'), 'docs-service'); }
async function healthy(state) {
  try {
    const url = new URL(state.url);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return false;
    process.kill(state.pid, 0);
    const response = await fetch(new URL('up', url), { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).service === 'jsn-docs';
  } catch { return false; }
}
export async function ensureLocalDocumentation({ storage = storageDirectory() } = {}) {
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  const stateFile = path.join(storage, 'server.json'), lock = path.join(storage, 'server-start.lock');
  const state = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  if (await healthy(state())) return state();
  let acquired = false;
  for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); acquired = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await healthy(state())) return state();
      try {
        const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        if (pid) process.kill(pid, 0);
        else if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch (probe) { if (probe.code === 'ESRCH') fs.rmSync(lock, { recursive: true, force: true }); }
      await delay(100);
    }
  }
  if (!acquired) throw new AppError('network_error', 'The local documentation service is still starting. Try again shortly.');
  let child;
  try {
    if (await healthy(state())) return state();
    const log = fs.openSync(path.join(storage, 'server.log'), 'a', 0o600);
    try {
      child = fork(fileURLToPath(new URL('./server.js', import.meta.url)), [], { detached: true, execArgv: [],
        env: { ...process.env, DOCS_STORAGE_DIR: storage, JSN_DOCS_HOST: '127.0.0.1', JSN_DOCS_PORT: '0' }, stdio: ['ignore', log, log, 'ipc'] });
    } finally { fs.closeSync(log); }
    const next = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out starting the documentation server.')); }, 10_000);
      child.once('message', message => { clearTimeout(timer); resolve(message); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('The documentation server stopped before it was ready.')); });
    });
    if (!await healthy(next)) throw new Error('Local documentation server did not become healthy.');
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600 });
    fs.renameSync(stateFile + '.tmp', stateFile);
    child.unref();
    return next;
  } catch (error) {
    child?.kill();
    throw new AppError('network_error', 'Could not start the local documentation service.', error.message);
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export async function documentationService(config = {}) {
  if (process.env.JSN_DOCS_URL) return docsServiceUrl(process.env.JSN_DOCS_URL);
  if (config.docs?.source === 'local') return (await ensureLocalDocumentation()).url;
  return configuredDocsService(config);
}

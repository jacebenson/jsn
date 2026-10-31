import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DocumentationIndex, documentationStatus } from './index.js';

export function serviceStorage() { return process.env.DOCS_STORAGE_DIR || path.join(process.env.JSN_DATA_HOME || path.join(os.homedir(), '.jsn'), 'docs-service'); }
export async function startDocumentationServer({ storage = serviceStorage(), host = '127.0.0.1', port = 0, refresh = true } = {}) {
  fs.mkdirSync(storage, { recursive: true });
  let worker;
  const server = http.createServer((req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'GET') return send(405, { error: 'Use GET.' });
    let index;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/up') return send(200, { service: 'jsn-docs' });
      if (url.pathname === '/api/docs/status') return send(200, documentationStatus(storage));
      if (!['/api/docs/search', '/api/docs/document'].includes(url.pathname) && !/^\/api\/docs\/\d{1,18}$/.test(url.pathname)) return send(404, { error: 'Not found.' });
      index = new DocumentationIndex(storage);
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === '/api/docs/search') return send(200, index.search({ query: params.q, limit: params.limit ?? 20, offset: params.offset ?? 0, bundle: params.bundle }));
      const revision = index.revision();
      if (params.revision && params.revision !== revision) return send(409, { error: 'Documentation has changed. Search again or retrieve by exact path.' });
      return send(200, { revision, document: index.document({ path: params.path, id: url.pathname.split('/').at(-1) }) });
    } catch (error) { send(error.status || 503, { error: error.status ? error.message : 'Documentation search is temporarily unavailable.' }); }
    finally { index?.close(); }
  });
  function checkForUpdates() {
    if (worker) return;
    const status = documentationStatus(storage);
    const elapsed = Date.now() - Date.parse(status.checkedAt || 0);
    if (elapsed < (status.state === 'ready' ? 24 : 1) * 3600_000) return;
    const log = fs.openSync(path.join(storage, 'sync.log'), 'a', 0o600);
    try {
      worker = fork(fileURLToPath(new URL('./sync-service.js', import.meta.url)), [], {
        env: { ...process.env, DOCS_STORAGE_DIR: storage }, stdio: ['ignore', log, log, 'ipc'], execArgv: [],
      });
      worker.on('exit', () => { worker = null; });
      worker.on('error', () => { worker = null; });
    } finally { fs.closeSync(log); }
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const interval = refresh ? setInterval(checkForUpdates, 60_000) : null;
  interval?.unref();
  if (refresh) checkForUpdates();
  server.on('close', () => { clearInterval(interval); worker?.kill('SIGTERM'); });
  const address = server.address();
  return { server, url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}/` };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { server, url } = await startDocumentationServer({ host: process.env.JSN_DOCS_HOST || '127.0.0.1', port: Number(process.env.JSN_DOCS_PORT || 0) });
    if (process.send) { process.send({ url, pid: process.pid }); process.disconnect(); }
    else process.stdout.write(`Documentation service listening at ${url}\n`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); });
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

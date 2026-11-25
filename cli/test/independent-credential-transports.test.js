import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AmbClient } from '../src/amb.js';
import { validateMidCredentials } from '../src/midserver-install.js';

async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => { s.closeAllConnections(); return new Promise(resolve => s.close(resolve)); });
  return `http://127.0.0.1:${s.address().port}`;
}
const session = () => ({ cookies: 'JSESSIONID=synthetic-cookie', userToken: 'synthetic-token' });

test('AMB handshake/connect and MID validation reject redirects before reaching sink', async t => {
  let sinkRequests = 0;
  const sink = await server(t, (req, res) => { sinkRequests++; res.end('{}'); });
  let redirectHandshake = true;
  let status = 307;
  let originRequests = 0;
  const origin = await server(t, (req, res) => {
    originRequests++;
    if (!redirectHandshake && req.url === '/amb/handshake') {
      res.setHeader('Content-Type', 'application/json');
      res.end('[{"channel":"/meta/handshake","successful":true,"clientId":"synthetic-client"}]');
      return;
    }
    res.writeHead(status, { Location: `${sink}/capture` }); res.end();
  });
  for (status of [301, 302, 303, 307, 308]) {
    redirectHandshake = true;
    const client = new AmbClient({ baseUrl: origin, session });
    let before = originRequests;
    await assert.rejects(() => client.start());
    assert.equal(originRequests, before + 1);
    assert.equal(sinkRequests, 0, `AMB handshake ${status}`);
    redirectHandshake = false;
    await client.start();
    before = originRequests;
    await assert.rejects(() => client.next());
    assert.equal(originRequests, before + 1);
    assert.equal(sinkRequests, 0, `AMB connect ${status}`);
    before = originRequests;
    await assert.rejects(() => validateMidCredentials(origin, 'synthetic-user', 'synthetic-password'));
    assert.equal(originRequests, before + 1);
    assert.equal(sinkRequests, 0, `MID validation ${status}`);
  }
});

test('AMB public baseUrl/path cannot switch a credential session to another origin', async t => {
  let sinkRequests = 0;
  let sessions = 0;
  const sink = await server(t, (req, res) => { sinkRequests++; res.end('{}'); });
  const provideSession = () => { sessions++; return session(); };
  const origin = await server(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('[{"channel":"/meta/handshake","successful":true,"clientId":"synthetic-client"}]');
  });
  const client = new AmbClient({ baseUrl: origin, session: provideSession });
  await client.start();
  client.baseUrl = sink;
  await assert.rejects(() => client.next(), /outside the configured instance origin/);
  await assert.rejects(() => client.start(), /outside the configured instance origin/);
  assert.equal(sessions, 1, 'changed baseUrl rejected before another session acquisition');
  for (const path of [`//${new URL(sink).host}/amb`, `${sink}/amb`, '/\\attacker.invalid/amb', '/amb?redirect=//attacker.invalid', '/amb#fragment']) {
    const target = new AmbClient({ baseUrl: origin, session: provideSession });
    target.path = path;
    await assert.rejects(() => target.start(), /instance-local route/);
  }
  assert.equal(sessions, 1, 'hostile public paths rejected before credential acquisition');
  assert.equal(sinkRequests, 0);
  assert.throws(() => new AmbClient({ baseUrl: origin, path: `${sink}/amb`, session: provideSession }), /instance-local route/);
  const hostileInitialPath = new AmbClient({ baseUrl: origin, path: `//${new URL(sink).host}/amb`, session: provideSession });
  await assert.rejects(() => hostileInitialPath.start(), /instance-local route/);
  assert.equal(sinkRequests, 0);
  for (const baseUrl of [`http://trusted.invalid@${new URL(sink).host}`, 'http://legacy.invalid']) {
    assert.throws(() => new AmbClient({ baseUrl, session: provideSession }), /credential destination|HTTPS/);
  }
});

test('MID rejects insecure or userinfo-confused destinations before any transport call', async () => {
  let requests = 0;
  const fetchImpl = () => { requests++; throw new Error('must not fetch'); };
  for (const destination of ['http://legacy.invalid', 'https://trusted.invalid@attacker.invalid']) {
    await assert.rejects(() => validateMidCredentials(destination, 'synthetic-user', 'synthetic-password', fetchImpl), /HTTPS|Invalid credential destination/);
  }
  assert.equal(requests, 0);
});

test('trusted loopback AMB and MID authentication still succeed', async t => {
  const captured = [];
  const origin = await server(t, async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    captured.push({ path: req.url, headers: req.headers, text });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/amb/handshake') res.end('[{"channel":"/meta/handshake","successful":true,"clientId":"synthetic-client"}]');
    else if (req.url === '/amb/connect') res.end('[{"channel":"/meta/connect","successful":true}]');
    else res.end('{"result":[{"value":"synthetic-release"}]}');
  });
  const client = new AmbClient({ baseUrl: origin, session });
  assert.equal((await client.start()).clientId, 'synthetic-client');
  assert.deepEqual(await client.next(), []);
  assert.equal(captured[0].headers['x-usertoken'], 'synthetic-token');
  assert.equal(captured[1].headers.cookie, 'JSESSIONID=synthetic-cookie');
  assert.deepEqual(await validateMidCredentials(origin, 'synthetic-user', 'synthetic-password'), { releaseName: 'synthetic-release' });
  assert.equal(captured[2].headers.authorization, `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`);
});

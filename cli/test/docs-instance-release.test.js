import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { familyFromWar, newestFamily, chooseDocsRelease } from '../src/commands/docs/instance-release.js';

const WAR = 'glide-brazil-08-25-2026__patch2-10-22-2026_11-03-2026_2245.zip';
const DAY = 24 * 3600_000;

// Isolated cache, a recording service fetch and a fake app whose SDK records each instance read.
function fixture(t, { releases = ['australia', 'brazil'], unpublished = [], war = WAR, instance = 'https://fixture.service-now.com', config = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-docs-instance-'));
  const saved = { fetch: globalThis.fetch, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, JSN_DOCS_URL: process.env.JSN_DOCS_URL, JSN_DATA_HOME: process.env.JSN_DATA_HOME };
  process.env.XDG_CACHE_HOME = path.join(home, 'cache');
  process.env.JSN_DATA_HOME = home;
  process.env.JSN_DOCS_URL = 'https://docs.fixture.test/';
  t.after(() => {
    globalThis.fetch = saved.fetch;
    for (const key of ['XDG_CACHE_HOME', 'JSN_DOCS_URL', 'JSN_DATA_HOME']) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    fs.rmSync(home, { recursive: true, force: true });
  });
  const service = [], reads = [];
  globalThis.fetch = async input => {
    service.push(new URL(input));
    if (releases instanceof Error) throw releases;
    const rows = [...releases.map(release => ({ release, revision: 'r1' })), ...unpublished.map(release => ({ release, revision: null }))];
    return Response.json({ releases: rows.map(row => ({ ...row, state: 'current' })), default: releases[0] });
  };
  const sdk = {
    async listStrict(table, params, opts) {
      reads.push({ table, params, opts });
      if (war instanceof Error) throw war;
      return war === null ? [] : [{ value: war }];
    },
  };
  const app = { config, session: { instance, username: 'agent', profile: {} }, getSDKForProfile: () => sdk };
  return { app, sdk, service, reads };
}

test('familyFromWar reads the family from glide.war and nothing else', () => {
  assert.equal(familyFromWar(WAR), 'brazil');
  assert.equal(familyFromWar('glide-washingtondc-12-20-2023__patch7-hotfix1.zip'), 'washingtondc');
  for (const value of ['', undefined, null, 'brazil', 'glide-Brazil-08-25-2026.zip', 'glide--08.zip', 'other-brazil-08.zip', 'myglide-brazil-08-25-2026.zip']) assert.equal(familyFromWar(value), null, String(value));
});

test('newestFamily follows letter order round the circle, so australia follows zurich', () => {
  assert.equal(newestFamily(['australia']), 'australia');
  assert.equal(newestFamily(['australia', 'brazil']), 'brazil');
  assert.equal(newestFamily(['zurich', 'australia', 'brazil']), 'brazil');
  assert.equal(newestFamily(['yokohama', 'zurich', 'australia']), 'australia');
  assert.equal(newestFamily(['xanadu', 'yokohama', 'zurich']), 'zurich');
  assert.equal(newestFamily([]), null);
});

test('--release and docs.release win without reading the instance or listing families', async t => {
  const f = fixture(t, { config: { docs: { release: 'zurich' } } });
  assert.deepEqual(await chooseDocsRelease({ release: 'brazil' }, f.app), { release: 'brazil', source: 'flag' });
  assert.deepEqual(await chooseDocsRelease({}, f.app), { release: 'zurich', source: 'config' });
  await assert.rejects(chooseDocsRelease({ release: '../x' }, f.app), { code: 'usage_error' });
  assert.equal(f.reads.length, 0);
  assert.equal(f.service.length, 0);
});

test('the instance family is used when the docs have it, and read once a day per instance', async t => {
  const f = fixture(t);
  const now = Date.parse('2026-11-25T00:00:00Z');
  const chosen = await chooseDocsRelease({}, f.app, { now });
  assert.deepEqual(chosen, { release: 'brazil', source: 'instance', note: "the instance's release" });
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].table, 'sys_properties');
  assert.equal(f.reads[0].params.sysparm_query, 'name=glide.war');
  assert.ok(f.sdk.timeout <= 5000, 'a sleeping instance must not hold up a docs search');
  assert.equal(f.sdk.canInteract(), false, 'a docs search never asks for a sign-in or an MFA code');
  assert.equal(f.service[0].pathname, '/api/docs/releases');
  assert.deepEqual(await chooseDocsRelease({}, f.app, { now: now + DAY - 1 }), chosen);
  assert.equal(f.reads.length, 1);
  assert.equal(f.service.length, 1);
  await chooseDocsRelease({}, f.app, { now: now + DAY + 1 });
  assert.equal(f.reads.length, 2);
  assert.equal(f.service.length, 2);
  f.app.session.username = 'another';
  await chooseDocsRelease({}, f.app, { now: now + DAY + 1 });
  assert.equal(f.reads.length, 3, 'kept per profile');
});

test('a family the docs lack, or list before publishing, falls back to the newest they have and says why', async t => {
  const f = fixture(t, { releases: ['australia'], unpublished: ['brazil'] });
  assert.deepEqual(await chooseDocsRelease({}, f.app), { release: 'australia', source: 'fallback', note: 'the instance runs brazil; newest available' });
});

test('no profile, or a refused or unreadable glide.war, falls back to the newest family; only a timeout or lost connection is asked again', async t => {
  const none = fixture(t, { releases: ['zurich', 'australia', 'brazil'], instance: '' });
  assert.deepEqual(await chooseDocsRelease({}, none.app), { release: 'brazil', source: 'fallback', note: 'no instance profile; newest available' });
  assert.equal(none.reads.length, 0);
  for (const war of [Object.assign(new Error('Forbidden'), { status: 403 }), null, 'not-a-war']) {
    const f = fixture(t, { releases: ['zurich', 'australia'], war });
    assert.deepEqual(await chooseDocsRelease({}, f.app), { release: 'australia', source: 'fallback', note: "could not read the instance's release; newest available" });
    await chooseDocsRelease({}, f.app);
    assert.equal(f.reads.length, 1, 'an answer with no family is kept for the day');
  }
  for (const war of [Object.assign(new Error('Network error: Request timed out'), { code: 'network_error' }), new TypeError('fetch failed')]) {
    const offline = fixture(t, { war });
    assert.equal((await chooseDocsRelease({}, offline.app)).note, "could not read the instance's release; newest available");
    await chooseDocsRelease({}, offline.app);
    assert.equal(offline.reads.length, 2, `${war.message} is asked again on the next search`);
  }
});

test('an unreachable or malformed families list falls back to australia, and is not cached', async t => {
  const f = fixture(t, { releases: new Error('offline') });
  assert.deepEqual(await chooseDocsRelease({}, f.app), { release: 'australia', source: 'fallback', note: 'the instance runs brazil; newest available' });
  await chooseDocsRelease({}, f.app);
  assert.equal(f.service.length, 2);
  for (const releases of ['australia', [], [{ name: 'brazil' }, null], [{ release: 'brazil', revision: null }]]) {
    let calls = 0;
    globalThis.fetch = async () => (calls++, Response.json({ releases }));
    for (let n = 0; n < 2; n++) assert.equal((await chooseDocsRelease({}, f.app)).release, 'australia');
    assert.equal(calls, 2, `${JSON.stringify(releases)} is not kept`);
  }
});

test('local documentation lists installed families without asking the service', async t => {
  const f = fixture(t, { config: { docs: { source: 'local' } } });
  delete process.env.JSN_DOCS_URL;
  assert.deepEqual(await chooseDocsRelease({}, f.app), { release: 'australia', source: 'fallback', note: 'the instance runs brazil; newest available' });
  assert.equal(f.service.length, 0);
});

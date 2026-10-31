import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { yargs } from '../src/cli-adapter.js';
import { updateSetsCmd } from '../src/commands/updatesets.js';

async function run(args, app) {
  await yargs(['updatesets', ...args]).strictCommands().strictOptions()
    .option('json', { type: 'boolean' }).option('format', { type: 'string' })
    .command(updateSetsCmd(handler => argv => handler(argv, app)))
    .fail((message, error) => { throw error || new Error(message); }).parse();
}
function fixture(state = 'complete') {
  const records = [{ sys_id: 'a'.repeat(32), name: 'Digital Helpdesk 0.1.77', state, application: 'global' }];
  const writes = [], results = [];
  return { records, writes, results, app: { requireInstance: () => {}, ok: data => results.push(data), sdk: {
    list: async () => structuredClone(records),
    exportUpdateSet: async () => '<unload/>',
    get: async () => structuredClone(records[0]),
    update: async (table, id, data) => { writes.push({table,id,data}); Object.assign(records[0],data); },
  } } };
}

test('out-dir uses shared naming, preserves complete state, and refuses overwriting', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-export-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  const f=fixture();
  await run(['export',f.records[0].name,'--out-dir',dir,'--json'],f.app);
  assert.equal(f.results[0].out,path.join(dir,'Digital-Helpdesk-0.1.77.xml'));
  assert.equal(await fs.readFile(f.results[0].out,'utf8'),'<unload/>');
  await assert.rejects(run(['export',f.records[0].name,'--out-dir',dir],f.app),{code:'EEXIST'});
  assert.deepEqual(f.writes,[]); assert.equal(f.records[0].state,'complete');
});

test('conflicting export destinations fail before any instance access', async () => {
  const f=fixture(); f.app.requireInstance=()=>{throw new Error('must not access instance');};
  await assert.rejects(run(['export',f.records[0].name,'--out','a.xml','--stdout'],f.app),/Choose one/);
});

test('reopen explicitly changes only target state and verifies it', async () => {
  const f=fixture(); await run(['reopen',f.records[0].name],f.app);
  assert.deepEqual(f.writes,[{table:'sys_update_set',id:f.records[0].sys_id,data:{state:'in progress'}}]);
  assert.equal(f.results[0].state,'in progress');
});
for(const state of ['committed','in progress']) test(`reopen refuses ${state}`, async()=>{
  const f=fixture(state); await assert.rejects(run(['reopen',f.records[0].name],f.app),/Cannot reopen/); assert.deepEqual(f.writes,[]);
});

test('noninteractive import requests --yes without an upload or a misleading --force hint', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsn-import-confirm-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'empty-set.xml');
  await fs.writeFile(file,`<unload><sys_remote_update_set action="INSERT_OR_UPDATE"><sys_id>${'a'.repeat(32)}</sys_id><remote_sys_id>${'b'.repeat(32)}</remote_sys_id><name>Example</name><state>loaded</state></sys_remote_update_set></unload>`);
  const f=fixture(); f.app.getEffectiveInstance=()=> 'https://example.service-now.com';
  f.app.sdk.importUpdateSet=()=> {throw new Error('must not upload');};
  await assert.rejects(run(['import',file,'--json'],f.app), error => {
    assert.equal(error.code,'confirmation_required'); assert.match(error.hint,/--yes/); assert.doesNotMatch(error.hint,/--force/); return true;
  });
});

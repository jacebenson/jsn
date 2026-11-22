import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const id = n => String(n).padStart(32, '0');
const old = '2020-01-01 00:00:00';
const schemas = {
  upgrade_preview: ['name', 'target_version', 'state', 'sys_updated_on'],
  upgrade_preview_log: ['upgrade_preview', 'severity', 'priority', 'disposition', 'sys_updated_on'],
  clone_request: ['source_instance', 'target_instance', 'state', 'sys_updated_on'],
  clone_preserver: ['name', 'table', 'condition', 'sys_updated_on'],
  clone_exclusion: ['name', 'table', 'sys_updated_on'],
  sys_update_set: ['name', 'state', 'sys_updated_on'],
  sys_remote_update_set: ['name', 'state', 'sys_updated_on'],
};
const records = {
  upgrade_center_metadata: [{ sys_id: id(1), scheduled_version: '', upgrade_scheduled_on: '', end_of_life: '', near_end_of_life: '', sys_updated_on: old }],
  upgrade_preview_version: [{ sys_id: id(2), label: 'Fixture Family Patch 2', value: 'glide-fixture-patch2', upgrade_center_metadata: id(1), sys_updated_on: old }],
  sys_upgrade_history: [{ sys_id: id(3), from_version: 'glide-fixture-patch0', to_version: 'glide-fixture-patch1', upgrade_started: old, upgrade_finished: old, sys_updated_on: old }],
  sys_store_app: [
    { sys_id: id(4), name: 'Fixture Workflow', scope: 'x_fixture_workflow', version: '1.0', latest_version: '1.0', update_available: 'true', sys_updated_on: old },
    { sys_id: id(5), name: 'Fixture Portal', scope: 'x_fixture_portal', version: '1.0', latest_version: '2.0', update_available: 'false', sys_updated_on: old },
    { sys_id: id(6), name: 'Fixture Tasks', scope: 'x_fixture_tasks', version: '1.0', latest_version: '2.0', update_available: 'true', sys_updated_on: old },
  ],
  upgrade_preview: [{ sys_id: id(7), name: 'Fixture existing preview', target_version: 'glide-fixture-patch2', state: 'complete', sys_updated_on: old }],
  upgrade_preview_log: [{ sys_id: id(8), upgrade_preview: id(7), severity: 'provider-warning', priority: '2', disposition: 'requires_review', sys_updated_on: old }],
  sys_upgrade_history_log: [{ sys_id: id(9), file_name: 'sys_script_fixture', target_name: 'Fixture rule', disposition: '4', resolution_status: 'not_reviewed', upgrade_history: id(3), reason: 'fixture', changed: 'true', sys_mod_count: '1', sys_updated_on: old }],
  sys_db_object: ['clone_request', 'clone_preserver', 'clone_exclusion'].map((name, i) => ({ sys_id: id(10 + i), name, label: name, sys_updated_on: old })),
  clone_request: [{ sys_id: id(13), source_instance: 'fixture-source', target_instance: 'fixture-lower', state: 'complete', sys_updated_on: old }],
  clone_preserver: [{ sys_id: id(14), name: 'Fixture preservation', table: 'sys_update_set', condition: 'state=in progress', sys_updated_on: old }],
  clone_exclusion: [{ sys_id: id(15), name: 'Fixture exclusion', table: 'fixture_audit', sys_updated_on: old }],
  sys_atf_test_result: [{ sys_id: id(16), status: 'failed', first_failing_step: 'fixture-step', test: 'fixture-test', start_time: old, end_time: old, sys_created_on: old, sys_updated_on: old }],
  sys_atf_test_suite_result: [],
  sys_execution_tracker: [{ sys_id: id(17), type: 'instance_scan', state: '2', result: JSON.stringify({ result_id: id(18) }), sys_created_on: old, sys_updated_on: old }],
  scan_result: [{ sys_id: id(18), number: 'FIXTURE_SCAN', finding_count: '1' }],
  scan_check_execution: [{ sys_id: id(19), check: 'fixture-check', message: 'fixture execution', execution_time: '1' }],
  scan_finding: [{ sys_id: id(20), check: 'fixture-check', source_table: 'sys_script', source: 'fixture', finding_details: 'Fixture finding', count: '1' }],
  sys_update_set: [{ sys_id: id(21), name: 'Fixture preserved work', state: 'in progress', sys_updated_on: old }],
  sys_remote_update_set: [{ sys_id: id(22), name: 'Fixture retrieved work', state: 'loaded', sys_updated_on: old }],
};

export async function upgradeFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-upgrade-fixture-'));
  const requests = [], violations = [];
  async function server(lower = false) {
    const s = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), lower });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/angular.do' && req.method === 'POST') {
        res.setHeader('Set-Cookie', 'JSESSIONID=fixture; Path=/');
        res.setHeader('X-UserToken-Response', 'fixture-token');
        res.end('{}'); return;
      }
      const match = /^\/api\/now\/table\/([a-z_]+)(?:\/([0-9a-f]{32}))?$/.exec(url.pathname);
      if (req.method !== 'GET' || !match || !(match[1] in records || match[1] === 'sys_dictionary')) {
        violations.push({ method: req.method, path: url.pathname }); res.writeHead(405); res.end('{}'); return;
      }
      const [, table, recordId] = match;
      if (options.malformed === table) { res.end('{}'); return; }
      if (options.deny === table || options.error === table) { res.writeHead(options.deny === table ? 403 : 500); res.end('{"error":{"message":"fixture failure"}}'); return; }
      let rows = options.empty ? [] : (table === 'sys_store_app' && options.storeApps ? options.storeApps : records[table] || []);
      if (table === 'sys_dictionary') {
        const name = url.searchParams.get('sysparm_query')?.match(/^name=([a-z_]+)/)?.[1];
        rows = (options.noSchema ? [] : schemas[name] || []).map((element, i) => ({ sys_id: id(100 + i), name, element, reference: '', sys_updated_on: old }));
      }
      if (recordId) rows = rows.filter(row => row.sys_id === recordId);
      const offset = Number(url.searchParams.get('sysparm_offset') || 0);
      const limit = Number(url.searchParams.get('sysparm_limit') || rows.length);
      rows = rows.slice(offset, offset + limit);
      const fields = url.searchParams.get('sysparm_fields')?.split(',');
      if (fields) rows = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key) && key !== options.omitField)));
      res.end(JSON.stringify({ result: recordId ? rows[0] || null : rows }));
    });
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    return s;
  }
  const main = await server(), lower = await server(true);
  const origin = s => `http://127.0.0.1:${s.address().port}`;
  fs.mkdirSync(path.join(dir, 'config', 'servicenow'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'servicenow', 'config.json'), JSON.stringify({ profiles: {
    fixture: { instance_url: origin(main), username: 'fixture', read_only: true },
    lower: { instance_url: origin(lower), username: 'fixture', read_only: true },
  } }));
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'),
    JSN_DATA_HOME: path.join(dir, 'data'), JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1',
    JSN_NO_PROMPTS: '1', SN_USERNAME: 'fixture', SN_PASSWORD: 'fixture' };
  delete env.SERVICENOW_INSTANCE_URL;
  const binary = fileURLToPath(new URL('../../bin/jsn.js', import.meta.url));
  return { requests, violations, instance: origin(main),
    run: args => exec(process.execPath, [binary, ...args], { cwd: dir, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }),
    close: async () => { await Promise.all([main, lower].map(s => new Promise(resolve => s.close(resolve)))); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

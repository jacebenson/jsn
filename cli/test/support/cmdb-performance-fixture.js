import { baseArgv, collectHandlers, makeApp, ROOT, SERVER, CLUSTER, WEB, PARENT, SIB } from './cmdb-fixtures.js';

process.env.JSN_NO_VERSION_CHECK = '1';
process.env.JSN_NO_SKILL_CHECK = '1';

export const scenarios = {
  show: { command: 'show' },
  relationships: { depth: 2 },
  upstream: { depth: 2, direction: 'upstream' },
  filtered: { depth: 2, type: 'contains', class: 'server' },
  limited: { depth: 2, limit: 2 },
  failedHop: { depth: 3, failHop: SERVER },
  failedClass: { depth: 2, failClass: SERVER },
  failedRootOnce: { command: 'show', failRootOnce: true },
  failedRoot: { command: 'show', failHop: ROOT },
};

export async function runFixture({ command = 'relationships', failHop, failClass, failRootOnce, ...argv } = {}) {
  const ids = [ROOT, SERVER, CLUSTER, WEB, PARENT, SIB];
  const cis = new Map(ids.map((id, i) => [id, {
    sys_id: id, name: ['root', 'server', 'cluster', 'web', 'parent', 'sibling'][i],
    sys_class_name: ['cmdb_ci_app', 'cmdb_ci_server', 'cmdb_ci_cluster', 'cmdb_ci_web_server', 'cmdb_ci_cluster', 'cmdb_ci_server'][i],
  }]));
  // WEB is a dangling reference, so its class lookup returns no record.
  cis.delete(WEB);
  const ref = (id) => ({ value: id, display_value: cis.get(id)?.name || 'unknown-web' });
  const edge = (parent, child, type = 'Contains::Contained by') => ({ parent: ref(parent), child: ref(child), type: { display_value: type } });
  const edges = [
    edge(PARENT, ROOT), edge(ROOT, SERVER), edge(ROOT, WEB, 'Runs on::Runs'),
    edge(PARENT, SERVER), edge(PARENT, SIB), edge(SERVER, CLUSTER), edge(CLUSTER, ROOT),
    edge(ROOT, SERVER, 'Duplicate must not replace first type'), edge(ROOT, ROOT),
  ];
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let rootAttempts = 0;
  const sdk = {
    async list(table, params) {
      const query = params.get('sysparm_query');
      const fields = params.get('sysparm_fields');
      calls.push({ table, query, fields, limit: params.get('sysparm_limit') });
      if (table === 'cmdb_rel_ci') {
        const id = query.match(/^parent=([0-9a-f]+)\^ORchild=\1$/)?.[1];
        if (id === ROOT) rootAttempts++;
        if (id === failHop || (failRootOnce && id === ROOT && rootAttempts === 1)) throw new Error('relationship read denied');
        return edges.filter((r) => r.parent.value === id || r.child.value === id).slice(0, Number(params.get('sysparm_limit')));
      }
      if (table !== 'cmdb_ci') throw new Error(`unexpected table ${table}`);
      const id = query.slice('sys_id='.length);
      if (fields === 'sys_class_name') {
        active++;
        maxActive = Math.max(maxActive, active);
        // Reverse completion order within a chunk without wall-clock timing assertions.
        for (let i = 0; i <= ids.indexOf(id); i++) await new Promise((resolve) => setImmediate(resolve));
        active--;
        if (id === failClass) throw new Error('class read denied');
      }
      return cis.has(id) ? [structuredClone(cis.get(id))] : [];
    },
  };
  const app = makeApp(sdk);
  const handler = (await collectHandlers()).find((s) => command === 'show' ? s.command.startsWith('show ') : s.command === command);
  await handler.handler(baseArgv(app, argv));
  return { calls, maxActive, output: JSON.stringify(app.okCalls), rendered: app.okCalls[0].data._formatted };
}

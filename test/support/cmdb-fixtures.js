export const ROOT = 'a'.repeat(32);
export const SERVER = 'b'.repeat(32);
export const CLUSTER = 'c'.repeat(32);
export const WEB = 'd'.repeat(32);
export const PARENT = 'e'.repeat(32);
export const SIB = 'f'.repeat(32);

const CI_NAMES = {
  [ROOT]: 'app1',
  [SERVER]: 'server1',
  [CLUSTER]: 'cluster1',
  [WEB]: 'web1',
  [PARENT]: 'cluster-p',
  [SIB]: 'sib1',
};

function relRecord(parent, child, type = 'Runs on::Runs') {
  const sysID = (id) => ({
    display_value: CI_NAMES[id] || id,
    link: `https://example.service-now.com/api/now/table/cmdb_ci/${id}`,
    value: id,
  });
  return {
    parent: sysID(parent),
    child: sysID(child),
    type: { display_value: type, link: `https://example.service-now.com/api/now/table/cmdb_rel_type/${type}`, value: `rel_${type}` },
  };
}

/**
 * Build a fake sdk that serves a tiny graph:
 *   ROOT --Runs on--> SERVER --Contained by--> CLUSTER
 * plus one extra downstream child of ROOT (WEB) for direction filtering.
 * With `withSiblings`, ROOT gains a parent (PARENT) that also contains SIB,
 * so ROOT has parents + siblings for the show command.
 */
export function makeSDK({ withSiblings = false } = {}) {
  const cis = {
    [ROOT]: { sys_id: ROOT, name: 'app1', sys_class_name: 'cmdb_ci_app_server', operational_status: 'Operational', install_status: 'Installed' },
    [SERVER]: { sys_id: SERVER, name: 'server1', sys_class_name: 'cmdb_ci_server' },
    [CLUSTER]: { sys_id: CLUSTER, name: 'cluster1', sys_class_name: 'cmdb_ci_cluster' },
    [WEB]: { sys_id: WEB, name: 'web1', sys_class_name: 'cmdb_ci_web_server' },
  };
  const rels = {
    [ROOT]: [
      relRecord(ROOT, SERVER, 'Runs on::Runs'),
      relRecord(ROOT, WEB, 'Depends on::Depends on'),
    ],
    [SERVER]: [relRecord(CLUSTER, SERVER, 'Contained by::Contains')],
    [CLUSTER]: [],
    [WEB]: [],
  };
  if (withSiblings) {
    cis[PARENT] = { sys_id: PARENT, name: 'cluster-p', sys_class_name: 'cmdb_ci_cluster' };
    cis[SIB] = { sys_id: SIB, name: 'sib1', sys_class_name: 'cmdb_ci_server' };
    rels[PARENT] = [
      relRecord(PARENT, ROOT, 'Contains::Contained by'),
      relRecord(PARENT, SIB, 'Contains::Contained by'),
    ];
    rels[SIB] = [];
  }
  const listCalls = [];
  return {
    sdk: {
      async list(table, params) {
        listCalls.push({ table, query: params.get('sysparm_query'), fields: params.get('sysparm_fields'), limit: params.get('sysparm_limit'), display: params.get('sysparm_display_value') });
        if (table === 'cmdb_rel_ci') {
          const q = params.get('sysparm_query');
          const match = q.match(/^parent=([0-9a-f]+)\^ORchild=\1$/);
          if (match) {
            const id = match[1];
            // Real Table API semantics: any rel whose parent OR child matches.
            return Object.values(rels).flat().filter((r) => r.parent.value === id || r.child.value === id);
          }
          return [];
        }
        if (table === 'cmdb_ci') {
          const q = params.get('sysparm_query');
          if (!q) {
            const all = Object.values(cis);
            return all.slice(0, Number(params.get('sysparm_limit')) || 5);
          }
          if (q.startsWith('sys_id=')) {
            const id = q.slice('sys_id='.length);
            return cis[id] ? [cis[id]] : [];
          }
          if (q.startsWith('name=')) {
            const name = q.slice('name='.length);
            const rows = Object.values(cis).filter((c) => c.name === name);
            return rows.slice(0, Number(params.get('sysparm_limit')) || 5);
          }
          return [];
        }
        return [];
      },
      async aggregateCount() {
        return 42;
      },
    },
    listCalls,
  };
}

export function makeApp(sdk) {
  return {
    sdk,
    okCalls: [],
    requireInstance() {},
    output: { getFormat: () => 'auto' },
    getEffectiveInstance() {
      return 'https://example.service-now.com';
    },
    ok(data, opts) {
      this.okCalls.push({ data, opts });
    },
  };
}

export function collectHandlers() {
  return import('../../src/commands/cmdb.js').then(({ cmdbCmd }) => {
    const wrap = (fn) => async (argv) => { await fn(argv, argv.app); };
    const cmd = cmdbCmd(wrap);
    const subcommands = [];
    const mockYargs = {
      command: (c) => {
        subcommands.push(typeof c === 'object' ? c : { command: c });
        return mockYargs;
      },
    };
    cmd.builder(mockYargs);
    return subcommands;
  });
}

export function baseArgv(app, overrides = {}) {
  return {
    ci: ROOT,
    direction: 'both',
    depth: 3,
    type: undefined,
    class: undefined,
    impact: false,
    limit: 100,
    app,
    ...overrides,
  };
}

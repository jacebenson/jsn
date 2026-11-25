import { deferredFamilyDefinition } from '../command-families.js';

// Easter egg: hidden from help and discover, so agents never meet it.

const SWEEP = [
  ['incident', 'active=true', 'Open incidents awaiting reinvention'],
  ['v_transaction', '', 'Transactions running right now'],
  ['sys_audit_delete', 'sys_created_on>=javascript:gs.beginningOfToday()', 'Records deleted today'],
];

const TOWER = [
  '        _|_          jsn tower',
  '    ___/___\\___      The AI control tower for business reinvention,',
  '   | [] [] [] |      now broadcasting from your terminal.',
  '    \\_________/',
  '       |   |         Inspired by the AI Control Tower. Powered by No Assist.',
  '       |   |         Superintelligence: not included.',
  '    ___|___|___',
];

/** Three Stats API counts, never row reads. A count that fails is lost, never 0. */
export async function sweepTower(sdk) {
  const radar = [];
  for (const [table, query, label] of SWEEP) {
    try {
      // sdk.aggregateCount turns an unreadable answer into 0; read stats.count strictly instead.
      const count = (await sdk.aggregate(table, { query }))?.stats?.count;
      if (!/^\d+$/.test(String(count))) throw new Error('No count in the Stats API response');
      radar.push({ table, query, label, status: 'tracked', count: Number(count) });
    } catch (error) {
      radar.push({ table, query, label, status: 'lost', count: null, error: error?.message || String(error), ...(error?.hint ? { hint: error.hint } : {}) });
    }
  }
  return radar;
}

const signOff = kill => kill ? 'Business paused. 0 records changed.' : 'Business reinvented. 0 records changed.';

export function formatTower({ instance, radar, kill_switch: kill }) {
  const lines = [...TOWER, ''];
  if (kill) lines.push('KILL SWITCH ENGAGED. Radar powered down, no requests sent.', 'Otto the autopilot has been stopped.');
  else if (!instance) lines.push('Radar sweep: no instance in range. The radar is empty.', 'Run: jsn setup');
  else {
    lines.push(`Radar sweep: ${instance}`);
    for (const blip of radar) {
      const reading = blip.status === 'tracked' ? String(blip.count) : `lost from the radar (${blip.error})`;
      lines.push(`  ${blip.status === 'tracked' ? '((o))' : '( ? )'}  ${`${blip.label} `.padEnd(44, '.')} ${reading}`);
    }
    const hint = radar.every(blip => blip.status === 'lost') && radar.find(blip => blip.hint)?.hint;
    if (hint) lines.push(hint);
  }
  return [...lines, '', signOff(kill), ''].join('\n');
}

export function towerCmd(wrap) {
  return {
    ...deferredFamilyDefinition('tower'),
    builder: y => y.strict().option('kill-switch', { type: 'boolean', describe: 'Power the radar down: no requests, no agents, no changes' }),
    handler: wrap(async (argv, app) => {
      const instance = app.getEffectiveInstance() || null;
      const kill = argv['kill-switch'] === true;
      const data = { instance, radar: instance && app.sdk && !kill ? await sweepTower(app.sdk) : [], kill_switch: kill, superintelligence: false, changed: 0 };
      Object.defineProperty(data, '_formatted', { value: formatTower(data), enumerable: false });
      app.ok(data, { summary: signOff(kill), ...(instance || kill ? {} : { notice: 'Run: jsn setup' }) });
      // An empty radar from a failed sweep is not success; compare.js exits 1 on incomplete coverage the same way.
      if (data.radar.length && data.radar.every(blip => blip.status === 'lost')) process.exitCode = 1;
    }),
  };
}

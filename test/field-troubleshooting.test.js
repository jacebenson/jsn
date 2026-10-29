import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constrainQuery } from '../src/constrained-query.js';
import { b4rulesCmd } from '../src/commands/b4rules.js';
import { asyncrulesCmd } from '../src/commands/_simple.js';
import { captureCommands } from './support/command-test-helpers.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const fixed = 'when=before^action_query=true';
test('fixed factory filters remain present for literal user AND clauses, ordering and empty queries', async () => {
  assert.equal(constrainQuery('', fixed), fixed);
  assert.equal(constrainQuery('collection=sys_user^active=true', fixed), `${fixed}^collection=sys_user^active=true`);
  assert.equal(constrainQuery('order<100^ORDERBYorder^EQ', fixed), `${fixed}^order<100^ORDERBYorder`);
  for (const [factory, expected] of [[b4rulesCmd, fixed], [asyncrulesCmd, 'when=async']]) {
    const list = captureCommands(factory(fn => fn)).find(c => c.command === 'list');
    const calls = [];
    await list.handler({ query: 'collection=sys_user^active=true', limit: 5 }, {
      sdk: { list: async (table, params) => { calls.push([table, params.get('sysparm_query')]); return []; } },
      output: { getFormat: () => 'json' }, getEffectiveInstance: () => 'https://fixture.invalid', ok() {},
    });
    assert.deepEqual(calls, [['sys_script', `${expected}^collection=sys_user^active=true^ORDERBYDESCsys_updated_on`]]);
  }
});
test('NQ, OR and dynamic clauses cannot bypass a constrained view and fail before transport', async () => {
  const unsafe = ['NQwhen=after', 'nqwhen=after', 'active=true^oraction_query=false', 'active=true^NQwhen=after', 'active=true^ORaction_query=false', 'ORaction_query=false',
    'active=true^^NQactive=false', 'name=javascript:gs.getUserID()', 'active=true^EQ^NQactive=false'];
  const list = captureCommands(b4rulesCmd(fn => fn)).find(c => c.command === 'list');
  for (const query of unsafe) {
    await assert.rejects(list.handler({ query, limit: 5 }, {
      sdk: { list: async () => assert.fail('Unsafe query must fail before a request') },
      output: { getFormat: () => 'json' },
    }), error => error.code === 'usage_error' && /fixed filter/.test(error.hint));
  }
  assert.equal(constrainQuery('active=true^NQactive=false'), 'active=true^NQactive=false', 'unconstrained generic queries retain their existing semantics');
});
test('actual CLI help explains schema-backed field investigations, constrained query scope and ACL limits', async () => {
  const execute = promisify(execFile), cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
  async function help(args) { return (await execute(process.execPath, [cli, ...args, '--help'], { env, timeout: 15000 })).stdout; }
  const rules = await help(['b4rules', 'list']);
  assert.match(rules, /when=before\^action_query=true/); assert.match(rules, /OR, NQ and dynamic/);
  const fields = await help(['columns']);
  assert.match(fields, /sys_dictionary_override/); assert.match(fields, /no fixed priority order/);
  assert.match(fields, /inherited-table and wildcard ACLs/); assert.match(fields, /Never bypass/);
  const acls = await help(['acls', 'list']);
  assert.match(acls, /Exact name=incident alone does not cover/); assert.match(acls, /conditions and scripts/);
});

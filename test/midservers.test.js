import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandPayload, midserversCmd, parseCommandResult, assertMidServerUp, assertMidServerReady, waitForMidServerUp } from '../src/commands/midservers.js';
import { mutationPaths } from '../src/capabilities.js';

function collectCommands(command) {
  const commands = [];
  const yargs = {
    command(child) {
      commands.push(child);
      return yargs;
    },
  };
  command.builder(yargs);
  return commands;
}

describe('midservers command', () => {
  it('builds the documented ECC Queue command payload safely', () => {
    assert.equal(
      buildCommandPayload('echo "hello" & goodbye'),
      '<parameters><parameter name="name" value="echo &quot;hello&quot; &amp; goodbye"/></parameters>',
    );
  });

  it('extracts stdout and stderr from a MID Server result payload', () => {
    assert.deepEqual(parseCommandResult('<results><result><stdout>ok &amp; done</stdout><stderr>nope</stderr></result></results>'), {
      stdout: 'ok & done',
      stderr: 'nope',
    });
  });

  it('rejects command execution unless the MID Server is Up', () => {
    assert.doesNotThrow(() => assertMidServerUp({ name: 'mid.server.oct12-mid', status: 'Up' }));
    assert.throws(
      () => assertMidServerUp({ name: 'mid.server.oct12-mid', status: 'Down' }),
      /is not Up \(status: Down\).*Start or install it/,
    );
  });

  it('rejects execution until the MID Server is validated', () => {
    assert.doesNotThrow(() => assertMidServerReady({ name: 'mid.server.oct12-mid', status: 'Up', validated: 'true' }));
    assert.throws(
      () => assertMidServerReady({ name: 'mid.server.oct12-mid', status: 'Up', validated: 'validating' }),
      /is not validated yet.*validation: validating/,
    );
  });

  it('accepts the raw true value from display-value envelopes', () => {
    assert.doesNotThrow(() => assertMidServerReady({ status: 'Up', validated: { value: 'true', display_value: 'Yes' } }));
  });

  it('checks readiness before creating ECC work', async () => {
    const execute = collectCommands(midserversCmd(handler => handler)).find(c => c.command === 'execute [identifier]');
    for (const validated of ['false', 'validating', 'validation_failed', 'rekey', 'validated', '']) {
      let writes = 0;
      const app = { sdk: {
        list: async () => [{ name: 'oct12', status: 'Up', validated }],
        create: async () => { writes++; },
      } };
      await assert.rejects(execute.handler({ identifier: 'oct12', command: 'pwd' }, app), { code: 'midserver_not_validated' });
      assert.equal(writes, 0);
    }
    await assert.rejects(execute.handler({ identifier: 'oct12', command: 'pwd' }, {
      sdk: { list: async () => [{ name: 'oct12', status: 'Down', validated: 'true' }], create: async () => assert.fail('must not queue') },
    }), { code: 'midserver_not_up' });
  });

  it('dispatches to the ECC address derived from the actual record name', async () => {
    const execute = collectCommands(midserversCmd(handler => handler)).find(c => c.command === 'execute [identifier]');
    for (const name of ['oct12', 'mid.server.oct12']) {
      let queued;
      const app = { sdk: {
        list: async table => table === 'ecc_agent'
          ? [{ sys_id: 'agent-id', name, status: 'Up', validated: 'true' }]
          : [{ sys_id: 'response-id', payload: '<results><result><stdout>/tmp</stdout></result></results>' }],
        create: async (table, data) => { assert.equal(table, 'ecc_queue'); queued = data; return { sys_id: 'output-id' }; },
      }, ok: () => {} };
      await execute.handler({ identifier: name, command: 'pwd', timeout: 100, interval: 250 }, app);
      assert.equal(queued.agent, `mid.server.${name}`);
    }
  });

  it('polls the configured MID name without an ECC prefix', async () => {
    const record = { name: 'oct12', status: 'Up' };
    const result = await waitForMidServerUp({ sdk: { list: async (table, params) => {
      assert.equal(table, 'ecc_agent');
      assert.equal(params.get('sysparm_query'), 'name=oct12');
      return [record];
    } } }, 'oct12', 100, 1);
    assert.equal(result, record);
  });

  it('exposes list, show, add, remove, and execute', () => {
    const command = midserversCmd((handler) => handler);
    assert.deepEqual(collectCommands(command).map(child => child.command), [
      'list', 'show <identifier>', 'logs <identifier>', '<identifier> logs', 'add', 'remove [identifier]', 'execute [identifier]',
    ]);
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers add'));
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers remove'));
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers execute'));
  });
});

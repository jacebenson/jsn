import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandPayload, midserversCmd, parseCommandResult, assertMidServerUp, assertMidServerReady, waitForMidServerUp } from '../src/commands/midservers.js';
import { mutationPaths } from '../src/capabilities.js';
import { OutputWriter } from '../src/output.js';

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
      }, getEffectiveInstance: () => 'https://example.service-now.com', ok: () => {} };
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

  it('prints stdout, stderr and an input-record link while preserving JSON', async () => {
    const execute = collectCommands(midserversCmd(handler => handler)).find(c => c.command === 'execute [identifier]');
    for (const format of ['auto', 'json']) {
      let text = '';
      const output = new OutputWriter({ format, writer: { isTTY: true, write: chunk => { text += chunk; } } });
      const app = {
        getEffectiveInstance: () => 'https://example.service-now.com',
        ok: (data, options) => output.ok(data, options),
        sdk: {
          list: async table => table === 'ecc_agent'
            ? [{ name: 'oct12', status: 'Up', validated: 'true' }]
            : [{ sys_id: { value: 'input-id', display_value: 'Command' }, payload: '<results><result><stdout>/opt/snc_mid_server/agent</stdout><stderr>warning</stderr></result></results>' }],
          create: async () => ({ sys_id: 'output-id' }),
        },
      };
      await execute.handler({ identifier: 'oct12', command: 'pwd', timeout: 100, interval: 250 }, app);
      const url = 'https://example.service-now.com/ecc_queue.do?sys_id=input-id';
      if (format === 'auto') {
        assert.match(text, /\/opt\/snc_mid_server\/agent/);
        assert.match(text, /stderr:\nwarning/);
        assert.ok(text.includes(url));
      } else {
        const data = JSON.parse(text).data;
        assert.equal(data.response.stdout, '/opt/snc_mid_server/agent');
        assert.equal(data.response.stderr, 'warning');
        assert.equal(data.response.url, url);
      }
    }
  });

  it('exposes list, show, add, remove, and execute', () => {
    const command = midserversCmd((handler) => handler);
    assert.deepEqual(collectCommands(command).map(child => child.command), [
      'issues [identifier]', 'events [identifier]', 'list', 'show <identifier>', 'logs <identifier>', '<identifier> logs', 'start <identifier>', 'stop <identifier>', 'add', 'remove [identifier]', 'validate <identifier>', 'execute [identifier]',
    ]);
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers add'));
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers remove'));
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers execute'));
  });
});

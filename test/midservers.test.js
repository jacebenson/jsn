import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandPayload, midserversCmd, parseCommandResult } from '../src/commands/midservers.js';
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

  it('exposes list, show, add, remove, and execute', () => {
    const command = midserversCmd((handler) => handler);
    assert.deepEqual(collectCommands(command).map(child => child.command), [
      'list', 'show <identifier>', 'add', 'remove <identifier>', 'execute <identifier>',
    ]);
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers add'));
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers remove'));
    assert.ok(mutationPaths().some(path => path.join(' ') === 'midservers execute'));
  });
});

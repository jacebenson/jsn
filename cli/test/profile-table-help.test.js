import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// These families are named for what people often mean by another table: the
// scheduler's sys_trigger queue, or the sys_email mail log. Their help says
// which table they edit and where the other one is read.
test('scheduledjobs, triggers and email help name their table and point to the one people mean', async () => {
  const execute = promisify(execFile), cli = fileURLToPath(new URL('../bin/jsn.js', import.meta.url));
  const env = { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' };
  const help = async args => (await execute(process.execPath, [cli, ...args, '--help'], { env, timeout: 15000 })).stdout;
  for (const args of [['scheduledjobs'], ['scheduledjobs', 'list']]) {
    const text = await help(args);
    assert.match(text, /sysauto_script/, args.join(' '));
    assert.match(text, /sys_trigger[\s\S]*jsn scheduledjobs why <job>[\s\S]*jsn scheduledjobs health/, args.join(' '));
  }
  for (const args of [['triggers'], ['triggers', 'list']]) {
    const text = await help(args);
    assert.match(text, /sysevent_register/, args.join(' '));
    assert.match(text, /sys_trigger[\s\S]*jsn scheduledjobs health/, args.join(' '));
    assert.match(text, /jsn records list --table sysevent .*ORDERBYDESCsys_created_on.* --columns /, args.join(' '));
  }
  for (const args of [['email'], ['email', 'list']]) {
    const text = await help(args);
    assert.match(text, /sysevent_in_email_action/, args.join(' '));
    assert.match(text, /jsn records list --table sys_email .*ORDERBYDESCsys_created_on.* --columns /, args.join(' '));
    assert.match(text, /jsn notifications/, args.join(' '));
  }
  // The commands the help points to must exist: an unknown subcommand prints its parent's help and still exits 0.
  assert.match(await help(['scheduledjobs', 'why']), /^Usage: jsn scheduledjobs why <job>/m);
  assert.match(await help(['scheduledjobs', 'health']), /^Usage: jsn scheduledjobs health/m);
});

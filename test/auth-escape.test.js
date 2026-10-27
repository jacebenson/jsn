import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const python = spawnSync('python3', ['--version']);
const driver = String.raw`
import json, os, pathlib, pty, select, subprocess, sys, tempfile, time
with tempfile.TemporaryDirectory(prefix='jsn-escape-') as directory:
    config = pathlib.Path(directory) / 'servicenow/config.json'
    config.parent.mkdir()
    profiles = {name: {'instance_url': 'https://fixture.invalid', 'username': 'fixture-user', 'auth_method': 'basic'} for name in ['first', 'second']}
    config.write_text(json.dumps({'profiles': profiles, 'activeProfile': 'first', 'defaultProfile': 'first'}))
    original = config.read_bytes()
    env = dict(os.environ, XDG_CONFIG_HOME=directory, JSN_NO_VERSION_CHECK='1', JSN_NO_SKILL_CHECK='1', TERM='xterm-256color')
    for key in ('JSN_NO_PROMPTS', 'CI', 'NONINTERACTIVE', 'GITHUB_ACTIONS', 'CLAUDE_CODE', 'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT', 'GITHUB_COPILOT_AGENT'):
        env.pop(key, None)
    cases = [
      (['auth', 'modify'], [('Modify which profile?', '\x1b')]),
      (['auth', 'modify', '--profile', 'first'], [('Modify first', '\x1b')]),
      (['auth', 'modify', '--profile', 'first'], [('Modify first', '\r'), ('Read-only profile', '\x1b')]),
      (['auth', 'switch'], [('Use which profile', '\x1b')]),
      (['auth', 'logout'], [('Sign out of which profile?', '\x1b')]),
      (['auth', 'remove'], [('Remove which profile?', '\x1b')]),
      (['auth', 'login'], [('Log in to which instance?', '\x1b')]),
      (['setup'], [('What would you like to do?', '\x1b')]),
    ]
    for args, steps in cases:
        master, slave = pty.openpty()
        child = subprocess.Popen([sys.argv[1], sys.argv[2], *args], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        captured = b''
        def read():
            global captured
            if select.select([master], [], [], 0.05)[0]:
                try: captured += os.read(master, 65536)
                except OSError: pass
        try:
            for text, answer in steps:
                deadline = time.monotonic() + 8
                while text.encode() not in captured and child.poll() is None and time.monotonic() < deadline: read()
                assert text.encode() in captured, (args, captured.decode(errors='replace'))
                os.write(master, answer.encode())
            deadline = time.monotonic() + 8
            while child.poll() is None and time.monotonic() < deadline: read()
            assert child.poll() == 0, (args, captured.decode(errors='replace'))
            assert config.read_bytes() == original, ('configuration changed', args)
            assert b'Error' not in captured, captured.decode(errors='replace')
        finally:
            if child.poll() is None: child.kill()
            child.wait()
            os.close(master)
print('Eight real CLI cancellation paths passed; configuration unchanged.')
`;

test('Esc exits auth menus and nested modify prompts without saving changes', {
  skip: process.platform === 'win32' || python.status !== 0,
}, () => {
  const result = spawnSync('python3', ['-c', driver, process.execPath, new URL('../bin/jsn.js', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

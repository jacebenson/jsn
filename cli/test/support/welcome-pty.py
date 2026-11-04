"""Run one command under a real PTY and return its combined output.

Used to prove first-run behavior that is deliberately hidden from piped
invocations (issue #387). Kept generic: the caller supplies argv and env.
"""
import json
import os
import pty
import select
import subprocess
import sys
import time

spec = json.loads(sys.argv[1])
master, slave = pty.openpty()
env = dict(os.environ)
env.update(spec.get('env') or {})
for key in ('JSN_NO_PROMPTS', 'CI', 'NONINTERACTIVE', 'GITHUB_ACTIONS', 'CLAUDE_CODE',
            'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT',
            'GITHUB_COPILOT_AGENT'):
    env.pop(key, None)
env['TERM'] = 'xterm-256color'
child = subprocess.Popen(
    spec['command'],
    stdin=slave, stdout=slave, stderr=slave,
    env=env, cwd=spec.get('cwd') or None, start_new_session=True,
)
os.close(slave)

capture = b''
deadline = time.monotonic() + spec.get('timeout', 30)
while child.poll() is None and time.monotonic() < deadline:
    if select.select([master], [], [], 0.1)[0]:
        try:
            capture += os.read(master, 65536)
        except OSError:
            break
if child.poll() is None:
    child.kill()
child.wait()
for _ in range(5):
    if select.select([master], [], [], 0.05)[0]:
        try:
            capture += os.read(master, 65536)
        except OSError:
            pass
os.close(master)
print(json.dumps({'status': child.returncode, 'output': capture.decode('utf-8', 'replace')}))

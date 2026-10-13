"""Drive real Inquirer prompts on a disposable provider, not a live instance."""
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
for key in ('JSN_NO_PROMPTS', 'CI', 'NONINTERACTIVE', 'GITHUB_ACTIONS', 'CLAUDE_CODE', 'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT', 'GITHUB_COPILOT_AGENT'):
    env.pop(key, None)
env['TERM'] = 'xterm-256color'
child = subprocess.Popen(spec['command'], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)
capture = b''
cursor = 0

def read_available(timeout=0.1):
    global capture
    if select.select([master], [], [], timeout)[0]:
        try:
            capture += os.read(master, 65536)
        except OSError:
            pass

try:
    for text, answer in spec['steps']:
        deadline = time.monotonic() + 8
        while text.encode() not in capture[cursor:]:
            read_available()
            if child.poll() is not None or time.monotonic() > deadline:
                raise AssertionError('Prompt did not appear: ' + text + '\n' + capture.decode(errors='replace'))
        if b'FAKE_WRITE' in capture:
            raise AssertionError('Provider mutation occurred before final confirmation')
        cursor = len(capture)
        os.write(master, answer.encode())
        time.sleep(0.03)
    deadline = time.monotonic() + 8
    while child.poll() is None and time.monotonic() < deadline:
        read_available()
    if child.poll() is None:
        raise AssertionError('Terminal command hung\n' + capture.decode(errors='replace'))
    for _ in range(3):
        read_available(0.05)
    text = capture.decode(errors='replace')
    marker = 'PTY_RESULT='
    if marker not in text:
        raise AssertionError('No terminal result\n' + text)
    result = json.loads(text.split(marker, 1)[1].splitlines()[0])
    print(json.dumps({'status': child.returncode, 'result': result}))
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)

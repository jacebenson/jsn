"""Run one command under a real PTY and return its combined output.

Used to prove first-run behavior that is deliberately hidden from piped
invocations (issue #387). Kept generic: the caller supplies argv, env, terminal
size, and an optional signal to deliver while the command is running.

Spec (JSON in argv[1]):
  command      list[str]  argv to execute (required)
  cwd          str        working directory
  env          dict       extra environment variables
  unset        list[str]  environment variables to remove after the defaults
  columns      int        PTY width in columns (default: 100)
  rows         int        PTY height in rows (default: 30)
  timeout      float      seconds before the child is killed (default: 30)
  signal       dict       {"name": "SIGINT", "after_bytes": 1} or
                          {"name": "SIGINT", "after_ms": 0} - delivered to the
                          child's process group once either threshold is met

Output: one JSON object on stdout: {"status": int, "signal": int|None,
"output": str, "signalled": bool}. A negative status means the child died from
a signal (as in subprocess return codes).

Windows has no pty module, so the tests that use this driver skip there.
"""
import fcntl
import json
import os
import pty
import select
import signal as signal_module
import struct
import subprocess
import sys
import termios
import time

spec = json.loads(sys.argv[1])


def set_window_size(fd, rows, columns):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))


master, slave = pty.openpty()
set_window_size(slave, int(spec.get('rows') or 30), int(spec.get('columns') or 100))

env = dict(os.environ)
# Agent and CI markers would suppress the very behavior under test; the caller
# opts back in by naming them in spec['env'].
for key in ('JSN_NO_PROMPTS', 'CI', 'NONINTERACTIVE', 'GITHUB_ACTIONS', 'CLAUDE_CODE',
            'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT',
            'GITHUB_COPILOT_AGENT'):
    env.pop(key, None)
env.update(spec.get('env') or {})
for key in spec.get('unset') or []:
    env.pop(key, None)
env.setdefault('TERM', 'xterm-256color')

child = subprocess.Popen(
    spec['command'],
    stdin=slave, stdout=slave, stderr=slave,
    env=env, cwd=spec.get('cwd') or None, start_new_session=True,
)
os.close(slave)

started = time.monotonic()
capture = b''
deadline = started + float(spec.get('timeout') or 30)
pending = spec.get('signal') or None
signalled = False
signal_delivered = False


def maybe_signal():
    """Deliver the requested signal once its threshold is reached."""
    global signal_delivered
    if not pending or signal_delivered:
        return
    after_bytes = pending.get('after_bytes')
    after_ms = pending.get('after_ms')
    reached = False
    if after_bytes is not None and len(capture) >= int(after_bytes):
        reached = True
    if after_ms is not None and (time.monotonic() - started) * 1000 >= float(after_ms):
        reached = True
    if not reached:
        return
    signal_delivered = True
    target = getattr(signal_module, pending.get('name') or 'SIGINT')
    try:
        os.killpg(os.getpgid(child.pid), target)
    except OSError:
        try:
            child.send_signal(target)
        except OSError:
            pass


while child.poll() is None and time.monotonic() < deadline:
    if select.select([master], [], [], 0.02)[0]:
        try:
            capture += os.read(master, 65536)
        except OSError:
            break
    maybe_signal()
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
print(json.dumps({
    'status': child.returncode,
    'signal': -child.returncode if child.returncode is not None and child.returncode < 0 else None,
    'output': capture.decode('utf-8', 'replace'),
    'signalled': signal_delivered,
}))

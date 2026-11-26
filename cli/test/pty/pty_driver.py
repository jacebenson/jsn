#!/usr/bin/env python3
"""Real pseudo-terminal driver for the JSN prompt engine.

Runs a Node harness under a fresh PTY, feeds keystrokes with delays, captures
everything the terminal emitted, and reports the child's exit status.

The child runs inside a shell wrapper that samples `stty -g` before and after
Node and prints TERMIOS_OK only when the terminal settings are identical, so a
leaked raw mode is visible as a missing marker.

Usage:
  python3 pty_driver.py --scenario escape --keys '[[500,"\\u001b"]]'
Output: one JSON object on stdout.
"""
import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import subprocess
import sys
import time


def read_available(fd, deadline, chunks, timeout=0.1):
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return False
            if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                continue
            raise
        if not data:
            return False
        chunks.append(data)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scenario', required=True)
    parser.add_argument('--keys', default='[]')
    parser.add_argument('--timeout', type=float, default=20.0)
    parser.add_argument('--columns', type=int, default=120)
    parser.add_argument('--cwd', default=os.getcwd())
    args = parser.parse_args()

    steps = json.loads(args.keys)
    harness = os.path.join(args.cwd, 'test', 'pty', 'prompt-harness.mjs')
    node = os.environ.get('NODE_BIN', 'node')
    inner = f'"{node}" "{harness}" {args.scenario}'
    wrapper = (
        'before=$(stty -g); '
        f'{inner}; status=$?; '
        'after=$(stty -g); '
        'if [ "$before" = "$after" ]; then echo TERMIOS_OK; '
        'else echo "TERMIOS_MISMATCH:$before:$after"; fi; '
        'exit $status'
    )

    master, slave = pty.openpty()
    # Non-blocking master: the final drain must never block on a dead child.
    flags = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    # A stable, dumb-friendly window so renderers do not depend on host size.
    import termios
    fcntl.ioctl(slave, termios.TIOCSWINSZ, __import__('struct').pack('HHHH', 40, args.columns, 0, 0))
    child = subprocess.Popen(
        ['sh', '-c', wrapper], cwd=args.cwd, stdin=slave, stdout=slave,
        stderr=slave, start_new_session=True, env={**os.environ, 'TERM': 'xterm'},
    )
    os.close(slave)

    chunks = []
    started = time.monotonic()
    deadline = started + args.timeout
    for delay_ms, text in steps:
        read_available(master, min(time.monotonic() + delay_ms / 1000.0, deadline), chunks)
        os.write(master, text.encode('utf-8'))

    # Drain until the child exits or the deadline passes.
    while child.poll() is None and time.monotonic() < deadline:
        read_available(master, time.monotonic() + 0.05, chunks, timeout=0.05)
    idle_since = time.monotonic()
    while True:
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            if time.monotonic() - idle_since > 0.5:
                break
            continue
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno in (errno.EIO, errno.EAGAIN, errno.EWOULDBLOCK):
                if error.errno == errno.EIO:
                    break
                idle_since = time.monotonic()
                continue
            raise
        if not data:
            break
        chunks.append(data)
        idle_since = time.monotonic()

    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    os.close(master)

    output = b''.join(chunks).decode('utf-8', 'replace')
    print(json.dumps({
        'scenario': args.scenario,
        'exit': child.returncode,
        'termios_ok': 'TERMIOS_OK' in output,
        'termios_mismatch': 'TERMIOS_MISMATCH' in output,
        'duration_ms': round((time.monotonic() - started) * 1000),
        'output': output,
    }))


if __name__ == '__main__':
    sys.exit(main())

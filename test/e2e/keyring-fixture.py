#!/usr/bin/env python3
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import time

BASE = Path('/run/cockpit-pacman-e2e')
STATE = BASE / 'keyring'
FIXTURE = '/usr/local/libexec/cockpit-pacman-e2e/keyring-fixture.py'


def active_pids():
    active = []
    for name in ['parent', 'grandchild']:
        path = STATE / name
        if path.exists():
            pid = int(path.read_text())
            try:
                status = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1]
            except FileNotFoundError:
                continue
            if not status.startswith('Z'):
                active.append(pid)
    return active


def state():
    with (STATE / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = False
        except BlockingIOError:
            locked = True
    print(json.dumps({'ready': (STATE / 'ready').exists(), 'pids': active_pids(), 'locked': locked}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['setup', 'child', 'state', 'cleanup'])
    args = parser.parse_args()
    if os.geteuid() != 0 or not (BASE / 'packages.json').is_file():
        raise SystemExit('Requires the provisioned disposable Cockpit E2E guest')
    if args.action == 'setup':
        STATE.mkdir(mode=0o700)
        (STATE / 'bin').mkdir()
        (STATE / 'bin/gpg').write_text('#!/bin/sh\nexit 0\n')
        (STATE / 'bin/pacman-key').write_text(f'''#!/bin/sh
echo $$ > {STATE}/parent
exec flock {STATE}/lock {FIXTURE} child
''')
        for path in (STATE / 'bin').iterdir():
            path.chmod(0o700)
        (STATE / 'enabled').touch(mode=0o600)
    elif args.action == 'child':
        (STATE / 'grandchild').write_text(str(os.getpid()))
        (STATE / 'ready').touch()
        deadline = time.monotonic() + 90
        while not (STATE / 'release').exists() and time.monotonic() < deadline:
            time.sleep(0.05)
    elif args.action == 'state':
        state()
    elif args.action == 'cleanup' and STATE.exists():
        (STATE / 'enabled').unlink(missing_ok=True)
        (STATE / 'release').touch()
        deadline = time.monotonic() + 5
        while active_pids():
            if time.monotonic() > deadline:
                raise SystemExit('Keyring fixture processes are still running')
            time.sleep(0.05)
        shutil.rmtree(STATE)


if __name__ == '__main__':
    main()

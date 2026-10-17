#!/usr/bin/env python3
import os
from pathlib import Path
import stat
import sys

STATE = Path('/run/cockpit-pacman-e2e')
command = sys.argv[1] if len(sys.argv) > 1 else ''
env = os.environ.copy()
if command.startswith('signoff-'):
    env['COCKPIT_PACMAN_TEST_ARCHWEB_URL'] = 'http://127.0.0.1:18080'
if command in ('list-archive-versions', 'downgrade-archive'):
    env['COCKPIT_PACMAN_TEST_ARCHIVE_URL'] = 'http://127.0.0.1:18080/archive'
if command in ('refresh-keyring', 'init-keyring') and (STATE / 'keyring/enabled').exists():
    info = (STATE / 'keyring').lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise SystemExit('Unsafe E2E keyring fixture directory')
    env['PATH'] = str(STATE / 'keyring/bin') + ':/usr/bin'
if command in ('cache-info', 'cache-files', 'clean-cache'):
    marker = STATE / 'cache-dir'
    if marker.exists():
        info = marker.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('Unsafe E2E cache marker')
        value = marker.read_text().strip()
        if not value.startswith('/var/tmp/cockpit-pacman-cache-e2e-') or '/' in value.removeprefix('/var/tmp/'):
            raise SystemExit('Invalid E2E cache directory')
        env['PACMAN_CACHE_DIR'] = value
os.execve('/usr/libexec/cockpit-pacman/cockpit-pacman-backend.real', [sys.argv[0], *sys.argv[1:]], env)

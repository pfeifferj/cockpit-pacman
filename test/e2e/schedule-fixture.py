#!/usr/bin/env python3
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

BASE = Path('/run/cockpit-pacman-e2e')
STATE = BASE / 'schedule'
FIXTURE = '/usr/local/libexec/cockpit-pacman-e2e/schedule-fixture.py'
AUXILIARY = 'cockpit-pacman-e2e-schedule'
LOCK = Path('/var/lib/pacman/db.lck')

spec = importlib.util.spec_from_file_location('commit_fixture', Path(__file__).with_name('commit-fixture.py'))
commit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commit)


def auxiliary_package(version):
    tree = STATE / ('build-' + version)
    payload = tree / 'usr/share' / AUXILIARY / 'version'
    payload.parent.mkdir(parents=True)
    payload.write_text(version + '\n')
    (tree / '.PKGINFO').write_text(f'''pkgname = {AUXILIARY}
pkgbase = {AUXILIARY}
pkgver = {version}
pkgdesc = Scheduled upgrade fixture
builddate = 1
packager = Cockpit E2E
size = 4
arch = any
license = GPL
''')
    archive = commit.STATE / f'{AUXILIARY}-{version}-any.pkg.tar.zst'
    commit.run(['bsdtar', '--zstd', '-cf', str(archive), '-C', str(tree), '.PKGINFO', 'usr'])
    archive.chmod(0o644)
    return archive


def setup(scenario):
    if STATE.exists() or commit.STATE.exists():
        raise SystemExit('Schedule fixture already exists')
    if subprocess.run(['pacman', '-Q', AUXILIARY], capture_output=True, check=False).returncode == 0:
        raise SystemExit('Schedule fixture package is already installed')
    STATE.mkdir(mode=0o700)
    commit.setup('pre', False, False)
    config = json.loads(commit.CONFIG.read_text())
    config['schedule']['enabled'] = True
    config['schedule']['max_packages'] = 1 if scenario == 'limit' else 0
    commit.replace(commit.CONFIG, json.dumps(config))
    if scenario == 'running':
        commit.HISTORY.parent.mkdir(parents=True, exist_ok=True)
        commit.replace(commit.HISTORY, json.dumps({
            'timestamp': '2020-01-01T00:00:00+0000', 'mode': 'upgrade', 'status': 'ok',
            'success': True, 'packages_checked': 9, 'packages_upgraded': 9, 'error': None,
            'details': [], 'invocation_id': 'previous-fixture-run',
        }) + '\n')
    if scenario in ('limit', 'intervention'):
        original = auxiliary_package('1-1')
        commit.run(['pacman', '-U', '--noconfirm', str(original)], stdout=subprocess.DEVNULL)
        if scenario == 'limit':
            updated = auxiliary_package('2-1')
        else:
            tree = commit.STATE / ('build-' + commit.PACKAGE + '-2-1')
            with (tree / '.PKGINFO').open('a') as info:
                info.write(f'conflict = {AUXILIARY}\n')
            updated = commit.STATE / f'{commit.PACKAGE}-2-1-any.pkg.tar.zst'
            commit.run(['bsdtar', '--zstd', '-cf', str(updated), '-C', str(tree), '.PKGINFO', '.INSTALL', 'usr'])
        commit.run(['repo-add', str(commit.STATE / f'{commit.PACKAGE}.db.tar.gz'), str(updated)], stdout=subprocess.DEVNULL)
        (Path('/var/lib/pacman/sync') / f'{commit.PACKAGE}.db').unlink()
    if scenario == 'lock':
        subprocess.Popen([FIXTURE, 'hold-lock'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 5
        while not (STATE / 'lock-ready').exists():
            if time.monotonic() > deadline:
                raise SystemExit('Lock fixture did not start')
            time.sleep(0.05)
    journal = commit.output(['journalctl', '-n', '0', '--show-cursor'])
    cursor = next(line.removeprefix('-- cursor: ') for line in journal.splitlines() if line.startswith('-- cursor: '))
    (STATE / 'cursor').write_text(cursor)


def hold_lock():
    with LOCK.open('x'):
        identity = LOCK.stat()
        (STATE / 'lock-ready').touch()
        deadline = time.monotonic() + 90
        while not (STATE / 'lock-release').exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        current = LOCK.stat()
        if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
            LOCK.unlink()
    (STATE / 'lock-finished').touch()


def state():
    properties = dict(line.split('=', 1) for line in commit.output([
        'systemctl', 'show', commit.UNIT, '--property=ActiveState,ExecMainStatus,Result,InvocationID',
    ]).splitlines())
    history = [json.loads(line) for line in commit.HISTORY.read_text().splitlines() if line] if commit.HISTORY.exists() else []
    journal = commit.output(['journalctl', '--after-cursor', (STATE / 'cursor').read_text(),
                             '-t', 'cockpit-pacman', '-o', 'json', '--no-pager'])
    events = [json.loads(line) for line in journal.splitlines() if line]
    print(json.dumps({
        'service': properties['ActiveState'], 'exit_status': int(properties['ExecMainStatus']),
        'result': properties['Result'], 'invocation_id': properties['InvocationID'],
        'pre': (commit.STATE / 'pre-entered').exists(), 'post': (commit.STATE / 'post-entered').exists(),
        'version': commit.installed_version(), 'locked': LOCK.exists(),
        'latest_run': history[-1] if history else None,
        'journal': [{'message': event.get('MESSAGE', ''), 'priority': event.get('PRIORITY')} for event in events],
    }))


def cleanup():
    if not STATE.exists():
        return
    if (STATE / 'lock-ready').exists():
        (STATE / 'lock-release').touch()
        deadline = time.monotonic() + 5
        while not (STATE / 'lock-finished').exists():
            if time.monotonic() > deadline:
                raise SystemExit('Lock fixture is still running')
            time.sleep(0.05)
    if commit.STATE.exists():
        (commit.STATE / 'release').touch()
    deadline = time.monotonic() + 30
    while commit.backend_pids() or LOCK.exists():
        if time.monotonic() > deadline:
            raise SystemExit('Scheduled transaction is still running')
        time.sleep(0.05)
    if subprocess.run(['pacman', '-Q', AUXILIARY], capture_output=True, check=False).returncode == 0:
        commit.run(['pacman', '-R', '--noconfirm', AUXILIARY], stdout=subprocess.DEVNULL)
    for version in ['1-1', '2-1']:
        (Path('/var/cache/pacman/pkg') / f'{AUXILIARY}-{version}-any.pkg.tar.zst').unlink(missing_ok=True)
    commit.cleanup()
    shutil.rmtree(STATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['setup', 'hold-lock', 'start', 'stop', 'release', 'state', 'cleanup'])
    parser.add_argument('--scenario', choices=['running', 'lock', 'limit', 'intervention'], default='running')
    args = parser.parse_args()
    if os.geteuid() != 0 or not (BASE / 'packages.json').is_file():
        raise SystemExit('Requires the provisioned disposable Cockpit E2E guest')
    if args.action == 'setup':
        setup(args.scenario)
    elif args.action == 'hold-lock':
        hold_lock()
    elif args.action == 'start':
        commit.run(['systemctl', 'start', '--no-block', commit.UNIT])
    elif args.action == 'stop':
        commit.run(['systemctl', 'stop', '--no-block', commit.UNIT])
    elif args.action == 'release':
        (commit.STATE / 'release').touch()
    elif args.action == 'state':
        state()
    elif args.action == 'cleanup':
        cleanup()


if __name__ == '__main__':
    main()

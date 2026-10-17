#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

BASE = Path('/run/cockpit-pacman-e2e')
STATE = BASE / 'commit'
PACKAGE = 'cockpit-pacman-e2e-commit'
VICTIM = PACKAGE + '-old'
BACKEND = '/usr/libexec/cockpit-pacman/cockpit-pacman-backend'
FIXTURE = '/usr/local/libexec/cockpit-pacman-e2e/commit-fixture.py'
UNIT = 'cockpit-pacman-scheduled.service'
TIMER = 'cockpit-pacman-scheduled.timer'
PACMAN_CONF = Path('/etc/pacman.conf')
CONFIG = Path('/etc/cockpit-pacman/config.json')
HISTORY = Path('/var/log/cockpit-pacman/scheduled.jsonl')
PAYLOAD = Path('/usr/share') / PACKAGE / 'version'
HOOKS = [Path('/etc/pacman.d/hooks') / f'{prefix}-{PACKAGE}.hook' for prefix in ('00-pre', 'zz-post')]


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def output(args):
    return subprocess.check_output(args, text=True).strip()


def replace(path, content):
    temporary = path.with_name(path.name + '.commit-e2e')
    temporary.write_text(content)
    temporary.chmod(0o644)
    temporary.replace(path)


def backend_pids():
    pids = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if args[0] not in (BACKEND.encode(), (BACKEND + '.real').encode()):
            continue
        if args[1:2] in ([b'scheduled-run'], [b'upgrade']) or (
                args[1:2] in ([b'install-package'], [b'downgrade'], [b'downgrade-archive'])
                and args[2:3] == [PACKAGE.encode()]):
            pids.append(int(entry.name))
    return pids


def installed_version(name=PACKAGE):
    result = subprocess.run(['pacman', '-Q', name], text=True, capture_output=True, check=False)
    return result.stdout.strip().split()[-1] if result.returncode == 0 else None


def package(version, name=PACKAGE, conflicts=None):
    tree = STATE / ('build-' + name + '-' + version)
    target = tree / 'usr/share' / name / 'version'
    target.parent.mkdir(parents=True)
    target.write_text(version + '\n')
    (tree / '.PKGINFO').write_text(f'''pkgname = {name}
pkgbase = {name}
pkgver = {version}
pkgdesc = Commit cancellation fixture
builddate = 1
packager = Cockpit E2E
size = 4
arch = any
license = GPL
''' + (f'conflict = {conflicts}\n' if conflicts else ''))
    (tree / '.INSTALL').write_text(f'pre_upgrade() {{ {FIXTURE} scriptlet; }}\n' if name == PACKAGE else '')
    archive = STATE / f'{name}-{version}-any.pkg.tar.zst'
    run(['bsdtar', '--zstd', '-cf', str(archive), '-C', str(tree), '.PKGINFO', '.INSTALL', 'usr'])
    archive.chmod(0o644)
    return archive


def setup(phase, fail, removal, current_repo=False):
    if STATE.exists() or installed_version() is not None or installed_version(VICTIM) is not None or any(path.exists() for path in HOOKS):
        raise SystemExit('Commit fixture already exists; clean it up before preparing another run')
    if backend_pids() or Path('/var/lib/pacman/db.lck').exists():
        raise SystemExit('A package transaction is already running')
    if output(['systemctl', 'show', '-p', 'ActiveState', '--value', UNIT]) not in ('inactive', 'failed'):
        raise SystemExit('Scheduled service is already running')
    STATE.mkdir(mode=0o755)
    timer_active = subprocess.run(['systemctl', 'is-active', '--quiet', TIMER], check=False).returncode == 0
    for name, path in [('pacman.conf', PACMAN_CONF), ('config.json', CONFIG), ('scheduled.jsonl', HISTORY)]:
        if path.exists():
            shutil.copy2(path, STATE / name)
    (STATE / 'settings.json').write_text(json.dumps({'phase': phase, 'fail': fail, 'timer_active': timer_active}))
    run(['systemctl', 'stop', TIMER])
    original, updated = package('1-1'), package('2-1')
    run(['repo-add', str(STATE / f'{PACKAGE}.db.tar.gz'), str(original if current_repo else updated)], stdout=subprocess.DEVNULL)
    replace(PACMAN_CONF, f'''[options]
Architecture = auto
SigLevel = Required DatabaseOptional
LocalFileSigLevel = Optional
[{PACKAGE}]
SigLevel = Never
Server = file://{STATE}
''')
    run(['pacman', '-U', '--noconfirm', str(original)], stdout=subprocess.DEVNULL)
    if removal:
        run(['pacman', '-U', '--noconfirm', str(package('1-1', VICTIM))], stdout=subprocess.DEVNULL)
    run(['pacman', '-Sy', '--noconfirm'], stdout=subprocess.DEVNULL)
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    replace(CONFIG, json.dumps({'security_advisories': False, 'schedule': {
        'enabled': False, 'mode': 'upgrade', 'schedule': 'weekly', 'max_packages': 1,
    }}))
    for path, when, action in zip(HOOKS, ['PreTransaction', 'PostTransaction'], ['pre', 'post']):
        path.parent.mkdir(parents=True, exist_ok=True)
        abort = 'AbortOnFail\n' if when == 'PreTransaction' else ''
        path.write_text(f'''[Trigger]
Operation = Upgrade
Type = Package
Target = {PACKAGE}
[Action]
When = {when}
Exec = {FIXTURE} {action}
{abort}''')
    (STATE / 'prepared').touch()


def publish(updated, signatures=False):
    database = STATE / f'{PACKAGE}.db.tar.gz'
    run(['repo-add', *(['--include-sigs'] if signatures else []), str(database), str(updated)], stdout=subprocess.DEVNULL)
    timestamp = time.time() + 2
    os.utime(database, (timestamp, timestamp))


def publish_conflict():
    if installed_version(VICTIM) is None:
        raise SystemExit('Set up the removal fixture before publishing a conflict')
    publish(package('3-1', conflicts=VICTIM))


def cached_conflict():
    if installed_version(VICTIM) is None:
        raise SystemExit('Set up the removal fixture before caching a conflict')
    archive = package('0-1', conflicts=VICTIM)
    shutil.copy2(archive, Path('/var/cache/pacman/pkg') / archive.name)


def unknown_signer():
    signer = STATE / 'signing-key'
    verifier = STATE / 'verification-key'
    signer.mkdir(mode=0o700)
    verifier.mkdir(mode=0o700)
    run(['gpg', '--homedir', str(signer), '--no-options', '--batch', '--pinentry-mode', 'loopback',
         '--passphrase', '', '--quick-generate-key', 'Cockpit Pacman fixture', 'ed25519', 'sign', '0'],
        stdout=subprocess.DEVNULL)
    keys = output(['gpg', '--homedir', str(signer), '--batch', '--with-colons', '--list-keys'])
    fingerprint = next(line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:'))
    (STATE / 'signer-fingerprint').write_text(fingerprint)
    (verifier / 'pubring.gpg').touch(mode=0o600)
    (verifier / 'gpg.conf').write_text('no-auto-key-retrieve\nauto-key-locate clear\nkeyserver hkp://127.0.0.1:9\n')
    run(['gpg', '--homedir', str(verifier), '--batch', '--check-trustdb'], stdout=subprocess.DEVNULL)
    archive = STATE / f'{PACKAGE}-2-1-any.pkg.tar.zst'
    run(['gpg', '--homedir', str(signer), '--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
         '--detach-sign', str(archive)], stdout=subprocess.DEVNULL)
    archive.with_name(archive.name + '.sig').chmod(0o644)
    publish(archive, signatures=True)
    replace(PACMAN_CONF, PACMAN_CONF.read_text().replace(
        'Architecture = auto\n', f'Architecture = auto\nGPGDir = {verifier}\n').replace(
        'SigLevel = Never\n', 'SigLevel = Required DatabaseOptional\n'))


def signing_state():
    verifier = STATE / 'verification-key'
    if not verifier.exists():
        return None
    keys = output(['gpg', '--homedir', str(verifier), '--batch', '--with-colons', '--list-keys'])
    return {
        'fingerprint': (STATE / 'signer-fingerprint').read_text(),
        'keyring_fingerprints': [line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:')],
    }


def checkpoint(phase):
    (STATE / (phase + '-entered')).touch()
    settings = json.loads((STATE / 'settings.json').read_text())
    if settings['phase'] == phase:
        deadline = time.monotonic() + 90
        while not (STATE / 'release').exists():
            if time.monotonic() >= deadline:
                raise SystemExit('Commit fixture barrier timed out')
            time.sleep(0.05)
        if settings['fail']:
            raise SystemExit('Commit fixture pre-transaction hook failed')


def state():
    history = [json.loads(line) for line in HISTORY.read_text().splitlines() if line] if HISTORY.exists() else []
    print(json.dumps({
        'version': installed_version(),
        'victim_version': installed_version(VICTIM),
        'payload': PAYLOAD.read_text().strip() if PAYLOAD.exists() else None,
        'pre': (STATE / 'pre-entered').exists(),
        'scriptlet': (STATE / 'scriptlet-entered').exists(),
        'post': (STATE / 'post-entered').exists(),
        'pids': backend_pids(),
        'locked': Path('/var/lib/pacman/db.lck').exists(),
        'service': output(['systemctl', 'show', '-p', 'ActiveState', '--value', UNIT]),
        'latest_run': history[-1] if history else None,
        'signing': signing_state(),
    }))


def cleanup():
    if not STATE.exists():
        return
    (STATE / 'release').touch()
    deadline = time.monotonic() + 30
    while backend_pids() or Path('/var/lib/pacman/db.lck').exists():
        if time.monotonic() >= deadline:
            raise SystemExit('Transaction is still running; leaving the fixture for inspection')
        time.sleep(0.1)
    run(['systemctl', 'stop', UNIT])
    for path in HOOKS:
        path.unlink(missing_ok=True)
    if installed_version() is not None:
        run(['pacman', '-R', '--noconfirm', PACKAGE], stdout=subprocess.DEVNULL)
    if installed_version(VICTIM) is not None:
        run(['pacman', '-R', '--noconfirm', VICTIM], stdout=subprocess.DEVNULL)
    for name, path in [('pacman.conf', PACMAN_CONF), ('config.json', CONFIG), ('scheduled.jsonl', HISTORY)]:
        saved = STATE / name
        if saved.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(saved, path)
        elif name != 'pacman.conf':
            path.unlink(missing_ok=True)
    for suffix in ['.db', '.db.sig', '.files', '.files.sig']:
        (Path('/var/lib/pacman/sync') / (PACKAGE + suffix)).unlink(missing_ok=True)
    for version in ['0-1', '1-1', '2-1', '3-1']:
        for suffix in ['', '.sig']:
            (Path('/var/cache/pacman/pkg') / f'{PACKAGE}-{version}-any.pkg.tar.zst{suffix}').unlink(missing_ok=True)
    (Path('/var/cache/pacman/pkg') / f'{VICTIM}-1-1-any.pkg.tar.zst').unlink(missing_ok=True)
    settings = json.loads((STATE / 'settings.json').read_text())
    if subprocess.run(['systemctl', 'is-failed', '--quiet', UNIT], capture_output=True, check=False).returncode == 0:
        run(['systemctl', 'reset-failed', UNIT])
    if settings['timer_active']:
        run(['systemctl', 'start', TIMER])
    for name in ['signing-key', 'verification-key']:
        home = STATE / name
        if home.exists():
            run(['gpgconf', '--homedir', str(home), '--kill', 'all'])
    shutil.rmtree(STATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['setup', 'pre', 'scriptlet', 'post', 'release', 'state', 'term',
                                          'scheduled-start', 'scheduled-stop', 'publish-conflict', 'publish-update',
                                          'cached-conflict', 'uninstall-target', 'unknown-signer', 'cleanup'])
    parser.add_argument('--phase', choices=['pre', 'scriptlet'], default='scriptlet')
    parser.add_argument('--fail', action='store_true')
    parser.add_argument('--removal', action='store_true')
    parser.add_argument('--current-repo', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0 or not (BASE / 'packages.json').is_file():
        raise SystemExit('Requires the provisioned disposable Cockpit E2E guest')
    if args.action == 'setup':
        setup(args.phase, args.fail, args.removal, args.current_repo)
    elif args.action == 'publish-conflict':
        publish_conflict()
    elif args.action == 'publish-update':
        publish(STATE / f'{PACKAGE}-2-1-any.pkg.tar.zst')
    elif args.action == 'cached-conflict':
        cached_conflict()
    elif args.action == 'uninstall-target':
        run(['pacman', '-R', '--noconfirm', PACKAGE], stdout=subprocess.DEVNULL)
    elif args.action == 'unknown-signer':
        unknown_signer()
    elif args.action in ('pre', 'scriptlet', 'post'):
        checkpoint(args.action)
    elif args.action == 'release':
        (STATE / 'release').touch()
    elif args.action == 'state':
        state()
    elif args.action == 'term':
        pids = backend_pids()
        if len(pids) != 1:
            raise SystemExit(f'Expected one fixture backend, found {len(pids)}')
        os.kill(pids[0], signal.SIGTERM)
    elif args.action == 'scheduled-start':
        config = json.loads(CONFIG.read_text())
        config['schedule']['enabled'] = True
        replace(CONFIG, json.dumps(config))
        run(['systemctl', 'start', '--no-block', UNIT])
    elif args.action == 'scheduled-stop':
        run(['systemctl', 'stop', '--no-block', UNIT])
    elif args.action == 'cleanup':
        cleanup()


if __name__ == '__main__':
    main()

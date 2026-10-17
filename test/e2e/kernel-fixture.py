#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

BASE = Path('/run/cockpit-pacman-e2e')
STATE = BASE / 'kernel'
CACHE = Path('/var/cache/pacman/pkg')
BACKEND = '/usr/libexec/cockpit-pacman/cockpit-pacman-backend'
FIXTURE = '/usr/local/libexec/cockpit-pacman-e2e/kernel-fixture.py'
TIMER = 'cockpit-pacman-scheduled.timer'
UNIT = 'cockpit-pacman-scheduled.service'
HOOKS = [Path('/etc/pacman.d/hooks') / f'{prefix}-cockpit-pacman-e2e-kernel.hook'
         for prefix in ['65', 'zz']]


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def output(args):
    return subprocess.check_output(args, text=True).strip()


def installed_version(required=True):
    result = subprocess.run(['pacman', '-Q', 'linux'], capture_output=True, text=True, check=required)
    return result.stdout.split()[1] if result.returncode == 0 else None


def settings():
    return json.loads((STATE / 'settings.json').read_text())


def save(value):
    (STATE / 'settings.json').write_text(json.dumps(value))


def backend_pids():
    result = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if args[0] not in [BACKEND.encode(), (BACKEND + '.real').encode()]:
            continue
        if args[1:3] in [[b'downgrade', b'linux'], [b'install-package', b'linux']]:
            result.append(int(entry.name))
    return result


def repository_archive(pacman):
    name, version, filename, signature = output([
        *pacman, '-Spdd', '--print-format', '%n\t%v\t%f\t%g', 'linux',
    ]).split('\t')
    if name != 'linux' or Path(filename).name != filename or not signature:
        raise RuntimeError('Repository did not provide a signed linux archive')
    archive = CACHE / filename
    if not archive.exists():
        run([*pacman, '-Swdd', '--noconfirm', 'linux'], stdout=subprocess.DEVNULL)
    archive.with_name(filename + '.sig').write_bytes(base64.b64decode(signature, validate=True))
    verify_archive(archive)
    return version, archive


def verify_archive(archive):
    run(['pacman-key', '--verify', str(archive) + '.sig', str(archive)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def older_archive(version):
    for archive in sorted(CACHE.glob('linux-[0-9]*-x86_64.pkg.tar.*')):
        if archive.name.endswith('.sig') or not Path(str(archive) + '.sig').exists():
            continue
        metadata = subprocess.run(['pacman', '-Qp', str(archive)], capture_output=True, text=True, check=False)
        if metadata.returncode:
            continue
        name, candidate = metadata.stdout.strip().split()
        if name == 'linux' and int(output(['vercmp', candidate, version])) < 0:
            verify_archive(archive)
            return candidate, archive
    config = STATE / 'archive.conf'
    config.write_text('''[options]
Architecture = auto
SigLevel = Required DatabaseOptional
GPGDir = /etc/pacman.d/gnupg
[core]
Server = https://archive.archlinux.org/repos/2026/06/01/$repo/os/$arch
''')
    database = STATE / 'archive-db'
    database.mkdir()
    pacman = ['pacman', '--config', str(config), '--dbpath', str(database)]
    run([*pacman, '-Sy', '--noconfirm'], stdout=subprocess.DEVNULL)
    candidate, archive = repository_archive(pacman)
    if int(output(['vercmp', candidate, version])) >= 0:
        raise RuntimeError('The archive fixture is not older than the installed kernel')
    return candidate, archive


def preset_paths():
    script = '''source "$1"
for preset in "${PRESETS[@]}"; do
    variable="${preset}_kver"
    printf 'kernel\\0%s\\0' "${!variable:-${ALL_kver:-}}"
    variable="${preset}_image"
    printf 'image\\0%s\\0' "${!variable:-${ALL_image:-}}"
done
'''
    fields = subprocess.check_output(['bash', '-c', script, 'kernel-fixture', '/etc/mkinitcpio.d/linux.preset'])
    values = fields.decode().split('\0')[:-1]
    paths = {'kernel': set(), 'image': set()}
    for kind, path in zip(values[::2], values[1::2]):
        if path:
            if not path.startswith('/boot/'):
                raise RuntimeError(f'Kernel fixture requires boot images under /boot: {path}')
            paths[kind].add(path)
    if not paths['kernel'] or not paths['image']:
        raise RuntimeError('Kernel fixture requires a kernel copy and an initramfs image preset')
    return {kind: sorted(values) for kind, values in paths.items()}


def setup(mode):
    if STATE.exists() or any(path.exists() for path in HOOKS):
        raise RuntimeError('Kernel fixture already exists; clean it up first')
    if backend_pids() or Path('/var/lib/pacman/db.lck').exists():
        raise RuntimeError('A package transaction is running')
    if output(['systemctl', 'show', '-p', 'ActiveState', '--value', UNIT]) not in ['inactive', 'failed']:
        raise RuntimeError('The scheduled unit is running')
    for path in ['/usr/share/libalpm/hooks/60-mkinitcpio-remove.hook',
                 '/usr/share/libalpm/hooks/90-mkinitcpio-install.hook']:
        if not Path(path).is_file():
            raise RuntimeError(f'The real mkinitcpio hook is missing: {path}')
    version = installed_version()
    paths = preset_paths()
    STATE.mkdir(mode=0o700)
    active = subprocess.run(['systemctl', 'is-active', '--quiet', TIMER], check=False).returncode == 0
    saved = {'mode': mode, 'original_version': version, 'timer_active': active, 'paths': paths,
             'before': {path: Path(path).stat().st_mtime_ns for path in paths['kernel'] + paths['image']}}
    save(saved)
    run(['systemctl', 'stop', TIMER])
    target_version, target = repository_archive(['pacman'])
    if version != target_version:
        raise RuntimeError('Provision the guest with its repository kernel before running this fixture')
    saved.update(target_version=target_version, target=str(target))
    save(saved)
    if mode == 'upgrade':
        old_version, old = older_archive(version)
        saved.update(old_version=old_version)
        save(saved)
        run(['pacman', '-U', '--noconfirm', str(old)], stdout=subprocess.DEVNULL)
    else:
        saved['old_version'] = version
    artifacts = paths['kernel'] + paths['image']
    saved['before'] = {path: Path(path).stat().st_mtime_ns for path in artifacts}
    save(saved)
    for path, when, action in zip(HOOKS, ['PreTransaction', 'PostTransaction'], ['barrier', 'post']):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'''[Trigger]
Operation = Upgrade
Type = Package
Target = linux
[Action]
When = {when}
Exec = {FIXTURE} {action}
''')


def barrier():
    artifacts = settings()['before']
    (STATE / 'barrier.json').write_text(json.dumps({'missing': [path for path in artifacts if not Path(path).exists()]}))
    deadline = time.monotonic() + 180
    while not (STATE / 'release').exists():
        if time.monotonic() >= deadline:
            raise RuntimeError('Kernel commit barrier timed out')
        time.sleep(0.05)


def state():
    saved = settings()
    barrier = STATE / 'barrier.json'
    return {'mode': saved['mode'], 'target_version': saved['target_version'],
            'old_version': saved['old_version'], 'version': installed_version(required=False),
            'barrier': barrier.exists(), 'missing': json.loads(barrier.read_text())['missing'] if barrier.exists() else [],
            'artifacts': list(saved['before']), 'post': (STATE / 'post').exists(),
            'pids': backend_pids(), 'locked': Path('/var/lib/pacman/db.lck').exists()}


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify(require_rebuilt=True):
    saved = settings()
    if installed_version() != saved['target_version']:
        raise RuntimeError('The target kernel package is not installed')
    modules = [Path(path) for path in output(['pacman', '-Qlq', 'linux']).splitlines()
               if path.startswith('/usr/lib/modules/') and path.endswith('/vmlinuz')]
    if len(modules) != 1:
        raise RuntimeError('Expected one packaged kernel image')
    kernel_version = modules[0].parent.name
    for path in saved['paths']['kernel']:
        if digest(path) != digest(modules[0]):
            raise RuntimeError(f'Boot kernel does not match the installed module tree: {path}')
    for path in saved['paths']['image']:
        contents = output(['lsinitcpio', '--list', path])
        if f'usr/lib/modules/{kernel_version}/' not in contents:
            raise RuntimeError(f'Initramfs does not contain the installed kernel modules: {path}')
    if require_rebuilt:
        for path, previous in saved['before'].items():
            if Path(path).stat().st_mtime_ns == previous:
                raise RuntimeError(f'Boot artifact was not regenerated: {path}')
    return {'mode': saved['mode'], 'version': saved['target_version'], 'kernel_version': kernel_version,
            'kernels': saved['paths']['kernel'], 'images': saved['paths']['image']}


def cleanup():
    if not STATE.exists():
        return
    (STATE / 'release').touch()
    deadline = time.monotonic() + 180
    while backend_pids() or Path('/var/lib/pacman/db.lck').exists():
        if time.monotonic() >= deadline:
            raise RuntimeError('Kernel transaction is still running; leaving the guest for inspection')
        time.sleep(0.1)
    for path in HOOKS:
        path.unlink(missing_ok=True)
    saved = settings()
    if 'target' in saved:
        try:
            verify(require_rebuilt=False)
        except (RuntimeError, OSError, subprocess.CalledProcessError):
            run(['pacman', '-U', '--noconfirm', saved['target']], stdout=subprocess.DEVNULL)
            verify(require_rebuilt=False)
    if saved['timer_active']:
        run(['systemctl', 'start', TIMER])
    shutil.rmtree(STATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['setup', 'barrier', 'post', 'state', 'term', 'release', 'verify', 'cleanup'])
    parser.add_argument('--mode', choices=['upgrade', 'reinstall'], default='upgrade')
    args = parser.parse_args()
    if os.geteuid() != 0 or not (BASE / 'packages.json').is_file():
        raise SystemExit('Requires the provisioned disposable Cockpit E2E guest')
    if args.action == 'setup':
        setup(args.mode)
    elif args.action == 'barrier':
        barrier()
    elif args.action in ['post', 'release']:
        (STATE / args.action).touch()
    elif args.action == 'state':
        print(json.dumps(state()))
    elif args.action == 'verify':
        print(json.dumps(verify()))
    elif args.action == 'term':
        pids = backend_pids()
        if len(pids) != 1:
            raise RuntimeError(f'Expected one kernel transaction, found {len(pids)}')
        os.kill(pids[0], signal.SIGTERM)
    elif args.action == 'cleanup':
        cleanup()


if __name__ == '__main__':
    main()

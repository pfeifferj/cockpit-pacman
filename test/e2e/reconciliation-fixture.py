#!/usr/bin/env python3
import argparse
import base64
import ctypes
import ctypes.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess

BASE = Path('/run/cockpit-pacman-e2e')
STATE = BASE / 'reconciliation'
NAME = 'cockpit-pacman-e2e-reconcile.conf'
FILE_NAMES = (NAME, NAME + '.pacnew', NAME + '.pacsave')
TEMPORARY_PREFIX = '.cockpit-pacman-tmp.' + hashlib.sha256(NAME.encode()).hexdigest()[:16] + '.'
CURRENT = Path('/etc') / NAME
BACKUPS = Path('/etc/.cockpit-pacman-backups')
BACKEND = '/usr/libexec/cockpit-pacman/cockpit-pacman-backend'
XATTR = 'user.cockpit-pacman-e2e'
LOCAL = '# local configuration\nmode = local\nkeep = yes\nlong_setting = ' + 'x' * 180 + '\n'
PENDING = '# packaged configuration\nmode = packaged\nkeep = yes\nlong_setting = ' + 'y' * 180 + '\n'
EXTERNAL = '# external edit\nmode = external\nkeep = yes\n'


def temporary_paths():
    return sorted(path for path in CURRENT.parent.iterdir() if path.name.startswith(TEMPORARY_PREFIX))


def backup_paths():
    if not BACKUPS.is_dir():
        return []
    return sorted(path for path in BACKUPS.iterdir() if path.name.startswith(NAME + '.'))


def owned_paths():
    return ([path for path in CURRENT.parent.iterdir() if path.name in FILE_NAMES]
            + temporary_paths() + backup_paths())


def describe(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    record = {'path': str(path), 'mode': stat.S_IMODE(info.st_mode),
              'uid': info.st_uid, 'gid': info.st_gid}
    if stat.S_ISLNK(info.st_mode):
        return {**record, 'symlink': os.readlink(path)}
    if not stat.S_ISREG(info.st_mode):
        return {**record, 'unsupported': True}
    data = path.read_bytes()
    return {**record, 'content': data.decode(), 'bytes': base64.b64encode(data).decode(),
            'xattrs': {key: os.getxattr(path, key).decode() for key in os.listxattr(path)}}


def settings():
    return json.loads((STATE / 'settings.json').read_text())


def setup(scenario):
    if STATE.exists() or owned_paths():
        raise SystemExit('Reconciliation fixture already exists')
    STATE.mkdir(mode=0o700)
    kind = 'pacsave' if scenario == 'pacsave-missing' else 'pacnew'
    pending = Path(str(CURRENT) + '.' + kind)
    (STATE / 'settings.json').write_text(json.dumps({'path': str(pending), 'kind': kind}))
    if scenario != 'pacsave-missing':
        CURRENT.write_text(LOCAL)
        CURRENT.chmod(0o600)
        os.setxattr(CURRENT, XATTR, b'current')
    if scenario == 'symlink':
        target = STATE / 'outside-target'
        target.write_text('Do not replace this file.\n')
        pending.symlink_to(target)
    else:
        pending.write_text(PENDING)
        pending.chmod(0o600)
        os.setxattr(pending, XATTR, b'pending')
    print(json.dumps({'path': str(pending), 'current_path': str(CURRENT), 'kind': kind,
                      'current_content': None if scenario == 'pacsave-missing' else LOCAL,
                      'pending_content': PENDING}))


def state():
    pending = Path(settings()['path'])
    print(json.dumps({'current': describe(CURRENT), 'pending': describe(pending),
                      'backups': [describe(path) for path in backup_paths()],
                      'temporary': [describe(path) for path in temporary_paths()],
                      'outside': describe(STATE / 'outside-target')}))


def locked_resolve(request):
    library = ctypes.CDLL(ctypes.util.find_library('alpm'))
    library.alpm_initialize.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_int)]
    library.alpm_initialize.restype = ctypes.c_void_p
    for name in ('alpm_trans_init', 'alpm_trans_release', 'alpm_release'):
        method = getattr(library, name)
        method.argtypes = [ctypes.c_void_p, ctypes.c_int] if name == 'alpm_trans_init' else [ctypes.c_void_p]
        method.restype = ctypes.c_int
    error = ctypes.c_int()
    handle = library.alpm_initialize(b'/', b'/var/lib/pacman/', ctypes.byref(error))
    if not handle:
        raise SystemExit(f'Cannot initialize libalpm: {error.value}')
    transaction = False
    try:
        if library.alpm_trans_init(handle, 0) != 0:
            raise SystemExit('Cannot acquire a real pacman transaction lock')
        transaction = True
        process = subprocess.run([BACKEND, 'resolve-pacnew'], input=request, text=True,
                                 capture_output=True, timeout=20, check=False)
        print(json.dumps({'status': process.returncode, 'response': json.loads(process.stdout)}))
    finally:
        if transaction:
            library.alpm_trans_release(handle)
        library.alpm_release(handle)


def cleanup():
    if not STATE.exists():
        return
    for path in owned_paths():
        path.unlink()
    shutil.rmtree(STATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['setup', 'state', 'external-change', 'locked-resolve', 'cleanup'])
    parser.add_argument('--scenario', choices=['pacnew', 'pacsave-missing', 'symlink'], default='pacnew')
    parser.add_argument('--request')
    args = parser.parse_args()
    if os.geteuid() != 0 or not (BASE / 'packages.json').is_file():
        raise SystemExit('Requires the provisioned disposable Cockpit E2E guest')
    if args.action == 'setup':
        setup(args.scenario)
    elif args.action == 'state':
        state()
    elif args.action == 'external-change':
        settings()
        if CURRENT.is_symlink():
            raise SystemExit('The fixture current file became a symlink')
        CURRENT.write_text(EXTERNAL)
    elif args.action == 'locked-resolve':
        if not args.request:
            raise SystemExit('--request is required')
        locked_resolve(args.request)
    else:
        cleanup()


if __name__ == '__main__':
    main()

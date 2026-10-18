#!/usr/bin/env python3
"""Guest-only fixtures. Install explicitly on a disposable Arch system."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs
import urllib.request

STATE = Path('/run/cockpit-pacman-e2e')
BACKEND = '/usr/libexec/cockpit-pacman/cockpit-pacman-backend'
STATE_LOCK = threading.Lock()


def command(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def write(name, data, mode=0o600):
    path = STATE / name
    with tempfile.NamedTemporaryFile(mode='w', dir=STATE, delete=False) as temporary:
        json.dump(data, temporary)
        os.chmod(temporary.name, mode)
    os.replace(temporary.name, path)


def read(name):
    return json.loads((STATE / name).read_text())


def as_dev(args, **kwargs):
    user = pwd.getpwnam('dev')
    return command(['runuser', '-u', 'dev', '--', 'env', f'XDG_RUNTIME_DIR=/run/user/{user.pw_uid}',
                    f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{user.pw_uid}/bus', *args], **kwargs)


def credentials(enabled):
    if enabled:
        as_dev(['systemctl', '--user', 'start', 'gnome-keyring-daemon.service'])
        as_dev(['secret-tool', 'store', '--collection=/org/freedesktop/secrets/collection/session',
                '--label=Cockpit E2E', 'service', 'cockpit-pacman', 'type', 'archweb',
                'username', 'fixture'], input=read('credentials.json')['password'], text=True,
               stdout=subprocess.DEVNULL)
        state = read('service.json')
        state.update(signed=False, signed_packages=[], logins=0, logouts=0, signoff_bulk=False, fail_signoff=False)
        write('service.json', state)
    else:
        subprocess.run(['runuser', '-u', 'dev', '--', 'env',
                        f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{pwd.getpwnam("dev").pw_uid}/bus',
                        'secret-tool', 'clear', 'service', 'cockpit-pacman', 'type', 'archweb', 'username', 'fixture'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def prepare():
    STATE.mkdir(mode=0o755, exist_ok=True)
    if not (STATE / 'credentials.json').exists():
        write('credentials.json', {'password': secrets.token_urlsafe(24)})
    write('service.json', {'archive': 'failure', 'signed': False, 'signed_packages': [], 'downloads': 0, 'disconnections': 0, 'logins': 0, 'logouts': 0, 'signoff_bulk': False, 'fail_signoff': False})
    command(['loginctl', 'enable-linger', 'dev'])
    command(['systemctl', 'start', f'user@{pwd.getpwnam("dev").pw_uid}.service'])
    credentials(True)
    credentials(False)
    command(['pacman', '-Sw', '--noconfirm', 'htop'])
    target_url = subprocess.check_output(['pacman', '-Sp', '--print-format', '%l', 'htop'], text=True).strip()
    target = Path('/var/cache/pacman/pkg') / target_url.rsplit('/', 1)[1]
    signature = target.with_name(target.name + '.sig')
    if not signature.exists():
        urllib.request.urlretrieve(target_url + '.sig', signature)
    archives = STATE / 'archives'
    archives.mkdir(exist_ok=True)
    shutil.copy2(target, archives / target.name)
    shutil.copy2(signature, archives / signature.name)
    archive = STATE / 'archive.conf'
    archive.write_text('''[options]
Architecture = auto
SigLevel = Required DatabaseOptional
GPGDir = /etc/pacman.d/gnupg
[extra]
Server = https://archive.archlinux.org/repos/2026/06/01/$repo/os/$arch
''')
    database = STATE / 'archive-db'
    database.mkdir(exist_ok=True)
    archive_pacman = ['pacman', '--config', str(archive), '--dbpath', str(database)]
    command([*archive_pacman, '-Syddw', '--noconfirm', 'htop'])
    url = subprocess.check_output([*archive_pacman, '-Spdd', '--print-format', '%l', 'htop'], text=True).strip()
    cached = '/var/cache/pacman/pkg/' + url.rsplit('/', 1)[1]
    command(['pacman', '-U', '--noconfirm', cached])
    write('packages.json', {'original': cached, 'target': str(archives / target.name), 'cached_target': str(target)})
    command(['pacman', '-D', '--asdeps', 'tree'])
    command([BACKEND, 'set-schedule', 'false', 'check', 'weekly', '7'], stdout=subprocess.DEVNULL)
    command(['systemd-run', '--unit=cockpit-pacman-e2e-fixture', '--property=Restart=on-failure',
             '/usr/bin/python', str(Path(__file__).resolve()), 'serve'])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, data=b'', headers=None):
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/login/':
            self.reply(200, b'login', {'Set-Cookie': 'csrftoken=fixturecsrf; Path=/'})
        elif self.path == '/packages/signoffs/json/':
            if 'sessionid=fixture-session' not in self.headers.get('Cookie', ''):
                self.reply(403)
                return
            state = read('service.json')
            installed = subprocess.check_output(['pacman', '-Q', 'htop'], text=True).split()[1]
            group = {'pkgbase': 'htop', 'pkgnames': ['htop'], 'version': installed, 'arch': 'x86_64',
                     'repo': 'extra-testing', 'packager': 'Fixture Packager', 'comments': None,
                     'last_update': '2026-10-11T12:00:00Z', 'known_bad': False, 'approved': state['signed'],
                     'required': 1, 'enabled': True,
                     'signoffs': [{'user': 'fixture', 'created': '2026-10-11T12:01:00Z', 'revoked': False}] if state['signed'] else []}
            groups = [group]
            if state.get('signoff_bulk'):
                version = subprocess.check_output(['pacman', '-Q', 'tree'], text=True).split()[1]
                signed = 'tree' in state.get('signed_packages', [])
                groups.append({**group, 'pkgbase': 'tree', 'pkgnames': ['tree'], 'version': version,
                               'approved': signed, 'signoffs': [{'user': 'fixture', 'created': '2026-10-11T12:01:00Z', 'revoked': False}] if signed else []})
            self.reply(200, json.dumps({'signoff_groups': groups}).encode(), {'Content-Type': 'application/json'})
        elif self.path == '/archive/h/htop/':
            package = Path(read('packages.json')['target'])
            self.reply(200, f'<a href="{package.name}">htop</a> {package.stat().st_size}\n'.encode())
        elif self.path.startswith('/archive/h/htop/htop-'):
            package = Path(read('packages.json')['target'])
            if self.path.endswith('.sig'):
                with STATE_LOCK:
                    state = read('service.json')
                    state['signature_requests'] = state.get('signature_requests', 0) + 1
                    write('service.json', state)
                if state['archive'] == 'unsigned':
                    self.reply(404)
                    return
                self.reply(200, package.with_name(package.name + '.sig').read_bytes())
                return
            if self.path.rsplit('/', 1)[1] != package.name:
                self.reply(404)
                return
            with STATE_LOCK:
                state = read('service.json')
                state['downloads'] += 1
                write('service.json', state)
            if state['archive'] == 'failure':
                self.reply(503, b'fixture download unavailable')
            else:
                self.send_response(200)
                if state['archive'] != 'stall':
                    self.send_header('Content-Length', str(package.stat().st_size))
                self.end_headers()
                try:
                    with package.open('rb') as source:
                        deadline = time.monotonic() + 120
                        while chunk := source.read(512):
                            if time.monotonic() > deadline:
                                return
                            self.wfile.write(chunk)
                            self.wfile.flush()
                            if read('service.json')['archive'] == 'stall':
                                time.sleep(0.25)
                    with STATE_LOCK:
                        state = read('service.json')
                        state['completed'] = state.get('completed', 0) + 1
                        write('service.json', state)
                except (BrokenPipeError, ConnectionResetError):
                    with STATE_LOCK:
                        state = read('service.json')
                        state['disconnections'] += 1
                        write('service.json', state)
        else:
            self.reply(404)

    def do_POST(self):
        data = parse_qs(self.rfile.read(int(self.headers.get('Content-Length', '0'))).decode())
        if self.path == '/login/':
            if (data.get('username') != ['fixture'] or
                    data.get('password') != [read('credentials.json')['password']] or
                    data.get('csrfmiddlewaretoken') != ['fixturecsrf']):
                self.reply(403)
                return
            with STATE_LOCK:
                state = read('service.json')
                state['logins'] += 1
                write('service.json', state)
            self.reply(302, headers={'Set-Cookie': 'sessionid=fixture-session; Path=/', 'Location': '/'})
        elif self.path == '/logout/':
            with STATE_LOCK:
                state = read('service.json')
                state['logouts'] = state.get('logouts', 0) + 1
                write('service.json', state)
            self.reply(200)
        elif self.path in ('/packages/extra-testing/x86_64/htop/signoff/', '/packages/extra-testing/x86_64/htop/signoff/revoke/', '/packages/extra-testing/x86_64/tree/signoff/'):
            if 'sessionid=fixture-session' not in self.headers.get('Cookie', '') or data.get('csrfmiddlewaretoken') != ['fixturecsrf']:
                self.reply(403)
                return
            with STATE_LOCK:
                state = read('service.json')
                if '/tree/' in self.path:
                    if state.get('fail_signoff'):
                        self.reply(500)
                        return
                    state['signed_packages'] = ['tree']
                else:
                    state['signed'] = not self.path.endswith('/revoke/')
                write('service.json', state)
            self.reply(200)
        else:
            self.reply(404)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'serve', 'secrets-enable', 'secrets-disable',
                                          'archive-failure', 'archive-stall', 'archive-ready', 'archive-unsigned', 'archive-release',
                                          'signoffs-partial', 'signoffs-bulk', 'restore-package', 'state'])
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Guest fixture requires root')
    if args.action == 'prepare':
        prepare()
    elif args.action == 'serve':
        ThreadingHTTPServer(('127.0.0.1', 18080), Handler).serve_forever()
    elif args.action.startswith('secrets-'):
        credentials(args.action == 'secrets-enable')
    elif args.action.startswith('signoffs-'):
        state = read('service.json')
        state.update(signoff_bulk=True, fail_signoff=args.action == 'signoffs-partial')
        write('service.json', state)
    elif args.action.startswith('archive-'):
        state = read('service.json')
        state['archive'] = args.action.removeprefix('archive-')
        if args.action != 'archive-release':
            state.update(downloads=0, disconnections=0, completed=0, signature_requests=0)
            cached = Path(read('packages.json')['cached_target'])
            cached.unlink(missing_ok=True)
            cached.with_name(cached.name + '.sig').unlink(missing_ok=True)
        write('service.json', state)
    elif args.action == 'restore-package':
        packages = read('packages.json')
        command(['pacman', '-U', '--noconfirm', packages['original']], stdout=subprocess.DEVNULL)
        shutil.copy2(packages['target'], packages['cached_target'])
        shutil.copy2(packages['target'] + '.sig', packages['cached_target'] + '.sig')
    else:
        state = read('service.json')
        processes = subprocess.run(['pgrep', '-f', '^' + BACKEND + r'(\.real)? (preflight-downgrade-archive|downgrade-archive) '], capture_output=True, check=False)
        if processes.returncode not in (0, 1):
            raise SystemExit('Could not inspect archive download processes')
        state['active_transactions'] = len(processes.stdout.splitlines())
        print(json.dumps(state))


if __name__ == '__main__':
    main()

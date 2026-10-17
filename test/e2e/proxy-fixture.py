#!/usr/bin/env python3
"""Recording proxies and isolated origins for the disposable Arch guest."""
import argparse
import base64
from contextlib import closing
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
import os
from pathlib import Path
import pwd
import select
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess
import threading
import tempfile
import time
from urllib.parse import urlsplit

from fixture import STATE as BASE, read, command

STATE = BASE / 'proxy'
RUNTIME = STATE / 'runtime'
POLICY = Path('/etc/cockpit-pacman/proxy.json')
CONFIG = Path('/etc/cockpit-pacman/config.json')
PACMAN = Path('/etc/pacman.conf')
RESOLV = Path('/etc/resolv.conf')
NSSWITCH = Path('/etc/nsswitch.conf')
ANCHOR = Path('/etc/ca-certificates/trust-source/anchors/cockpit-proxy-e2e.pem')
CACHE = Path('/var/cache/cockpit-proxy-e2e')
UNIT = 'cockpit-pacman-proxy-e2e.service'
SCRIPT = '/usr/local/libexec/cockpit-pacman-e2e/proxy-fixture.py'
ORIGIN = '127.0.0.2'
HTTP_PORT, HTTPS_PORT, SOCKS_PORT, TLS_ORIGIN_PORT = 18082, 18443, 18084, 18444
USER, PASSWORD = 'proxy-user', 'fixture-p@ss'
LOCK = threading.Lock()


def record(**entry):
    with LOCK, (RUNTIME / 'records.jsonl').open('a') as out:
        out.write(json.dumps(entry) + '\n')


def blocked_packets():
    output = subprocess.check_output(['iptables-save', '-c'], text=True)
    for line in output.splitlines():
        if '-A OUTPUT -d 127.0.0.2/31 ' in line and '-j REJECT' in line:
            return int(line.split(':', 1)[0].removeprefix('['))
    return 0


def records():
    entries = [json.loads(line) for line in (RUNTIME / 'records.jsonl').read_text().splitlines()]
    baseline = int((STATE / 'blocked-start').read_text())
    return {'records': entries, 'blocked': blocked_packets() - baseline}


def destination(host, port):
    if host in ('only.proxy.invalid', 'localhost'):
        host = ORIGIN
    if host not in (ORIGIN, '127.0.0.3') or port not in (18081, TLS_ORIGIN_PORT):
        raise ValueError('Destination outside fixture')
    return host, port


def relay(client, upstream):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        ready = [sock for sock in (client, upstream) if isinstance(sock, ssl.SSLSocket) and sock.pending()]
        if not ready:
            ready, _, _ = select.select([client, upstream], [], [], 1)
        for source in ready:
            data = source.recv(65536)
            if not data:
                return
            (upstream if source is client else client).sendall(data)


class HTTP(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body=b'', headers=None):
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        if not any(name.lower() == 'content-length' for name in (headers or {})):
            self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)


class Origin(HTTP):
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        record(kind='origin', method=self.command, path=self.path,
               proxy_auth='Proxy-Authorization' in self.headers)
        if self.path == '/redirect':
            self.reply(302, headers={'Location': 'http://127.0.0.3:18081/mirrors'})
        elif self.path == '/news':
            body = f'<rss version="2.0"><channel><title>Proxy fixture</title><link>https://archlinux.org</link><description>News</description><item><title>Proxy news</title><link>https://archlinux.org/news/proxy-fixture/</link><pubDate>{formatdate(usegmt=True)}</pubDate><description>Recorded request</description></item></channel></rss>'
            self.reply(200, body.encode())
        elif self.path == '/issues/vulnerable.json':
            self.reply(200, b'[]')
        elif self.path.startswith('/package/'):
            self.reply(200, json.dumps({'name': 'htop', 'versions': [], 'advisories': [], 'groups': [], 'issues': []}).encode())
        elif self.path == '/mirrors':
            self.reply(200, json.dumps({'urls': [{'url': f'http://{ORIGIN}:18081/', 'country': 'Fixture', 'country_code': 'FX', 'completion_pct': 1, 'active': True}], 'last_check': None}).encode())
        elif self.path == '/core/os/x86_64/core.db':
            self.reply(200, b'x' * 200000)
        elif self.path.startswith('/pks/lookup'):
            self.reply(200, (STATE / 'keyserver-key.asc').read_bytes())
        elif self.path.startswith('/repo/'):
            name = self.path.removeprefix('/repo/')
            if '/' in name or name in ('.', '..'):
                self.reply(404)
            else:
                path = STATE / 'repo' / name
                self.reply(200, path.read_bytes()) if path.is_file() else self.reply(404)
        elif self.path.startswith(('/archive/', '/login/', '/packages/', '/logout/')):
            self.forward()
        else:
            self.reply(404)

    def forward(self):
        with closing(http.client.HTTPConnection('127.0.0.1', 18080, timeout=10)) as remote:
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            remote.request(self.command, self.path, body, dict(self.headers))
            response = remote.getresponse()
            headers = {name: value for name, value in response.getheaders() if name.lower() not in ('content-length', 'connection', 'server', 'date')}
            if self.command == 'HEAD':
                headers['Content-Length'] = response.getheader('Content-Length', '0')
            self.reply(response.status, response.read(), headers)

    def do_POST(self):
        record(kind='origin', method='POST', path=self.path, proxy_auth='Proxy-Authorization' in self.headers)
        self.forward()


class Proxy(HTTP):
    def authorized(self):
        expected = 'Basic ' + base64.b64encode(f'{USER}:{PASSWORD}'.encode()).decode()
        valid = self.headers.get('Proxy-Authorization') == expected
        record(kind='proxy', transport=self.server.transport, method=self.command, target=self.path, authorized=valid)
        if not valid:
            self.reply(407, headers={'Proxy-Authenticate': 'Basic realm="fixture"'})
        return valid

    def do_CONNECT(self):
        if not self.authorized():
            return
        host, port = self.path.rsplit(':', 1)
        with socket.create_connection(destination(host.strip('[]'), int(port)), timeout=5) as upstream:
            self.send_response(200)
            self.end_headers()
            relay(self.connection, upstream)

    def forward(self):
        if not self.authorized():
            return
        url = urlsplit(self.path)
        host, port = destination(url.hostname, url.port or 80)
        with closing(http.client.HTTPConnection(host, port, timeout=10)) as remote:
            headers = {name: value for name, value in self.headers.items() if name.lower() not in ('proxy-authorization', 'proxy-connection', 'connection')}
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            remote.request(self.command, url.path + ('?' + url.query if url.query else ''), body, headers)
            response = remote.getresponse()
            headers = {name: value for name, value in response.getheaders() if name.lower() not in ('content-length', 'connection', 'server', 'date')}
            if self.command == 'HEAD':
                headers['Content-Length'] = response.getheader('Content-Length', '0')
            self.reply(response.status, response.read(), headers)

    do_GET = do_HEAD = do_POST = forward


class TCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Socks(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        version, count = self.rfile.read(2)
        methods = self.rfile.read(count)
        if version != 5 or 2 not in methods:
            self.wfile.write(b'\x05\xff')
            return
        self.wfile.write(b'\x05\x02')
        version, length = self.rfile.read(2)
        user = self.rfile.read(length)
        password = self.rfile.read(self.rfile.read(1)[0])
        valid = version == 1 and user == USER.encode() and password == PASSWORD.encode()
        self.wfile.write(b'\x01' + (b'\x00' if valid else b'\x01'))
        if not valid:
            record(kind='socks', authorized=False)
            return
        version, command_byte, _, atyp = self.rfile.read(4)
        if atyp == 1:
            host = socket.inet_ntoa(self.rfile.read(4))
        elif atyp == 3:
            host = self.rfile.read(self.rfile.read(1)[0]).decode()
        elif atyp == 4:
            host = socket.inet_ntop(socket.AF_INET6, self.rfile.read(16))
        else:
            return
        port = struct.unpack('!H', self.rfile.read(2))[0]
        record(kind='socks', authorized=True, atyp=atyp, host=host, port=port)
        assert version == 5 and command_byte == 1
        with socket.create_connection(destination(host, port), timeout=5) as upstream:
            self.wfile.write(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00')
            relay(self.connection, upstream)


class DNS(socketserver.BaseRequestHandler):
    def handle(self):
        packet, sock = self.request
        labels, offset = [], 12
        while packet[offset]:
            length = packet[offset]
            labels.append(packet[offset + 1:offset + 1 + length].decode())
            offset += length + 1
        record(kind='dns', host='.'.join(labels))
        response = packet[:2] + b'\x81\x83' + packet[4:6] + b'\x00\x00' * 3 + packet[12:offset + 5]
        sock.sendto(response, self.client_address)


def serve():
    servers = []
    for address, port, handler, tls, transport in [
        (ORIGIN, 18081, Origin, False, 'origin'), ('127.0.0.3', 18081, Origin, False, 'origin'),
        ('127.0.0.1', 18085, Origin, False, 'keyserver'),
        (ORIGIN, TLS_ORIGIN_PORT, Origin, True, 'origin'), ('127.0.0.1', HTTP_PORT, Proxy, False, 'http'),
        ('127.0.0.1', HTTPS_PORT, Proxy, True, 'https'),
    ]:
        server = ThreadingHTTPServer((address, port), handler)
        server.transport = transport
        if tls:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(STATE / 'cert.pem', STATE / 'key.pem')
            server.socket = context.wrap_socket(server.socket, server_side=True)
        servers.append(server)
    servers.extend([TCPServer(('127.0.0.1', SOCKS_PORT), Socks),
                    socketserver.ThreadingUDPServer(('127.0.0.1', 53), DNS)])
    nobody = pwd.getpwnam('nobody')
    os.setgroups([])
    os.setgid(nobody.pw_gid)
    os.setuid(nobody.pw_uid)
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    (RUNTIME / 'ready').touch()
    threading.Event().wait()


def configure(mode):
    config = {'mode': 'proxy', 'all_proxy': f'http://{USER}:fixture-p%40ss@127.0.0.1:{HTTP_PORT}'}
    server = f'http://{ORIGIN}:18081/repo'
    if mode == 'https':
        config['all_proxy'] = f'https://{USER}:fixture-p%40ss@localhost:{HTTPS_PORT}'
        server = f'https://{ORIGIN}:{TLS_ORIGIN_PORT}/repo'
    elif mode in ('socks5', 'socks5h', 'socks-ip'):
        scheme = 'socks5' if mode != 'socks5h' else 'socks5h'
        config['all_proxy'] = f'{scheme}://{USER}:fixture-p%40ss@127.0.0.1:{SOCKS_PORT}'
        if mode != 'socks-ip':
            server = 'http://only.proxy.invalid:18081/repo'
    elif mode in ('bypass', 'redirect'):
        config['no_proxy'] = '127.0.0.2/32' if mode == 'bypass' else '127.0.0.3'
    elif mode == 'direct':
        config = {'mode': 'direct'}
    elif mode == 'bad-auth':
        config['all_proxy'] = f'http://{USER}:wrong-password@127.0.0.1:{HTTP_PORT}'
    elif mode == 'unreachable':
        config['all_proxy'] = f'http://{USER}:fixture-p%40ss@127.0.0.1:9'
    elif mode == 'bad-url':
        config['all_proxy'] = f'socks5h://{USER}:fixture-p%40ss@ho%zzst:1080'
    elif mode != 'http':
        raise ValueError(mode)
    POLICY.write_text(json.dumps(config))
    os.chown(POLICY, 0, pwd.getpwnam('dev').pw_gid)
    POLICY.chmod(0o640)
    marker = BASE / 'proxy-endpoints.json'
    marker.write_text(json.dumps({'base': f'http://{ORIGIN}:18081', 'mirrors': '/redirect' if mode == 'redirect' else '/mirrors'}))
    marker.chmod(0o644)
    PACMAN.write_text(f'''[options]
Architecture = auto
SigLevel = Required DatabaseOptional
LocalFileSigLevel = Optional
CacheDir = {CACHE}
[proxyfixture]
Server = {server}
''')
    (RUNTIME / 'records.jsonl').write_text('')
    (STATE / 'blocked-start').write_text(str(blocked_packets()))


def setup():
    assert os.geteuid() == 0 and (BASE / 'packages.json').exists()
    assert not STATE.exists() and not POLICY.exists() and not ANCHOR.exists() and not CACHE.exists()
    STATE.mkdir(mode=0o755)
    (STATE / 'owner').touch(mode=0o600)
    try:
        prepare_resources()
    except BaseException:
        cleanup()
        raise


def prepare_resources():
    CACHE.mkdir(mode=0o755)
    for name, path in [('pacman.conf', PACMAN), ('config.json', CONFIG), ('nsswitch.conf', NSSWITCH)]:
        shutil.copy2(path, STATE / name)
    caches = []
    for user in ('root', 'dev'):
        home_dir = Path(pwd.getpwnam(user).pw_dir)
        for name in ('news-cache.json', 'security-feed.json'):
            path = home_dir / '.config/cockpit-pacman' / name
            backup = STATE / f'{user}-{name}'
            info = path.stat() if path.exists() else None
            if info:
                shutil.copy2(path, backup)
            caches.append({'path': str(path), 'backup': str(backup), 'uid': info.st_uid if info else None, 'gid': info.st_gid if info else None})
    (STATE / 'caches.json').write_text(json.dumps(caches))
    resolver = {'link': os.readlink(RESOLV)} if RESOLV.is_symlink() else {'body': RESOLV.read_text()}
    (STATE / 'resolver.json').write_text(json.dumps(resolver))
    timer = subprocess.run(['systemctl', 'is-active', '--quiet', 'cockpit-pacman-scheduled.timer']).returncode == 0
    (STATE / 'timer.json').write_text(json.dumps(timer))
    command(['systemctl', 'stop', 'cockpit-pacman-scheduled.timer'])
    repo = STATE / 'repo'
    repo.mkdir()
    target = Path(read('packages.json')['target'])
    for path in [target, target.with_name(target.name + '.sig')]:
        shutil.copy2(path, repo / path.name)
    command(['repo-add', str(repo / 'proxyfixture.db.tar.gz'), str(repo / target.name)], stdout=subprocess.DEVNULL)
    command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=localhost',
             '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.2', '-keyout', str(STATE / 'key.pem'),
             '-out', str(STATE / 'cert.pem')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.copy2(STATE / 'cert.pem', ANCHOR)
    command(['trust', 'extract-compat'])
    RUNTIME.mkdir(mode=0o700)
    (RUNTIME / 'records.jsonl').touch()
    nobody = pwd.getpwnam('nobody')
    for path in [RUNTIME, RUNTIME / 'records.jsonl']:
        os.chown(path, nobody.pw_uid, nobody.pw_gid)
    command(['systemd-run', '--unit', UNIT, '/usr/bin/python', SCRIPT, 'serve'], stdout=subprocess.DEVNULL)
    deadline = time.monotonic() + 10
    while not (RUNTIME / 'ready').exists():
        assert time.monotonic() < deadline, 'Proxy fixture failed to start'
        time.sleep(0.1)
    command(['iptables', '-I', 'OUTPUT', '-d', '127.0.0.2/31', '-p', 'tcp', '--syn', '-m', 'owner', '!', '--uid-owner', str(nobody.pw_uid), '-j', 'REJECT'])
    (STATE / 'firewall').touch()
    (STATE / 'resolver-changed').touch()
    RESOLV.unlink()
    RESOLV.write_text('nameserver 127.0.0.1\noptions timeout:1 attempts:1\n')
    NSSWITCH.write_text('\n'.join('hosts: files dns' if line.startswith('hosts:') else line
                                  for line in NSSWITCH.read_text().splitlines()) + '\n')
    config = json.loads(CONFIG.read_text())
    config['security_advisories'] = True
    CONFIG.write_text(json.dumps(config))
    configure('http')


def reset_package():
    command(['pacman', '-U', '--noconfirm', read('packages.json')['original']], stdout=subprocess.DEVNULL)
    for path in CACHE.iterdir():
        path.unlink()
    for suffix in ('db', 'db.sig'):
        Path(f'/var/lib/pacman/sync/proxyfixture.{suffix}').unlink(missing_ok=True)
    (RUNTIME / 'records.jsonl').write_text('')
    (STATE / 'blocked-start').write_text(str(blocked_packets()))


def scheduled():
    config = json.loads(CONFIG.read_text())
    config['schedule'].update(enabled=True, mode='upgrade', max_packages=10)
    CONFIG.write_text(json.dumps(config))
    result = subprocess.run(['systemctl', 'start', 'cockpit-pacman-scheduled.service'], capture_output=True)
    record = json.loads(Path('/var/log/cockpit-pacman/scheduled.jsonl').read_text().splitlines()[-1])
    journal = subprocess.check_output(['journalctl', '-u', 'cockpit-pacman-scheduled.service', '--no-pager', '-n', '60'], text=True)
    for secret in (PASSWORD, 'fixture-p%40ss', USER, 'wrong-password', base64.b64encode(f'{USER}:{PASSWORD}'.encode()).decode()):
        assert secret not in result.stdout.decode() + result.stderr.decode() + journal + json.dumps(record)
    print(json.dumps({'returncode': result.returncode, 'record': record}))


def refresh():
    backend = '/usr/libexec/cockpit-pacman/cockpit-pacman-backend'
    environment = {name: value for name, value in os.environ.items() if not name.lower().endswith('_proxy')}
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen([backend, 'refresh-keyring'], stdin=subprocess.PIPE, stdout=output, stderr=output, env=environment)
        try:
            process.wait(timeout=20)
            assert process.returncode == 0
            output.seek(0)
            return [json.loads(line) for line in output.read().decode().splitlines()]
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            process.stdin.close()


def dirmngr_pid():
    response = subprocess.check_output(['gpg-connect-agent', '--homedir', str(STATE / 'dirmngr-home'), '--no-autostart', '--dirmngr', 'GETINFO pid', '/bye'], text=True)
    return next(line[2:] for line in response.splitlines() if line.startswith('D '))


def diagnostics():
    journal = subprocess.check_output(['journalctl', '-u', UNIT, '--no-pager', '-n', '120'], text=True)
    output = json.dumps({'traffic': records(), 'journal': journal})
    for secret in (PASSWORD, 'fixture-p%40ss', USER, 'wrong-password', base64.b64encode(f'{USER}:{PASSWORD}'.encode()).decode()):
        output = output.replace(secret, '[redacted]')
    print(output)


def keyring():
    fixture = str(Path(SCRIPT).with_name('keyring-fixture.py'))
    home_dir = STATE / 'dirmngr-home'
    home_dir.mkdir(mode=0o700)
    (home_dir / 'pubring.gpg').touch(mode=0o600)
    (home_dir / 'gpg.conf').write_text('keyserver hkp://127.0.0.1:18085\nauto-key-locate clear,wkd\n')
    (home_dir / 'dirmngr.conf').write_text('keyserver hkp://127.0.0.1:18085\n')
    command(['gpg', '--homedir', str(home_dir), '--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
             '--quick-generate-key', 'Proxy Fixture <fixture@only.proxy.invalid>', 'ed25519', 'sign', '1d'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with (STATE / 'keyserver-key.asc').open('wb') as public_key:
        command(['gpg', '--homedir', str(home_dir), '--armor', '--export'], stdout=public_key)
    command(['gpgconf', '--homedir', str(home_dir), '--launch', 'dirmngr'])
    before = dirmngr_pid()
    command([fixture, 'setup'])
    key_state = BASE / 'keyring'
    try:
        (key_state / 'bin/gpg').write_text('#!/bin/sh\nexec /usr/bin/gpg "$@"\n')
        (key_state / 'bin/pacman-key').write_text(f'#!/bin/sh\ntouch {key_state}/called\nexec /usr/bin/pacman-key --gpgdir {home_dir} "$@"\n')
        denied = refresh()
        assert denied[-1]['code'] == 'validation_error'
        assert not (key_state / 'called').exists()
        assert not any(entry['path'].startswith('/pks/') for entry in records()['records'] if entry['kind'] == 'origin')
        policy = json.loads(POLICY.read_text())
        policy['keyring'] = 'external'
        POLICY.write_text(json.dumps(policy))
        allowed = refresh()
        assert allowed[-1]['success'] is True, allowed
        assert (key_state / 'called').exists()
        assert dirmngr_pid() == before
        traffic = records()
        assert any(entry['path'].startswith('/pks/') for entry in traffic['records'] if entry['kind'] == 'origin')
        assert not any(entry['kind'] == 'proxy' for entry in traffic['records'])
        assert traffic['blocked'] == 0
        print(json.dumps({'denied': True, 'external': True, 'same_daemon': True}))
    finally:
        command([fixture, 'cleanup'])
        command(['gpgconf', '--homedir', str(home_dir), '--kill', 'all'])


def cleanup():
    if not STATE.exists():
        return
    owner = (STATE / 'owner').stat()
    assert owner.st_uid == 0 and not owner.st_mode & 0o077, 'Fixture ownership marker is unsafe'
    errors = []

    def attempt(action, *args):
        try:
            action(*args)
        except Exception as error:
            errors.append(error)

    (BASE / 'proxy-endpoints.json').unlink(missing_ok=True)
    POLICY.unlink(missing_ok=True)
    subprocess.run(['systemctl', 'stop', UNIT], check=False, stderr=subprocess.DEVNULL)
    if (STATE / 'firewall').exists():
        attempt(command, ['iptables', '-D', 'OUTPUT', '-d', '127.0.0.2/31', '-p', 'tcp', '--syn', '-m', 'owner', '!', '--uid-owner', str(pwd.getpwnam('nobody').pw_uid), '-j', 'REJECT'])
    if (STATE / 'resolver-changed').exists():
        resolver = json.loads((STATE / 'resolver.json').read_text())
        RESOLV.unlink(missing_ok=True)
        if 'link' in resolver:
            attempt(RESOLV.symlink_to, resolver['link'])
        else:
            attempt(RESOLV.write_text, resolver['body'])
    for name, path in [('pacman.conf', PACMAN), ('config.json', CONFIG), ('nsswitch.conf', NSSWITCH)]:
        if (STATE / name).exists():
            attempt(shutil.copy2, STATE / name, path)
    if (STATE / 'caches.json').exists():
        for cache in json.loads((STATE / 'caches.json').read_text()):
            path = Path(cache['path'])
            if cache['uid'] is None:
                path.unlink(missing_ok=True)
            else:
                attempt(shutil.copy2, cache['backup'], path)
                attempt(os.chown, path, cache['uid'], cache['gid'])
    ANCHOR.unlink(missing_ok=True)
    attempt(command, ['trust', 'extract-compat'])
    attempt(command, [str(Path(SCRIPT).with_name('fixture.py')), 'restore-package'])
    for suffix in ('db', 'db.sig'):
        Path(f'/var/lib/pacman/sync/proxyfixture.{suffix}').unlink(missing_ok=True)
    if CACHE.exists():
        attempt(shutil.rmtree, CACHE)
    if (STATE / 'timer.json').exists() and json.loads((STATE / 'timer.json').read_text()):
        attempt(command, ['systemctl', 'start', 'cockpit-pacman-scheduled.timer'])
    subprocess.run(['systemctl', 'reset-failed', 'cockpit-pacman-scheduled.service'], check=False, stderr=subprocess.DEVNULL)
    if errors:
        raise ExceptionGroup('Proxy fixture cleanup failed', errors)
    shutil.rmtree(STATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['setup', 'serve', 'configure', 'records', 'diagnostics', 'reset-package', 'scheduled', 'keyring', 'cleanup'])
    parser.add_argument('mode', nargs='?')
    args = parser.parse_args()
    assert os.geteuid() == 0 and (BASE / 'packages.json').exists(), 'Requires the disposable E2E guest'
    if args.action == 'configure':
        configure(args.mode)
    elif args.action == 'records':
        print(json.dumps(records()))
    else:
        {'setup': setup, 'serve': serve, 'diagnostics': diagnostics, 'reset-package': reset_package,
         'scheduled': scheduled, 'keyring': keyring, 'cleanup': cleanup}[args.action]()


if __name__ == '__main__':
    main()

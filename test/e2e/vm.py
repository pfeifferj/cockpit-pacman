#!/usr/bin/env python3
"""Boot a disposable Arch/Cockpit guest and run the browser suite against it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
IMAGE_URL = 'https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2'


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def terminate(_signal, _frame):
    raise SystemExit(143)


def run_tests(session, tests):
    env = os.environ.copy()
    env.update(COCKPIT_URL=session['url'], COCKPIT_USER='dev', COCKPIT_PASSWORD=session['password'],
               COCKPIT_E2E_FIXTURE='1', COCKPIT_FAULT_TESTS='1')
    run(['npx', 'playwright', 'test', *tests], cwd=ROOT, env=env, timeout=1800)


def inspect_guest(work, session, seconds):
    if not seconds:
        return
    connection = work / 'connection.json'
    connection.write_text(json.dumps(session))
    connection.chmod(0o600)
    print(f'Inspection session: {connection}; removed in {seconds}s', flush=True)
    time.sleep(seconds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path)
    parser.add_argument('--timeout', type=int, default=3600)
    parser.add_argument('--inspect-seconds', type=int, default=0, choices=range(3601), metavar='0..3600')
    parser.add_argument('--inspect-on-success', action='store_true', help='also keep a successful guest for --inspect-seconds')
    parser.add_argument('--session', type=Path, help='rerun tests against a guest waiting after a failure')
    parser.add_argument('tests', nargs='*')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, terminate)
    if args.session:
        run_tests(json.loads(args.session.read_text()), args.tests)
        return
    with tempfile.TemporaryDirectory(prefix='cockpit-pacman-e2e-') as directory:
        work = Path(directory)
        os.chmod(work, 0o700)
        image = args.image
        if image is None:
            image = work / 'arch.qcow2'
            urllib.request.urlretrieve(IMAGE_URL, image)
            expected = urllib.request.urlopen(IMAGE_URL + '.SHA256', timeout=30).read().decode().split()[0]
            with image.open('rb') as source:
                if hashlib.file_digest(source, 'sha256').hexdigest() != expected:
                    raise RuntimeError('Arch cloud image checksum mismatch')
        image = image.resolve()
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(image), str(work / 'disk.qcow2'), '24G'])
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(work / 'id')])
        password = secrets.token_urlsafe(32)
        hashed = run(['openssl', 'passwd', '-6', '-stdin'], input=password + '\n', text=True, capture_output=True).stdout.strip()
        key = (work / 'id.pub').read_text().strip()
        seed = {
            'disable_root': False,
            'ssh_pwauth': False,
            'users': [
                {'name': 'root', 'ssh_authorized_keys': [key]},
                {'name': 'dev', 'groups': ['wheel'], 'shell': '/bin/bash', 'lock_passwd': False,
                 'hashed_passwd': hashed, 'sudo': 'ALL=(ALL) NOPASSWD:ALL'},
            ],
            'package_update': True,
            'package_upgrade': True,
            'packages': ['cockpit', 'sudo', 'rsync', 'python', 'rust', 'base-devel', 'openssl',
                         'gnome-keyring', 'libsecret', 'htop', 'tree', 'curl'],
            'runcmd': [['systemctl', 'enable', '--now', 'cockpit.socket'], ['loginctl', 'enable-linger', 'dev']],
        }
        (work / 'user-data').write_text('#cloud-config\n' + json.dumps(seed))
        (work / 'meta-data').write_text('instance-id: cockpit-pacman-' + secrets.token_hex(8) + '\n')
        run(['xorriso', '-as', 'mkisofs', '-quiet', '-V', 'CIDATA', '-J', '-r', '-o', str(work / 'seed.iso'),
             str(work / 'user-data'), str(work / 'meta-data')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ssh_port, cockpit_port = port(), port()
        ssh = ['ssh', '-i', str(work / 'id'), '-p', str(ssh_port), '-o', 'BatchMode=yes',
               '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
               '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=3', 'root@127.0.0.1']
        session = {'url': f'https://127.0.0.1:{cockpit_port}', 'password': password, 'ssh': ssh}
        with (work / 'serial.log').open('wb') as serial:
            guest = subprocess.Popen([
                'qemu-system-x86_64', '-machine', 'accel=kvm:tcg', '-m', '4096', '-smp', '2',
                '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
                '-drive', f'file={work}/disk.qcow2,format=qcow2,if=virtio',
                '-drive', f'file={work}/seed.iso,format=raw,media=cdrom',
                '-netdev', f'user,id=net,hostfwd=tcp:127.0.0.1:{ssh_port}-:22,hostfwd=tcp:127.0.0.1:{cockpit_port}-:9090',
                '-device', 'virtio-net-pci,netdev=net',
            ], stdout=serial, stderr=serial)
            try:
                deadline = time.monotonic() + 600
                while subprocess.run(ssh + ['true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                    if guest.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError('Arch guest did not become reachable; serial log withheld because cloud-init handles credentials')
                    time.sleep(3)
                print('Arch guest reachable; waiting for provisioning', flush=True)
                run(ssh + ['cloud-init status --wait'], timeout=900)
                rsync_ssh = ' '.join(ssh[:-1])
                run(['rsync', '-a', '--exclude=.git', '--exclude=node_modules', '--exclude=backend/target*',
                     '--exclude=.auth', '--exclude=.work*', '--exclude=.calira', '--exclude=test-results',
                     '--exclude=playwright-report', '-e', rsync_ssh, str(ROOT) + '/', 'root@127.0.0.1:/opt/cockpit-pacman/'])
                run(ssh + ['cd /opt/cockpit-pacman && timeout ' + str(args.timeout) + ' bash test/e2e/provision.sh'], timeout=args.timeout + 30)
                run_tests(session, args.tests)
                if args.inspect_on_success:
                    inspect_guest(work, session, args.inspect_seconds)
            except Exception:
                inspect_guest(work, session, args.inspect_seconds)
                raise
            finally:
                guest.terminate()
                try:
                    guest.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    guest.kill()
                    guest.wait()


if __name__ == '__main__':
    main()

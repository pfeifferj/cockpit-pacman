#!/usr/bin/env python3
"""Exercise proxy policy in the disposable guest, including native transactions."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

from fixture import BACKEND, STATE, read

POLICY = Path('/etc/cockpit-pacman/proxy.json')
CONFIG = Path('/etc/cockpit-pacman/config.json')


def run(args, *, user=None, env=None):
    environment = {name: value for name, value in os.environ.items() if not name.lower().endswith('_proxy')}
    environment.update(env or {})
    if user:
        args = ['runuser', '-u', user, '--', *args]
    # Keep stdin open until exit: EOF requests cancellation of interactive mutations.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=output, stderr=errors, env=environment) as process:
            try:
                process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                raise
            output.seek(0)
            errors.seek(0)
            return process.returncode, output.read().decode(), errors.read().decode()


def backend(*args, **kwargs):
    code, output, error = run([BACKEND, *args], **kwargs)
    assert code == 0, (args, code, error)
    return [json.loads(line) for line in output.splitlines() if line.strip()]


def rejected(*args, **kwargs):
    events = backend(*args, **kwargs)
    assert events[-1]['code'] == 'validation_error', (args, events)
    assert not any(event.get('success') for event in events), (args, events)


def policy(value, mode=0o644):
    POLICY.write_text(json.dumps(value))
    POLICY.chmod(mode)


def cached_dependency_guard():
    pacman_conf = Path('/etc/pacman.conf')
    original = pacman_conf.read_bytes()
    cached = Path('/var/cache/pacman/pkg/cockpit-proxy-local-1-1-any.pkg.tar.zst')
    try:
        with tempfile.TemporaryDirectory(prefix='cockpit-proxy-dependency-') as directory:
            work = Path(directory)
            work.chmod(0o755)
            archives = []
            for name, dependency in [('cockpit-proxy-dependency', ''), ('cockpit-proxy-local', 'depend = cockpit-proxy-dependency\n')]:
                tree = work / name
                tree.mkdir()
                (tree / '.PKGINFO').write_text(f'pkgname = {name}\npkgver = 1-1\npkgdesc = Proxy policy fixture\narch = any\nsize = 0\n{dependency}')
                archive = work / f'{name}-1-1-any.pkg.tar.zst'
                subprocess.run(['bsdtar', '--zstd', '-cf', str(archive), '-C', str(tree), '.PKGINFO'], check=True)
                archives.append(archive)
            cached.write_bytes(archives[1].read_bytes())
            subprocess.run(['repo-add', str(work / 'proxydep.db.tar.gz'), str(archives[0])], check=True, stdout=subprocess.DEVNULL)
            pacman_conf.write_text(f'[options]\nArchitecture = auto\nSigLevel = Never\nLocalFileSigLevel = Optional\n[proxydep]\nServer = file://{work}\n')
            subprocess.run(['pacman', '-Sy', '--noconfirm'], check=True, stdout=subprocess.DEVNULL)
            rejected('downgrade', 'cockpit-proxy-local', '1-1')
            for name in ['cockpit-proxy-local', 'cockpit-proxy-dependency']:
                assert subprocess.run(['pacman', '-Q', name], capture_output=True).returncode != 0
            assert not Path('/var/lib/pacman/db.lck').exists()
    finally:
        pacman_conf.write_bytes(original)
        cached.unlink(missing_ok=True)
        Path('/var/lib/pacman/sync/proxydep.db').unlink(missing_ok=True)


def main():
    assert os.geteuid() == 0 and STATE.is_dir(), 'Run only in the E2E guest'
    assert not POLICY.exists(), 'Guest proxy policy must start absent'
    original_config = CONFIG.read_bytes()
    installed = subprocess.check_output(['pacman', '-Q', 'htop'], text=True).strip()
    original_version = installed.split()[1]
    packages = read('packages.json')
    completed = []
    try:
        policy({'mode': 'proxy', 'all_proxy': 'http://secret:p%40ss@127.0.0.1:9', 'unknown': True})
        for args in [('sync-database',), ('upgrade',), ('install-package', 'htop'),
                     ('downgrade-archive', 'htop', Path(packages['target']).name),
                     ('refresh-keyring',), ('test-mirrors', 'http://127.0.0.1:18080/$repo/os/$arch', '5'),
                     ('list-archive-versions', 'htop'), ('fetch-mirror-status',)]:
            rejected(*args)
            assert not Path('/var/lib/pacman/db.lck').exists(), args
        assert subprocess.check_output(['pacman', '-Q', 'htop'], text=True).strip() == installed
        completed.append('invalid policy blocks HTTP, database, install, archive and keyring transfers')

        for args in [('list-installed',), ('check-updates',), ('keyring-status',), ('list-downgrades', 'htop')]:
            result = backend(*args, user='dev')
            assert result and 'code' not in result[-1], args
        removed = backend('remove-package', 'htop')
        assert removed[-1].get('success') is True, removed
        assert subprocess.run(['pacman', '-Q', 'htop'], capture_output=True).returncode != 0
        restored = backend('downgrade', 'htop', original_version)
        assert restored[-1].get('success') is True, restored
        assert subprocess.check_output(['pacman', '-Q', 'htop'], text=True).strip() == installed
        cached_dependency_guard()
        completed.append('offline queries, removal and signed cached installation survive invalid policy')

        config = json.loads(original_config)
        config['schedule']['enabled'] = True
        CONFIG.write_text(json.dumps(config))
        result = subprocess.run(['systemctl', 'start', 'cockpit-pacman-scheduled.service'], capture_output=True)
        assert result.returncode != 0
        record = json.loads(Path('/var/log/cockpit-pacman/scheduled.jsonl').read_text().splitlines()[-1])
        assert record['status'] == 'failed', record
        assert record['error'] == backend('fetch-mirror-status')[-1]['message'], record
        journal = subprocess.check_output(['journalctl', '-u', 'cockpit-pacman-scheduled.service', '-n', '30', '--no-pager', '-o', 'json'], text=True)
        assert any(json.loads(line).get('PRIORITY') == '4' for line in journal.splitlines())
        for secret in ('secret', 'p%40ss', 'p@ss'):
            assert secret not in json.dumps(record) + journal
        completed.append('scheduled policy failure exits nonzero and records a credential-safe failure')

        policy({'mode': 'direct'}, 0o600)
        rejected('list-archive-versions', 'htop', user='dev')
        assert 'packages' in backend('list-archive-versions', 'htop')[-1]
        policy({'mode': 'direct'}, 0o644)
        assert 'packages' in backend('list-archive-versions', 'htop', user='dev', env={
            'http_proxy': 'http://127.0.0.1:9', 'ALL_PROXY': 'socks5h://127.0.0.1:9',
            'https_proxy': 'invalid://proxy', 'ftp_proxy': 'http://127.0.0.1:9'})[-1]
        rejected('refresh-keyring')
        completed.append('unreadable policy fails closed; direct mode clears inherited aliases')

        policy({'mode': 'proxy', 'all_proxy': 'http://user:password@127.0.0.1:9'})
        rejected('list-archive-versions', 'htop')
        policy({'mode': 'direct'}, 0o666)
        rejected('list-archive-versions', 'htop')
        POLICY.unlink()
        POLICY.symlink_to(CONFIG)
        rejected('list-archive-versions', 'htop')
        POLICY.unlink()
        os.mkfifo(POLICY, 0o600)
        rejected('list-archive-versions', 'htop')
        POLICY.unlink()
        completed.append('unsafe permissions, credential exposure, symlinks and FIFOs are refused')

        rejected('refresh-keyring', env={'all_proxy': 'http://127.0.0.1:9', 'no_proxy': '*'})
        policy({'mode': 'inherit'})
        rejected('refresh-keyring', env={'https_proxy': 'invalid://user:password@proxy'})
        completed.append('inherited proxy bypass never authorizes independent keyring networking')
    finally:
        POLICY.unlink(missing_ok=True)
        CONFIG.write_bytes(original_config)
        subprocess.run(['systemctl', 'reset-failed', 'cockpit-pacman-scheduled.service'], check=True)
        subprocess.run(['pacman', '-U', '--noconfirm', packages['original']], check=True, stdout=subprocess.DEVNULL)
    print(json.dumps(completed))


if __name__ == '__main__':
    main()

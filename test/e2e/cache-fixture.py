#!/usr/bin/env python3
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

MARKER = Path("/run/cockpit-pacman-e2e/cache-dir")


def package(cache, name, version, arch="any"):
    metadata = (
        f"pkgname = {name}\npkgver = {version}\npkgdesc = Cache browser fixture\n"
        f"arch = {arch}\nsize = 0\nbuilddate = 0\npackager = E2E fixture\n"
    ).encode()
    content = io.BytesIO()
    with tarfile.open(fileobj=content, mode="w") as archive:
        entry = tarfile.TarInfo(".PKGINFO")
        entry.size = len(metadata)
        archive.addfile(entry, io.BytesIO(metadata))
    path = cache / f"{name}-{version}-{arch}.pkg.tar.zst"
    with path.open("wb") as output:
        subprocess.run(["zstd", "-q", "-c"], input=content.getvalue(), stdout=output, check=True)


def prepare():
    if MARKER.exists():
        raise RuntimeError("a cache fixture is already active")
    cache = Path(tempfile.mkdtemp(prefix="cockpit-pacman-cache-e2e-", dir="/var/tmp"))
    cache.chmod(0o755)
    try:
        for index in range(55):
            for version in range(60 if index == 0 else 2):
                package(cache, f"cache-fixture-{index:03}", f"{version}-1")
        package(cache, "cache-fixture-000", "59-1", "x86_64")
        subprocess.run(["pacman", "-Qp", str(cache / "cache-fixture-001-0-1-any.pkg.tar.zst")], check=True, stdout=subprocess.DEVNULL)
        MARKER.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        with MARKER.open("x") as marker:
            marker.write(str(cache) + "\n")
        MARKER.chmod(0o644)
        print(json.dumps({"path": str(cache), "groups": 55, "files": 169}))
    except BaseException:
        if MARKER.exists() and MARKER.read_text().strip() == str(cache):
            MARKER.unlink()
        shutil.rmtree(cache)
        raise


def cleanup(path):
    cache = Path(path)
    if cache.parent != Path("/var/tmp") or not cache.name.startswith("cockpit-pacman-cache-e2e-"):
        raise ValueError("unexpected cache fixture path")
    if MARKER.exists():
        if MARKER.read_text().strip() != str(cache):
            raise RuntimeError("a different cache fixture is active")
        MARKER.unlink()
    shutil.rmtree(cache)


if os.geteuid() != 0:
    raise SystemExit("Run the cache fixture inside the disposable guest as root")
if sys.argv[1] == "prepare":
    prepare()
elif sys.argv[1] == "cleanup":
    cleanup(sys.argv[2])
else:
    raise SystemExit("Usage: cache-fixture.py prepare | cleanup PATH")

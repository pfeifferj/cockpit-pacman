# Browser integration target

The suite needs an Arch guest with systemd, Cockpit and the installed plugin.
From a checkout with dependencies installed:

```sh
npm run build
cp src/index.html src/manifest.json dist/
npx playwright install chromium
python3 test/e2e/vm.py
```

The runner downloads and checksums the official Arch cloud image, creates an
overlay, generates temporary login credentials, and forwards SSH and Cockpit
to localhost. It builds the Rust backend in the guest against that guest's
libalpm. QEMU uses KVM when available and falls back to TCG. Install QEMU,
xorriso, rsync, OpenSSH and OpenSSL on the host first. `--image PATH` reuses an
existing cloud image; trailing test paths limit the Playwright run.

`--inspect-seconds N` keeps a failed guest available for up to 3600 seconds,
then removes it. Add `--inspect-on-success` to keep a successful guest too.
The printed connection file is private and contains login
credentials. `--session PATH` reruns tests against that guest while it is
available; do not attach the connection file to reports.

The guest and temporary credential files are removed when the run finishes,
fails or receives a termination signal. Serial output is private because
cloud-init handles credentials. Authentication traces and videos remain off.

`provision.sh` requires a disposable Arch guest with the packages and `dev`
account specified in `vm.py`. It installs an explicit test backend wrapper and
the `e2e-fixtures` backend build. The wrapper points ArchWeb and archive
requests at a loopback HTTP service.
Builds without `e2e-fixtures` ignore these endpoint variables.

The fixture provides a real session bus and Secret Service with disposable
ArchWeb credentials. Signoffs exercise D-Bus retrieval, stdin delivery, Rust
HTTP authentication, signoff and revocation against the local service. No real
Arch account or live signoffs are modified. Archive tests exercise a failing
HTTP download and a stalled transfer of a signed package through the same
transaction path. Cancellation is checked after releasing that transfer; an
uncancelled control installs the same package and then restores the original.

The pending htop fixture retains the current repository archive and installs
the signed version from the 2026-06-01 Arch archive. Tree is marked as a
dependency to provide an orphan. Tests restore package versions and schedule
settings; the entire guest is discarded after the suite.
The runner enables the scheduled reporting fault tests, including service
termination and a full temporary log filesystem, only within this guest.

Cache pagination tests may install a root-owned, non-writable-by-others marker
at `/run/cockpit-pacman-e2e/cache-dir`. The test wrapper uses that directory only
for cache commands. This marker is never read by a production backend.

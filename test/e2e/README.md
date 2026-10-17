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
ArchWeb credentials in the unlocked session collection. The login collection
can remain locked. Signoffs exercise D-Bus retrieval, stdin delivery, Rust
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

Commit cancellation tests select an isolated local repository with a fixture
package. They pause real PreTransaction hooks and package scriptlets, send
cancellation or SIGTERM, then check the installed payload, PostTransaction
hook marker, database lock, and process exit. They also close a Cockpit process
channel, stop the scheduled unit, and combine cancellation with a failing hook.
The fixture restores the saved configuration and package state after each test.
`kernel-commit-safety.spec.ts` checks a real signed Linux kernel upgrade. It
retains the current repository archive, installs an older signed kernel from
the cache or the 2026-06-01 Arch archive, then pauses the backend upgrade after
the real mkinitcpio removal hook. After confirming that the preset boot files
are absent, it sends SIGTERM and releases the barrier. It checks that the boot
kernel matches the installed module tree and that `lsinitcpio` can read the
regenerated images and find the new kernel modules. Cleanup restores the
original kernel; the running guest is discarded without rebooting.

This test may download a kernel archive and run mkinitcpio several times.
`COCKPIT_KERNEL_REINSTALL=1` selects a same-version reinstall if only the current
archive is available. That mode checks post-hook regeneration but does not
cover the removal of old-version boot artifacts and is not a substitute for
the default upgrade test.

Keyring cancellation uses a root-owned fixture directory to select fake
`gpg` and `pacman-key` commands in the E2E wrapper. Its grandchild holds a
temporary file lock. The browser test checks that cancelling refresh ends both
processes and releases that lock; the real pacman keyring is not modified.

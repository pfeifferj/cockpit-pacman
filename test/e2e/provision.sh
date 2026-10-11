#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo build --manifest-path backend/Cargo.toml --features e2e-fixtures
install -d /usr/share/cockpit/pacman /usr/libexec/cockpit-pacman /usr/local/libexec/cockpit-pacman-e2e
install -m 0644 dist/* /usr/share/cockpit/pacman/
install -m 0755 backend/target/debug/cockpit-pacman-backend /usr/libexec/cockpit-pacman/cockpit-pacman-backend.real
install -m 0755 test/e2e/backend.py /usr/libexec/cockpit-pacman/cockpit-pacman-backend
install -m 0755 test/e2e/*.py /usr/local/libexec/cockpit-pacman-e2e/
install -m 0644 systemd/*.service systemd/*.timer /usr/lib/systemd/system/
systemctl daemon-reload
python /usr/local/libexec/cockpit-pacman-e2e/fixture.py prepare

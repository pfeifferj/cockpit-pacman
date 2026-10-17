#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
proxy_work=$(mktemp -d)
proxy_anchor=/etc/ca-certificates/trust-source/anchors/cockpit-pacman-e2e-proxy.pem
test ! -e "$proxy_anchor"
trap 'rm -f "$proxy_anchor"; trust extract-compat; rm -rf "$proxy_work"' EXIT
openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost -keyout "$proxy_work/key.pem" \
    -out "$proxy_work/cert.pem" >/dev/null 2>&1
install -m 0644 "$proxy_work/cert.pem" "$proxy_anchor"
trust extract-compat
PROXY_TEST_CERT="$proxy_work/cert.pem" PROXY_TEST_KEY="$proxy_work/key.pem" \
    cargo test --locked --manifest-path backend/Cargo.toml -p arch-http-client -- --include-ignored

VERSION := $(shell sed -n 's/^## \[\([0-9.]*\)\].*/\1/p;T;q' CHANGELOG.md)
PREFIX = /usr
DESTDIR =
LIBEXECDIR = $(PREFIX)/libexec/cockpit-pacman
DEVEL_PREFIX = $(HOME)/.local
TARFILE = cockpit-pacman-$(VERSION).tar.xz

BACKEND_BIN = backend/target/release/cockpit-pacman-backend

.PHONY: all build build-backend build-frontend generate-types clean install install-check devel-install lint lint-frontend lint-backend test test-frontend test-backend test-e2e test-e2e-ui check dist

all: build install
	@if [ -n "$$SUDO_USER" ] && [ -d node_modules ]; then chown -R $$SUDO_USER node_modules; fi

build: build-backend build-frontend

build-backend:
	cd backend && cargo build --release --locked

# Regenerate the TypeScript wire types from the Rust serde structs (ts-rs).
# The export logic lives in #[cfg(test)] code, so this runs via cargo test.
generate-types:
	cd backend && cargo test --locked --quiet export_bindings

build-frontend: generate-types
	npm ci
	npm run build
	cp src/manifest.json dist/
	cp src/index.html dist/

clean:
	cd backend && cargo clean
	rm -rf node_modules dist

dist:
	git archive --format=tar --prefix=cockpit-pacman-$(VERSION)/ HEAD | xz > $(TARFILE)

install:
	node tools/install.mjs system "$(DESTDIR)" "$(PREFIX)" "$(LIBEXECDIR)" "$(BACKEND_BIN)" dist

install-check:
	node tools/install.mjs system "$(DESTDIR)" "$(PREFIX)" "$(LIBEXECDIR)" "$(BACKEND_BIN)" dist --check

devel-install: build
	node tools/install.mjs development "$(DEVEL_PREFIX)" "$(BACKEND_BIN)" dist

# Linting
lint: lint-frontend lint-backend

lint-frontend:
	npm run lint

lint-backend:
	cd backend && cargo clippy --locked --workspace --all-targets -- -D warnings

# Testing
test: test-frontend test-backend

test-frontend:
	npm ci --dry-run --no-audit --no-fund
	node --test test/install.test.mjs
	npm test

test-backend:
	cd backend && cargo test --locked --workspace

test-e2e:
	npm run test:e2e

test-e2e-ui:
	npm run test:e2e:ui

check: lint
	npm run typecheck
	$(MAKE) test

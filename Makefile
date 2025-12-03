VERSION = 0.1.0
PREFIX = /usr
DESTDIR =

BACKEND_BIN = backend/target/release/cockpit-pacman-backend

.PHONY: all build build-backend build-frontend clean install devel-install lint lint-frontend lint-backend test test-frontend test-backend check

all: build install

build: build-backend build-frontend

build-backend:
	cd backend && cargo build --release

build-frontend:
	npm ci
	npm run build
	cp src/manifest.json dist/
	cp src/index.html dist/

clean:
	cd backend && cargo clean
	rm -rf node_modules dist

install:
	install -d $(DESTDIR)$(PREFIX)/share/cockpit/pacman
	install -d $(DESTDIR)$(PREFIX)/libexec/cockpit-pacman
	install -m 644 dist/* $(DESTDIR)$(PREFIX)/share/cockpit/pacman/
	install -m 755 $(BACKEND_BIN) $(DESTDIR)$(PREFIX)/libexec/cockpit-pacman/

devel-install: build
	mkdir -p ~/.local/share/cockpit
	ln -snf $(CURDIR)/dist ~/.local/share/cockpit/pacman
	mkdir -p ~/.local/libexec/cockpit-pacman
	ln -snf $(CURDIR)/$(BACKEND_BIN) ~/.local/libexec/cockpit-pacman/cockpit-pacman-backend

# Linting
lint: lint-frontend lint-backend

lint-frontend:
	npm run lint

lint-backend:
	cd backend && cargo clippy -- -D warnings

# Testing
test: test-frontend test-backend

test-frontend:
	npm test

test-backend:
	cd backend && cargo test

check: lint
	npm run typecheck
	$(MAKE) test

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = resolve(dirname(fileURLToPath(import.meta.url)), "../tools/install.mjs");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-pacman-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dist = join(directory, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "manifest.json"), JSON.stringify({ version: 0, menu: { pacman: { label: "Pacman" } } }));
  writeFileSync(join(dist, "index.js"), "fixture bundle");
  writeFileSync(join(dist, "index.html"), "fixture page");
  const backend = join(directory, "backend");
  writeFileSync(backend, "fixture backend");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pacman"), "#!/bin/sh\nprintf 'cockpit-pacman\\n'\n");
  chmodSync(join(bin, "pacman"), 0o755);
  const run = (...args) => spawnSync(process.execPath, [installer, ...args], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { directory, dist, backend, run };
}

test("package staging uses one backend path for frontend and scheduled commands", t => {
  const f = fixture(t);
  const stage = join(f.directory, "stage");
  const umask = process.umask(0o077);
  t.after(() => process.umask(umask));
  const result = f.run("system", stage, "/usr", "/usr/lib/cockpit-pacman", f.backend, f.dist);
  assert.equal(result.status, 0, result.stderr);
  for (const directory of ["usr/share/cockpit/pacman", "usr/lib/cockpit-pacman", "usr/lib/systemd/system"]) {
    assert.equal(statSync(join(stage, directory)).mode & 0o777, 0o755, directory);
  }
  const manifest = JSON.parse(readFileSync(join(stage, "usr/share/cockpit/pacman/manifest.json"), "utf8"));
  assert.equal(manifest.config.backend, "/usr/lib/cockpit-pacman/cockpit-pacman-backend");
  const service = readFileSync(join(stage, "usr/lib/systemd/system/cockpit-pacman-scheduled.service"), "utf8");
  assert.ok(service.includes(`ExecStart="${manifest.config.backend}" scheduled-run`));
  assert.ok(service.includes(`ExecStopPost="${manifest.config.backend}" scheduled-record-interrupted`));
  assert.equal(statSync(join(stage, manifest.config.backend)).mode & 0o777, 0o755);
  assert.equal(statSync(join(stage, "usr/share/cockpit/pacman/manifest.json")).mode & 0o777, 0o644);
});

test("an installed package prevents an unstaged install before any writes", t => {
  const f = fixture(t);
  const prefix = join(f.directory, "prefix");
  const result = f.run("system", "", prefix, join(prefix, "libexec/cockpit-pacman"), f.backend, f.dist);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(prefix), false);
});

test("a root DESTDIR cannot bypass the package ownership check", t => {
  const f = fixture(t);
  const prefix = join(f.directory, "prefix");
  const result = f.run("system", "/", prefix, join(prefix, "libexec/cockpit-pacman"), f.backend, f.dist);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(prefix), false);
});

test("development installation selects the user backend and leaves system units absent", t => {
  const f = fixture(t);
  const prefix = join(f.directory, "local");
  const plugin = join(prefix, "share/cockpit/pacman");
  mkdirSync(dirname(plugin), { recursive: true });
  symlinkSync(f.dist, plugin);
  const result = f.run("development", prefix, f.backend, f.dist);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(plugin, "manifest.json"), "utf8"));
  assert.equal(realpathSync(manifest.config.backend), f.backend);
  assert.equal(realpathSync(join(plugin, "index.js")), join(f.dist, "index.js"));
  assert.equal(existsSync(join(prefix, "lib/systemd/system")), false);
  assert.equal(JSON.parse(readFileSync(join(f.dist, "manifest.json"), "utf8")).config, undefined);
});

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = "cockpit-pacman-backend";

function installFile(source, destination, mode) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.install-${process.pid}`;
  copyFileSync(source, temporary);
  chmodSync(temporary, mode);
  renameSync(temporary, destination);
}

function writeFile(destination, contents, mode = 0o644) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.install-${process.pid}`;
  writeFileSync(temporary, contents, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, destination);
}

function manifest(dist, backend) {
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  manifest.config = { ...manifest.config, backend };
  return JSON.stringify(manifest, null, 2) + "\n";
}

function link(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  if (lstatExists(destination)) {
    if (!lstatSync(destination).isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink ${destination}`);
    }
    unlinkSync(destination);
  }
  symlinkSync(resolve(source), destination);
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function checkLiveInstall() {
  const installed = spawnSync("pacman", ["-Qq"], { encoding: "utf8" });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) throw new Error("Could not determine whether cockpit-pacman is package-owned");
  if (installed.stdout.trim().split("\n").some(name => name === "cockpit-pacman" || name === "cockpit-pacman-git")) {
    throw new Error("A cockpit-pacman package is installed. Use make devel-install or stage a package with DESTDIR.");
  }
}

function systemInstall([destination, prefix, libexec, backend, dist], checkOnly) {
  if (![prefix, libexec].every(isAbsolute)) throw new Error("PREFIX and LIBEXECDIR must be absolute paths");
  const live = !destination || resolve(destination) === "/" ||
    (existsSync(destination) && realpathSync(destination) === "/");
  if (live) checkLiveInstall();
  if (checkOnly) return;
  // cockpit-bridge reads the plugin as the login user, so created directories must be 0755 like install -d.
  process.umask(0o022);
  const stage = live ? "/" : resolve(destination);
  const under = path => join(stage, path.replace(/^\/+/, ""));
  const backendPath = join(libexec, executable);
  const plugin = under(join(prefix, "share/cockpit/pacman"));
  for (const file of readdirSync(dist)) {
    if (file !== "manifest.json") installFile(join(dist, file), join(plugin, file), 0o644);
  }
  writeFile(join(plugin, "manifest.json"), manifest(dist, backendPath));
  installFile(backend, under(backendPath), 0o755);
  const units = under(join(prefix, "lib/systemd/system"));
  for (const name of readdirSync(join(root, "systemd"))) {
    const source = readFileSync(join(root, "systemd", name), "utf8");
    const contents = source.replace(/^Exec(Start|StopPost)=\S+ (scheduled-run|scheduled-record-interrupted)$/gm,
      (_match, directive, command) => `Exec${directive}=${JSON.stringify(backendPath)} ${command}`);
    writeFile(join(units, name), contents);
  }
}

function developmentInstall([prefix, backend, dist]) {
  prefix = resolve(prefix);
  const plugin = join(prefix, "share/cockpit/pacman");
  if (lstatExists(plugin) && lstatSync(plugin).isSymbolicLink()) {
    if (resolve(dirname(plugin), readlinkSync(plugin)) !== resolve(dist)) {
      throw new Error(`Refusing to replace an unrelated plugin symlink: ${plugin}`);
    }
    unlinkSync(plugin);
  }
  const backendPath = join(prefix, "libexec/cockpit-pacman", executable);
  link(backend, backendPath);
  for (const name of readdirSync(dist)) {
    if (name !== "manifest.json") link(join(dist, name), join(plugin, name));
  }
  writeFile(join(plugin, "manifest.json"), manifest(dist, backendPath));
}

try {
  const [mode, ...args] = process.argv.slice(2);
  const checkOnly = args.at(-1) === "--check";
  if (checkOnly) args.pop();
  if (mode === "system" && args.length === 5) systemInstall(args, checkOnly);
  else if (mode === "development" && args.length === 3 && !checkOnly) developmentInstall(args);
  else throw new Error("Expected system DESTDIR PREFIX LIBEXECDIR BACKEND DIST or development PREFIX BACKEND DIST");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

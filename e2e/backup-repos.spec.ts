import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";
import type { ListReposResponse, SaveReposResponse } from "../src/bindings";

type BackupFixture = {
  snapshot: string;
  target: string;
  current: string;
  restored: string;
};

async function prepare(pacman: PackmanPage, kind: "mirror" | "repo"): Promise<BackupFixture> {
  return JSON.parse(await guestCommand(pacman.frame, ["python3", "-c", `
import base64, json, pathlib, re, stat, sys, tempfile
target = pathlib.Path('/etc/pacman.d/mirrorlist' if sys.argv[1] == 'mirror' else '/etc/pacman.conf')
manifest = target.parent / ('.mirrorlist-backups.meta.json' if sys.argv[1] == 'mirror' else '.pacman-conf-backups.meta.json')
prefix = target.name + '.backup.'
backups = [p for p in target.parent.iterdir() if re.fullmatch(re.escape(prefix) + r'[0-9]+', p.name)]
paths = [target, manifest, *backups]
saved = {}
for path in paths:
    if path.exists():
        info = path.stat()
        saved[str(path)] = {'data': base64.b64encode(path.read_bytes()).decode(), 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
    else:
        saved[str(path)] = None
work = pathlib.Path(tempfile.mkdtemp(prefix='cpac-backup-e2e-'))
snapshot = work / 'snapshot.json'
snapshot.write_text(json.dumps({'files': saved, 'target': str(target), 'prefix': prefix}))
original = target.read_text()
for path in backups:
    path.unlink()
for timestamp in range(1, 6):
    (target.parent / (prefix + str(timestamp))).write_text(original + '\\n# backup ' + str(timestamp) + '\\n')
manifest.write_text(json.dumps({str(timestamp): 'manual' for timestamp in range(1, 6)}))
current = original + '\\n# before restore\\n'
target.write_text(current)
target.chmod(0o600)
print(json.dumps({'snapshot': str(snapshot), 'target': str(target), 'current': current, 'restored': original + '\\n# backup 1\\n'}))
`, kind]));
}

async function cleanup(pacman: PackmanPage, fixture: BackupFixture): Promise<void> {
  await guestCommand(pacman.frame, ["python3", "-c", `
import base64, json, os, pathlib, re, sys
snapshot = pathlib.Path(sys.argv[1])
saved = json.loads(snapshot.read_text())
target = pathlib.Path(saved['target'])
for path in target.parent.iterdir():
    if re.fullmatch(re.escape(saved['prefix']) + r'[0-9]+', path.name):
        path.unlink()
for name, record in saved['files'].items():
    path = pathlib.Path(name)
    if record is None:
        path.unlink(missing_ok=True)
    else:
        path.write_bytes(base64.b64decode(record['data']))
        path.chmod(record['mode'])
        os.chown(path, record['uid'], record['gid'])
snapshot.unlink()
snapshot.parent.rmdir()
`, fixture.snapshot]);
}

test.describe("configuration backups and stale repository saves", () => {
  test.skip(process.env.COCKPIT_FAULT_TESTS !== "1", "requires a disposable VM snapshot");

  for (const kind of ["mirror", "repo"] as const) {
    test(`${kind} restore keeps its undo backup after five manual backups`, async ({ pacman }) => {
      await pacman.navigateToPlugin();
      const fixture = await prepare(pacman, kind);
      try {
        const response: { success: boolean; backup_path: string; warnings: string[] } = JSON.parse(
          await guestCommand(pacman.frame, ["sh", "-c", 'umask 077; exec "$@"', "restore-backup", BACKEND, `restore-${kind}-backup`, "1"]),
        );
        expect(response.success).toBe(true);
        expect(response.warnings).toEqual([]);
        expect(await guestCommand(pacman.frame, ["cat", fixture.target])).toBe(fixture.restored);
        expect(await guestCommand(pacman.frame, ["cat", response.backup_path])).toBe(fixture.current);
        expect((await guestCommand(pacman.frame, ["stat", "-c", "%a", response.backup_path])).trim()).toBe("600");
        expect((await guestCommand(pacman.frame, ["stat", "-c", "%a", fixture.target])).trim()).toBe("644");
        const listing: { backups: { timestamp: number; source: string }[]; warnings: string[] } = JSON.parse(
          await guestCommand(pacman.frame, [BACKEND, `list-${kind}-backups`]),
        );
        expect(listing.backups).toHaveLength(5);
        expect(listing.warnings).toEqual([]);
        const undo = listing.backups.find(backup => response.backup_path.endsWith(`.${backup.timestamp}`));
        expect(undo?.source).toBe("auto");
        if (kind === "mirror") {
          await pacman.switchTab("Mirrors");
          await pacman.panel.getByRole("button", { name: "Backup history", exact: true }).click();
          const table = pacman.panel.getByRole("grid", { name: "Mirrorlist backups" });
          await expect(table.locator("tbody tr")).toHaveCount(5);
          const automatic = table.getByRole("row").filter({ hasText: "Automatic" });
          await expect(automatic).toHaveCount(1);
          await automatic.getByRole("button", { name: "Restore", exact: true }).click();
          const dialog = pacman.frame.getByRole("dialog", { name: "Restore mirrorlist backup?" });
          await dialog.getByRole("button", { name: "Restore", exact: true }).click();
          await expect(dialog).not.toBeVisible();
          await expect.poll(() => guestCommand(pacman.frame, ["cat", fixture.target])).toBe(fixture.current);
        } else {
          await guestCommand(pacman.frame, [BACKEND, `restore-${kind}-backup`, String(undo!.timestamp)]);
        }
        expect(await guestCommand(pacman.frame, ["cat", fixture.target])).toBe(fixture.current);
      } finally {
        await cleanup(pacman, fixture);
      }
    });
  }

  test("rejects a stale repository view and permits a fresh deliberate deletion", async ({ pacman }) => {
    await pacman.navigateToPlugin();
    const fixture = await prepare(pacman, "repo");
    try {
      await guestCommand(pacman.frame, ["chmod", "0644", fixture.target]);
      await pacman.switchTab("Repositories");
      const core = pacman.panel.getByLabel("Enable repository core", { exact: true });
      await expect(core).toBeAttached();
      const stale: ListReposResponse = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "list-repos"]));
      await guestCommand(pacman.frame, ["python3", "-c", "import sys; open(sys.argv[1], 'a').write('\\n[e2e-external]\\nServer = https://example.test/$repo/os/$arch\\n')", fixture.target]);
      const externallyChanged = await guestCommand(pacman.frame, ["cat", fixture.target]);
      await pacman.panel.locator('label:has(input[aria-label="Enable repository core"])').click();
      await pacman.panel.getByRole("button", { name: "Save Changes", exact: true }).click();
      await expect(pacman.panel.getByRole("paragraph").filter({ hasText: /configuration changed since it was loaded/ })).toBeVisible();
      expect(await guestCommand(pacman.frame, ["cat", fixture.target])).toBe(externallyChanged);

      const fresh: ListReposResponse = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "list-repos"]));
      expect(fresh.revision).not.toBe(stale.revision);
      expect(fresh.repos.some(repo => repo.name === "e2e-external")).toBe(true);
      const result: SaveReposResponse = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "save-repos", JSON.stringify(fresh.repos.filter(repo => repo.name !== "e2e-external")), fresh.revision]));
      expect(result.success).toBe(true);
      expect(result.warnings).toEqual([]);
      const saved: ListReposResponse = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "list-repos"]));
      expect(saved.revision).toBe(result.revision);
      expect(saved.repos.some(repo => repo.name === "e2e-external")).toBe(false);
      expect(await guestCommand(pacman.frame, ["cat", result.backup_path!])).toBe(externallyChanged);
    } finally {
      await cleanup(pacman, fixture);
    }
  });
});

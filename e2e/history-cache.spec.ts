import { test, expect } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";
import type { GroupedLogResponse, PackageDetails } from "../src/bindings";

test("reuses parsed history across processes and pages a large transaction", async ({ pacman }) => {
  test.skip(process.env.COCKPIT_FAULT_TESTS !== "1", "requires a disposable VM snapshot");
  await pacman.navigateToPlugin();
  const snapshot = (await guestCommand(pacman.frame, ["python3", "-c", `
import os, pathlib, shutil, tempfile
assert not pathlib.Path('/var/lib/pacman/db.lck').exists()
fd, snapshot = tempfile.mkstemp(prefix='cpac-log-e2e-')
os.close(fd)
shutil.copy2('/var/log/pacman.log', snapshot)
packages = ['pacman', *[f'history-fixture-{index:03}' for index in range(250)]]
lines = ['[2026-01-21T10:00:00+0000] [ALPM] transaction started']
lines += [f'[2026-01-21T10:00:00+0000] [ALPM] upgraded {name} (1-1 -> 2-1)' for name in packages]
lines += ['[2026-01-21T10:00:01+0000] [ALPM] transaction completed']
pathlib.Path('/var/log/pacman.log').write_text('\\n'.join(lines) + '\\n')
print(snapshot)
`])).trim();
  try {
    const uid = (await guestCommand(pacman.frame, ["id", "-u"], false)).trim();
    const cache = `/tmp/cockpit-pacman-log-${uid}/history.json`;
    const first: GroupedLogResponse = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "history-grouped", "0", "1"], false));
    expect(first.total_groups).toBe(3);
    expect(first.groups[0].entries).toHaveLength(100);
    expect(first.groups[0].part).toBe(1);
    const inode = await guestCommand(pacman.frame, ["stat", "-c", "%i", cache], false);
    const second: GroupedLogResponse = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "history-grouped", "1", "1"], false));
    const third: GroupedLogResponse = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "history-grouped", "2", "1"], false));
    expect(await guestCommand(pacman.frame, ["stat", "-c", "%i", cache], false)).toBe(inode);
    const packages = [...first.groups, ...second.groups, ...third.groups].flatMap(group => group.entries.map(entry => entry.package));
    expect(packages).toHaveLength(251);
    expect(new Set(packages).size).toBe(251);
    expect(packages[packages.length - 1]).toBe("pacman");
    const details: PackageDetails = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "local-package-info", "pacman"], false));
    expect(details.update_stats?.update_count).toBe(1);

    await pacman.switchTab("History");
    await expect(pacman.panel.getByText("Part 1 of 3")).toBeVisible();
    await expect(pacman.panel.getByText("Part 3 of 3")).toBeVisible();
    await pacman.panel.getByRole("button", { name: "Expand all" }).click();
    await expect(pacman.panel.locator('td[data-label="Package"]')).toHaveCount(251);

    await guestCommand(pacman.frame, ["python3", "-c", "open('/var/log/pacman.log', 'a').write('[2026-01-22T10:00:00+0000] [ALPM] transaction started\\n[2026-01-22T10:00:00+0000] [ALPM] upgraded pacman (2-1 -> 3-1)\\n[2026-01-22T10:00:01+0000] [ALPM] transaction completed\\n')"]);
    const updated: PackageDetails = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "local-package-info", "pacman"], false));
    expect(updated.update_stats?.update_count).toBe(2);
    const appended: GroupedLogResponse = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "history-grouped", "0", "1"], false));
    expect(appended.total_groups).toBe(4);
    expect(appended.groups[0].entries[0].package).toBe("pacman");
    expect(appended.groups[0].entries[0].new_version).toBe("3-1");
  } finally {
    await guestCommand(pacman.frame, ["python3", "-c", "import pathlib, shutil, sys; shutil.copy2(sys.argv[1], '/var/log/pacman.log'); pathlib.Path(sys.argv[1]).unlink()", snapshot]);
  }
});

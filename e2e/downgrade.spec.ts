import { test, expect, type PackmanPage } from "./fixtures";
import type { DowngradeResponse } from "../src/bindings";

// The updates-pending VM fixture needs both the installed htop archive and a
// newer, repo-trusted archive in its cache: pacman -Sw --noconfirm htop.
const TARGET = "htop";

async function guestCommand(pacman: PackmanPage, args: string[]): Promise<string> {
  return pacman.frame.locator("body").evaluate(async (_body, command) => {
    const cockpit = Reflect.get(globalThis, "cockpit") as {
      spawn(args: string[], options: { superuser: "require"; err: "message" }): Promise<string>;
    };
    return await cockpit.spawn(command, { superuser: "require", err: "message" });
  }, args);
}

test.describe("Downgrade modal", () => {
  let restore: { path: string; query: string } | undefined;

  test.beforeEach(async ({ pacman }) => {
    restore = undefined;
    await pacman.navigateToPlugin();
    await pacman.switchTab("Installed Packages");
  });

  test.afterEach(async ({ pacman }) => {
    if (!restore) return;
    test.setTimeout(60000);

    // Reloading closes the transaction channel before restoring the fixture.
    await pacman.page.reload();
    await expect.poll(async () => {
      return guestCommand(pacman, ["test", "!", "-e", "/var/lib/pacman/db.lck"])
        .then(() => true, () => false);
    }, { timeout: 30000, message: "The transaction lock must clear before restoring htop" }).toBe(true);
    if ((await guestCommand(pacman, ["pacman", "-Q", TARGET])).trim() !== restore.query) {
      await guestCommand(pacman, ["pacman", "-U", "--noconfirm", restore.path]);
    }
    expect((await guestCommand(pacman, ["pacman", "-Q", TARGET])).trim()).toBe(restore.query);
  });

  async function openDowngrade(pacman: PackmanPage) {
    await pacman.panel.getByPlaceholder("Search packages...").fill(TARGET);
    await pacman.panel.getByRole("button", { name: TARGET, exact: true }).click();

    const details = pacman.frame.getByRole("dialog").first();
    await details.getByRole("button", { name: "Downgrade", exact: true }).click();

    const modal = pacman.frame.getByRole("dialog", { name: `Downgrade ${TARGET}` });
    await expect(modal.locator("h1")).toHaveText(`Downgrade ${TARGET}`);
    await expect(modal.getByRole("button", { name: "Cache", exact: true })).toBeVisible({ timeout: 15000 });
    return modal;
  }

  test("keeps the version dialog accessible and returns focus to package details", async ({ pacman }) => {
    const modal = await openDowngrade(pacman);
    await expect(pacman.frame.getByRole("dialog")).toHaveCount(1);
    await modal.getByRole("button", { name: "Cache", exact: true }).focus();
    await pacman.page.keyboard.press("Tab");
    expect(await modal.evaluate((dialog) => dialog.contains(dialog.ownerDocument.activeElement))).toBe(true);
    await pacman.page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(pacman.frame.getByRole("dialog").getByRole("button", { name: "Downgrade", exact: true })).toBeFocused();
  });

  test("lists the installed version in the cache", async ({ pacman }) => {
    const installed = (await guestCommand(pacman, ["pacman", "-Q", TARGET])).trim();
    const modal = await openDowngrade(pacman);
    const installedRow = modal.locator("tbody tr").filter({ hasText: "installed" });

    await expect(installedRow).toHaveCount(1);
    const version = installedRow.locator('td[data-label="Version"] code');
    await expect(version).toHaveText(installed.slice(TARGET.length + 1));
    await expect(installedRow.locator("button")).toHaveCount(0);
  });

  test("commits a cache version change to completion", async ({ pacman }) => {
    test.setTimeout(180000);
    const cached: DowngradeResponse = JSON.parse(await guestCommand(pacman, [
      "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
      "list-downgrades",
      TARGET,
    ]));
    const originalQuery = (await guestCommand(pacman, ["pacman", "-Q", TARGET])).trim();
    const original = cached.packages.find((version) => `${version.name} ${version.version}` === originalQuery);
    if (!original) throw new Error("The fixture must cache the installed htop version for cleanup");
    const cacheDir = (await guestCommand(pacman, ["pacman-conf", "CacheDir"])).trim().split("\n")[0];
    const originalPath = `${cacheDir}/${original.filename}`;
    expect((await guestCommand(pacman, ["pacman", "-Qp", originalPath])).trim()).toBe(originalQuery);

    const modal = await openDowngrade(pacman);
    const targetRow = modal.locator('tbody tr').filter({ has: pacman.page.locator('button', { hasText: /^Upgrade$/ }) }).first();
    await expect(targetRow).toBeVisible({ timeout: 15000 });
    const selectedVersion = (await targetRow.locator('td[data-label="Version"] code').innerText()).trim();
    expect(selectedVersion).not.toBe(original.version);

    restore = { path: originalPath, query: originalQuery };
    await targetRow.getByRole("button", { name: "Upgrade", exact: true }).click();
    await modal.getByRole("button", { name: "Confirm Upgrade", exact: true }).click();

    await expect(modal.getByText("Version change complete", { exact: true }))
      .toBeVisible({ timeout: 120000 });
    expect((await guestCommand(pacman, ["pacman", "-Q", TARGET])).trim())
      .toBe(`${TARGET} ${selectedVersion}`);
  });
});

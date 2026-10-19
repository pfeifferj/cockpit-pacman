import { test, expect } from "./fixtures";
import { guestCommand } from "./guest";
import { withSavedConfig } from "./config-file";

test.describe("Mirrors Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Mirrors");
    await pacman.panel.locator('table[aria-label="Mirror list"]').waitFor({ timeout: 60000 });
  });

  test("lists the mirrors the mirrorlist defines", async ({ pacman }) => {
    const urls = pacman.panel.locator('td[data-label="URL"]');
    await expect(urls.first()).toBeVisible({ timeout: 30000 });

    const count = await urls.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(urls.nth(i)).toContainText(/https?:\/\/\S+/);
    }
  });

  test("marks which mirrors pacman will use", async ({ pacman }) => {
    const switches = pacman.panel.locator('input[type="checkbox"][aria-label^="Enable mirror"]');
    await expect(switches.first()).toBeAttached({ timeout: 30000 });

    const enabled = pacman.panel.locator(
      'tr:has(input[type="checkbox"][aria-label^="Enable mirror"]:checked)'
    );
    expect(await enabled.count()).toBeGreaterThan(0);
  });

  test("filters the list by URL", async ({ pacman }) => {
    const urls = pacman.panel.locator('td[data-label="URL"]');
    await expect(urls.first()).toBeVisible({ timeout: 30000 });

    const host = (await urls.first().innerText()).match(/https?:\/\/([^/\s]+)/)?.[1];
    expect(host).toBeTruthy();

    await pacman.panel.locator('input[aria-label="Search mirrors"]').fill(host!);
    await pacman.page.waitForTimeout(300);

    const remaining = await urls.count();
    expect(remaining).toBeGreaterThan(0);
    for (let i = 0; i < remaining; i++) {
      await expect(urls.nth(i)).toContainText(host!);
    }
  });

  test("does not offer to write an unchanged mirrorlist", async ({ pacman }) => {
    await expect(pacman.panel.getByRole("button", { name: "Save changes" })).toBeDisabled({
      timeout: 30000,
    });
  });
});


test("saves mirror order and undoes it on disk", async ({ pacman }) => {
  test.skip(process.env.COCKPIT_FAULT_TESTS !== "1", "requires a disposable VM snapshot");
  await pacman.navigateToPlugin();
  await withSavedConfig(pacman.frame, "mirror", async () => {
    const before = await guestCommand(pacman.frame, ["sha256sum", "/etc/pacman.d/mirrorlist"]);
    await pacman.switchTab("Mirrors");
    const urls = pacman.panel.locator('td[data-label="URL"] span[style*="mono"]');
    await expect(urls.nth(1)).toBeVisible();
    const originalFirst = (await urls.first().innerText()).trim();
    const moved = (await urls.nth(1).innerText()).trim();
    await pacman.panel.getByRole("button", { name: `More actions for ${moved}`, exact: true }).click({ timeout: 15000 });
    await pacman.frame.getByRole("menuitem", { name: "Move to top", exact: true }).click({ timeout: 15000 });
    await expect(urls.first()).toHaveText(moved);
    await pacman.panel.getByRole("button", { name: "Save changes", exact: true }).click({ timeout: 15000 });
    await expect(pacman.panel.getByRole("heading", { name: /^Success alert:\s*Saved \/etc\/pacman\.d\/mirrorlist$/ })).toBeVisible();
    expect(await guestCommand(pacman.frame, ["sha256sum", "/etc/pacman.d/mirrorlist"])).not.toBe(before);
    await pacman.panel.getByRole("button", { name: "Undo", exact: true }).click({ timeout: 15000 });
    await expect(pacman.panel.getByRole("heading", { name: /^Success alert:\s*Undid the \/etc\/pacman\.d\/mirrorlist change$/ })).toBeVisible();
    expect(await guestCommand(pacman.frame, ["sha256sum", "/etc/pacman.d/mirrorlist"])).toBe(before);
    await expect(urls.first()).toHaveText(originalFirst);
  });
});

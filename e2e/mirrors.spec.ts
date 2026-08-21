import { test, expect } from "./fixtures";

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

  test("does not offer to write a mirrorlist nothing has changed", async ({ pacman }) => {
    await expect(pacman.panel.getByRole("button", { name: "Save Changes" })).toBeDisabled({
      timeout: 30000,
    });
  });
});

import { test, expect } from "./fixtures";

test.describe("Installed Packages Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Installed Packages");
  });

  test("displays installed packages list", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.panel.locator("table").first();
    await expect(table).toBeVisible();

    const rows = pacman.panel.locator("table tbody tr");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("shows package count in pagination", async ({ pacman }) => {
    await pacman.waitForLoading();

    const pagination = pacman.panel.locator('[class*="pagination"]').first();
    await expect(pagination).toBeVisible();
  });

  test("narrows the list when searching", async ({ pacman }) => {
    await pacman.waitForLoading();

    const rows = pacman.panel.locator("table tbody tr");
    const before = await rows.count();
    expect(before).toBeGreaterThan(0);

    const searchInput = pacman.panel
      .locator('input[type="search"], input[placeholder*="Search"]')
      .first();
    await expect(searchInput).toBeVisible();
    await searchInput.fill("linux");
    await pacman.waitForLoading();

    await expect(rows.first()).toBeVisible();
    await expect.poll(() => rows.count()).toBeLessThan(before);
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("shows only explicit packages under the Explicit filter", async ({ pacman }) => {
    await pacman.waitForLoading();
    await pacman.selectFilter("Explicit");
    await pacman.waitForLoading();

    const reasons = pacman.panel.locator('td[data-label="Reason"]');
    await expect(reasons.first()).toBeVisible();

    const count = await reasons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(reasons.nth(i)).toHaveText("explicit");
    }
  });

  test("can click on package to view details", async ({ pacman }) => {
    await pacman.waitForLoading();

    const firstRow = pacman.panel.locator("table tbody tr").first();
    await firstRow.click();

    const modal = pacman.frame.locator('[class*="modal"], [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 10000 });
  });

  test("renders one page rather than every installed package", async ({ pacman }) => {
    await pacman.waitForLoading();

    const rows = pacman.panel.locator("table tbody tr");
    await expect(rows.first()).toBeVisible();
    const shown = await rows.count();

    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(100);
  });
});

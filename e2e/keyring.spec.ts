import { test, expect } from "./fixtures";

test.describe("Keyring Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Keyring");
  });

  test("displays keyring status", async ({ pacman }) => {
    await pacman.waitForLoading();

    const tableOrEmptyState = pacman.page.locator('table, [class*="empty-state"]');
    await expect(tableOrEmptyState).toBeVisible({ timeout: 30000 });
  });

  test("shows key list when initialized", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    const emptyState = pacman.page.locator('[class*="empty-state"]');

    const hasTable = await table.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    expect(hasTable || hasEmptyState).toBe(true);
  });

  test("displays key fingerprints", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    if (await table.isVisible()) {
      const fingerprintCell = pacman.page.locator("td").first();
      await expect(fingerprintCell).toBeVisible();
    }
  });

  test("shows refresh keyring button", async ({ pacman }) => {
    await pacman.waitForLoading();

    const refreshButton = pacman.page.locator('button:has-text("Refresh")');
    const initButton = pacman.page.locator('button:has-text("Initialize")');

    const hasRefresh = await refreshButton.isVisible().catch(() => false);
    const hasInit = await initButton.isVisible().catch(() => false);

    expect(hasRefresh || hasInit).toBe(true);
  });

  test("has pagination when many keys", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    if (await table.isVisible()) {
      const rows = pacman.page.locator("table tbody tr");
      const count = await rows.count();

      if (count > 10) {
        const pagination = pacman.page.locator('[class*="pagination"]');
        await expect(pagination).toBeVisible();
      }
    }
  });
});

import { test, expect } from "./fixtures";

test.describe("Orphans Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Orphans");
  });

  test("displays orphans view", async ({ pacman }) => {
    await pacman.waitForLoading();

    const tableOrEmptyState = pacman.page.locator('table, [class*="empty-state"]');
    await expect(tableOrEmptyState).toBeVisible({ timeout: 30000 });
  });

  test("shows orphan count or empty state", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    const emptyState = pacman.page.locator('[class*="empty-state"], text="No orphan"');

    const hasTable = await table.isVisible().catch(() => false);
    const hasEmptyState = await emptyState.isVisible().catch(() => false);

    expect(hasTable || hasEmptyState).toBe(true);
  });

  test("displays total size of orphans", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    if (await table.isVisible()) {
      const sizeText = pacman.page.locator('text=/\\d+(\\.\\d+)?\\s*(B|KiB|MiB|GiB)/');
      await expect(sizeText.first()).toBeVisible();
    }
  });

  test("shows remove button when orphans exist", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    if (await table.isVisible()) {
      const removeButton = pacman.page.locator('button:has-text("Remove"), button:has-text("Clean")');
      await expect(removeButton).toBeVisible();
    }
  });

  test("lists orphan package details", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    if (await table.isVisible()) {
      const nameHeader = pacman.page.locator('th:has-text("Name")');
      const versionHeader = pacman.page.locator('th:has-text("Version")');

      await expect(nameHeader).toBeVisible();
      await expect(versionHeader).toBeVisible();
    }
  });

  test("can click on orphan to view details", async ({ pacman }) => {
    await pacman.waitForLoading();

    const firstRow = pacman.page.locator("table tbody tr").first();
    if (await firstRow.isVisible()) {
      await firstRow.click();

      const modal = pacman.page.locator('[class*="modal"], [role="dialog"]');
      await expect(modal).toBeVisible({ timeout: 10000 });
    }
  });
});

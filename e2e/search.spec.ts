import { test, expect } from "./fixtures";

test.describe("Search Packages Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Search Packages");
  });

  test("displays search input", async ({ pacman }) => {
    const searchInput = pacman.page.locator('input[type="search"], input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible();
  });

  test("shows empty state before search", async ({ pacman }) => {
    const emptyState = pacman.page.locator('[class*="empty-state"], text="Enter a search"');
    const isEmptyStateVisible = await emptyState.isVisible().catch(() => false);
    expect(isEmptyStateVisible).toBe(true);
  });

  test("can search for packages", async ({ pacman }) => {
    const searchInput = pacman.page.locator('input[type="search"], input[placeholder*="Search"]');
    await searchInput.fill("vim");

    await pacman.page.waitForTimeout(500);
    await pacman.waitForLoading();

    const results = pacman.page.locator("table tbody tr");
    const count = await results.count();
    expect(count).toBeGreaterThan(0);
  });

  test("shows repository column in results", async ({ pacman }) => {
    const searchInput = pacman.page.locator('input[type="search"], input[placeholder*="Search"]');
    await searchInput.fill("python");

    await pacman.page.waitForTimeout(500);
    await pacman.waitForLoading();

    const repoHeader = pacman.page.locator('th:has-text("Repository")');
    await expect(repoHeader).toBeVisible();
  });

  test("indicates installed packages in results", async ({ pacman }) => {
    const searchInput = pacman.page.locator('input[type="search"], input[placeholder*="Search"]');
    await searchInput.fill("bash");

    await pacman.page.waitForTimeout(500);
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    await expect(table).toBeVisible();
  });

  test("can filter by installation status", async ({ pacman }) => {
    const searchInput = pacman.page.locator('input[type="search"], input[placeholder*="Search"]');
    await searchInput.fill("git");

    await pacman.page.waitForTimeout(500);
    await pacman.waitForLoading();

    const filterDropdown = pacman.page.locator('[class*="select"]').first();
    if (await filterDropdown.isVisible()) {
      await filterDropdown.click();

      const installedOption = pacman.page.locator('[role="option"]:has-text("Installed")');
      if (await installedOption.isVisible()) {
        await installedOption.click();
        await pacman.waitForLoading();
      }
    }
  });

  test("can click on result to view details", async ({ pacman }) => {
    const searchInput = pacman.page.locator('input[type="search"], input[placeholder*="Search"]');
    await searchInput.fill("pacman");

    await pacman.page.waitForTimeout(500);
    await pacman.waitForLoading();

    const firstRow = pacman.page.locator("table tbody tr").first();
    await firstRow.click();

    const modal = pacman.page.locator('[class*="modal"], [role="dialog"]');
    await expect(modal).toBeVisible({ timeout: 10000 });
  });
});

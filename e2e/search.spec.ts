import { test, expect } from "./fixtures";

test.describe("Search Packages Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Search Packages");
  });

  test("displays search input", async ({ pacman }) => {
    const searchInput = pacman.panel.locator('input[type="search"], input[placeholder*="Search"]').first();
    await expect(searchInput).toBeVisible();
  });

  test("shows empty state before search", async ({ pacman }) => {
    const emptyState = pacman.panel.locator('[class*="empty-state"]').first();
    await expect(emptyState).toBeVisible({ timeout: 30000 });
  });

  test("can search for packages", async ({ pacman }) => {
    const searchInput = pacman.panel.locator('input[type="search"], input[placeholder*="Search"]').first();
    await searchInput.fill("vim");

    await pacman.page.waitForTimeout(500);
    await pacman.waitForLoading();

    const results = pacman.panel.locator("table tbody tr");
    const count = await results.count();
    expect(count).toBeGreaterThan(0);
  });

  test("shows repository column in results", async ({ pacman }) => {
    const searchInput = pacman.panel.locator('input[type="search"], input[placeholder*="Search"]').first();
    await searchInput.fill("python");

    await pacman.page.waitForTimeout(500);
    await pacman.waitForLoading();

    const repoHeader = pacman.panel.locator('th:has-text("Repository")');
    await expect(repoHeader).toBeVisible();
  });

  test("marks each result installed or not installed", async ({ pacman }) => {
    const searchInput = pacman.panel
      .locator('input[type="search"], input[placeholder*="Search"]')
      .first();
    await searchInput.fill("bash");
    await pacman.waitForLoading();

    const statuses = pacman.panel.locator('td[data-label="Status"]');
    await expect(statuses.first()).toBeVisible();

    const count = await statuses.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(statuses.nth(i)).toHaveText(/Installed|Not installed/);
    }
    await expect(pacman.panel.locator('td[data-label="Status"]', { hasText: /^Installed/ }).first())
      .toBeVisible();
  });

  test("drops uninstalled results under the Installed filter", async ({ pacman }) => {
    const searchInput = pacman.panel
      .locator('input[type="search"], input[placeholder*="Search"]')
      .first();
    await searchInput.fill("git");
    await pacman.waitForLoading();

    await pacman.panel
      .locator('.pf-v6-c-toggle-group__button:has-text("Installed")')
      .first()
      .click();
    await pacman.waitForLoading();

    const statuses = pacman.panel.locator('td[data-label="Status"]');
    await expect(statuses.first()).toBeVisible();

    const count = await statuses.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(statuses.nth(i)).toHaveText(/^Installed/);
    }
  });

  test("can click on result to view details", async ({ pacman }) => {
    const searchInput = pacman.panel.locator('input[type="search"], input[placeholder*="Search"]').first();
    await searchInput.fill("pacman");

    await pacman.page.waitForTimeout(500);
    await pacman.waitForLoading();

    const firstRow = pacman.panel.locator("table tbody tr").first();
    await firstRow.click();

    const modal = pacman.frame.locator('[class*="modal"], [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 10000 });
  });
});

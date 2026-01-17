import { test, expect } from "./fixtures";

test.describe("Installed Packages Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Installed Packages");
  });

  test("displays installed packages list", async ({ pacman }) => {
    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    await expect(table).toBeVisible();

    const rows = pacman.page.locator("table tbody tr");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("shows package count in pagination", async ({ pacman }) => {
    await pacman.waitForLoading();

    const pagination = pacman.page.locator('[class*="pagination"]');
    await expect(pagination).toBeVisible();
  });

  test("can search for packages", async ({ pacman }) => {
    await pacman.waitForLoading();

    const searchInput = pacman.page.locator('input[type="search"], input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible();

    await searchInput.fill("linux");
    await pacman.page.waitForTimeout(500);

    await pacman.waitForLoading();

    const table = pacman.page.locator("table");
    await expect(table).toBeVisible();
  });

  test("can filter by install reason", async ({ pacman }) => {
    await pacman.waitForLoading();

    const filterDropdown = pacman.page.locator('[class*="select"], [class*="dropdown"]').first();
    if (await filterDropdown.isVisible()) {
      await filterDropdown.click();

      const explicitOption = pacman.page.locator('button:has-text("Explicit"), [role="option"]:has-text("Explicit")');
      if (await explicitOption.isVisible()) {
        await explicitOption.click();
        await pacman.waitForLoading();
      }
    }
  });

  test("can click on package to view details", async ({ pacman }) => {
    await pacman.waitForLoading();

    const firstRow = pacman.page.locator("table tbody tr").first();
    await firstRow.click();

    const modal = pacman.page.locator('[class*="modal"], [role="dialog"]');
    await expect(modal).toBeVisible({ timeout: 10000 });
  });

  test("can change page size", async ({ pacman }) => {
    await pacman.waitForLoading();

    const perPageDropdown = pacman.page.locator('[class*="per-page"], [class*="options-menu"]');
    if (await perPageDropdown.isVisible()) {
      await perPageDropdown.click();

      const option100 = pacman.page.locator('[role="option"]:has-text("100")');
      if (await option100.isVisible()) {
        await option100.click();
        await pacman.waitForLoading();
      }
    }
  });
});

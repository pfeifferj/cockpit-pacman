import { test, expect } from "./fixtures";

const SIZE = /^\d+(\.\d+)? (B|KiB|MiB|GiB)$/;
const CACHE_ROWS = 'table[aria-label="Cached packages"] > tbody > tr';

test.describe("Cache Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Cache");
    await pacman.waitForLoading();
  });

  test("lists the packages held in the cache", async ({ pacman }) => {
    const sizes = pacman.panel.locator(`${CACHE_ROWS} td[data-label="Size"]`);
    await expect(sizes.first()).toBeVisible({ timeout: 30000 });

    expect(await sizes.count()).toBeGreaterThan(0);
    await expect(sizes.filter({ hasNotText: SIZE })).toHaveCount(0);
    await expect(sizes.filter({ hasText: /^0 B$/ })).toHaveCount(0);
  });

  test("shows the versions each cached package has", async ({ pacman }) => {
    const versions = pacman.panel.locator(`${CACHE_ROWS} td[data-label="Version"]`);
    await expect(versions.first()).toBeVisible({ timeout: 30000 });

    await expect(versions.first()).toContainText(/\d[\w.+]*-\d+/);
  });

  test("filters the cache by package name", async ({ pacman }) => {
    const packages = pacman.panel.locator(`${CACHE_ROWS} td[data-label="Package"]`);
    await expect(packages.first()).toBeVisible({ timeout: 30000 });
    const name = (await packages.first().innerText()).trim();

    await pacman.panel.locator('input[aria-label="Filter cached packages"]').fill(name);
    await pacman.page.waitForTimeout(300);

    expect(await packages.count()).toBeGreaterThan(0);
    await expect(packages.filter({ hasNotText: name })).toHaveCount(0);
  });

  test("arms the clean button from the selection", async ({ pacman }) => {
    const clean = pacman.panel.getByRole("button", { name: /^Clean/ });
    const selectAll = pacman.panel.locator('input[aria-label="Select all packages"]');

    await expect(clean).toBeEnabled({ timeout: 30000 });
    await expect(clean).toContainText("Clean Cache");

    await selectAll.uncheck();
    await expect(clean).toBeDisabled();

    await pacman.panel.locator(CACHE_ROWS).first().locator('input[type="checkbox"]').check();
    await expect(clean).toContainText("Clean 1 package");
  });
});

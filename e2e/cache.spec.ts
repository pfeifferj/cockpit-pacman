import { test, expect } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";
import type { CacheCleanupPreview } from "../src/bindings";

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

  test("shows a server projection for the selected package without deleting it", async ({ pacman }) => {
    const row = pacman.panel.locator(CACHE_ROWS).first();
    const name = (await row.locator('td[data-label="Package"]').innerText()).trim();
    const projection = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "cache-cleanup-preview", "0", name, "only"], false)) as CacheCleanupPreview;
    expect(projection.files).toBeGreaterThan(0);
    await pacman.panel.getByRole("checkbox", { name: "Select all packages", exact: true }).uncheck();
    await row.getByRole("checkbox").check();
    await pacman.panel.getByRole("button", { name: "Clean selected packages", exact: true }).click();
    const dialog = pacman.frame.getByRole("dialog", { name: /Clean package cache\?$/ });
    const slider = dialog.getByRole("slider", { name: "Versions to keep" });
    for (let i = 0; i < 3; i++) await slider.press("ArrowLeft");
    const commit = dialog.getByRole("button", { name: new RegExp(`^Delete up to ${projection.files} files? `) });
    await expect(commit).toBeEnabled();
    await expect(commit).toHaveClass(/pf-m-danger/);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const after = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "cache-cleanup-preview", "0", name, "only"], false)) as CacheCleanupPreview;
    expect(after).toEqual(projection);
  });

  test("arms the clean button from the selection", async ({ pacman }) => {
    const clean = pacman.panel.getByRole("button", { name: /^Clean/ });
    const selectAll = pacman.panel.locator('input[aria-label="Select all packages"]');

    await expect(clean).toBeEnabled({ timeout: 30000 });
    await expect(clean).toContainText("Clean cache");

    await selectAll.uncheck();
    await expect(clean).toBeDisabled();

    await pacman.panel.locator(CACHE_ROWS).first().locator('input[type="checkbox"]').check();
    await expect(clean).toContainText("Clean selected packages");
  });
});

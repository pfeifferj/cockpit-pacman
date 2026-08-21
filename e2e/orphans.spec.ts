import { test, expect } from "./fixtures";

test.describe("Orphans Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Installed Packages");
    await pacman.selectFilter("Orphans");
    await pacman.waitForLoading();
  });

  test("lists the orphaned packages", async ({ pacman }) => {
    const rows = pacman.panel.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("names and versions every orphan", async ({ pacman }) => {
    await expect(pacman.panel.locator('td[data-label="Package"]').first()).toBeVisible({
      timeout: 30000,
    });
    await expect(pacman.panel.locator('td[data-label="Version"]').first()).not.toBeEmpty();
  });

  test("reports how much space removing them frees", async ({ pacman }) => {
    const spaceToFree = pacman.panel.locator("text=Space to Free");
    await expect(spaceToFree).toBeVisible({ timeout: 30000 });

    await expect(
      pacman.panel.locator("text=/\\d+(\\.\\d+)?\\s*(B|KiB|MiB|GiB)/").first()
    ).toBeVisible();
  });

  test("offers to remove them", async ({ pacman }) => {
    await expect(
      pacman.panel.getByRole("button", { name: /Remove All Orphans/i })
    ).toBeVisible({ timeout: 30000 });
  });

  test("opens details for an orphan", async ({ pacman }) => {
    await pacman.panel.locator("table tbody tr").first().click();

    await expect(
      pacman.frame.locator('[class*="modal"], [role="dialog"]').first()
    ).toBeVisible({ timeout: 10000 });
  });
});

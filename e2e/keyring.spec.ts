import { test, expect } from "./fixtures";

test.describe("Keyring Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Keyring");
    await pacman.waitForLoading();
  });

  test("lists the keys pacman trusts", async ({ pacman }) => {
    const rows = pacman.panel.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("shows a fingerprint for each key", async ({ pacman }) => {
    const fingerprints = pacman.panel.locator('td[data-label="Fingerprint"]');
    await expect(fingerprints.first()).toBeVisible({ timeout: 30000 });

    await expect(fingerprints.first()).toHaveText(/^[0-9A-Fa-f]{40}$/);
  });

  test("offers to refresh the keys", async ({ pacman }) => {
    await expect(
      pacman.panel.getByRole("button", { name: /^Refresh$/i })
    ).toBeVisible({ timeout: 30000 });
  });

  test("paginates a keyring larger than one page", async ({ pacman }) => {
    const rows = pacman.panel.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30000 });

    await expect(pacman.panel.locator('[class*="pagination"]').first()).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(100);
  });
});

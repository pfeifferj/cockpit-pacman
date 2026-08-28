import { test, expect } from "./fixtures";

test.describe("Updates Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test("displays updates tab by default", async ({ pacman }) => {
    const updatesTab = pacman.frame.locator('button[role="tab"]:has-text("Updates")');
    await expect(updatesTab).toHaveAttribute("aria-selected", "true");
  });

  test("resolves to either a pending list or the up-to-date state", async ({ pacman }) => {
    await pacman.waitForLoading();

    const updateTable = pacman.panel.locator("table").first();
    const upToDate = pacman.panel.locator('text="System is up to date"');

    await expect(updateTable.or(upToDate).first()).toBeVisible({ timeout: 60000 });
  });

  test("does not surface a permission error", async ({ pacman }) => {
    await pacman.waitForLoading();

    await expect(pacman.panel.locator('text="Not permitted to perform this action."'))
      .toHaveCount(0);
  });

  test("shows the system overview counters", async ({ pacman }) => {
    await pacman.waitForLoading();

    const overview = pacman.panel.locator('text="System Overview"');
    await expect(overview).toBeVisible({ timeout: 30000 });
  });
});

import { test, expect } from "./fixtures";

test.describe("Updates Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test("displays updates tab by default", async ({ pacman }) => {
    const updatesTab = pacman.page.locator('button[role="tab"]:has-text("Updates")');
    await expect(updatesTab).toHaveAttribute("aria-selected", "true");
  });

  test("shows check for updates button", async ({ pacman }) => {
    await pacman.waitForLoading();
    const checkButton = pacman.page.locator('button:has-text("Check for Updates")');
    await expect(checkButton).toBeVisible();
  });

  test("can check for updates", async ({ pacman }) => {
    await pacman.waitForLoading();
    const checkButton = pacman.page.locator('button:has-text("Check for Updates")');
    await checkButton.click();

    const spinner = pacman.page.locator(".pf-v6-c-spinner");
    await expect(spinner).toBeVisible();

    await spinner.waitFor({ state: "hidden", timeout: 60000 });

    const content = pacman.page.locator('[class*="updates"]');
    await expect(content).toBeVisible();
  });

  test("displays update count or no updates message", async ({ pacman }) => {
    await pacman.waitForLoading();
    const checkButton = pacman.page.locator('button:has-text("Check for Updates")');
    await checkButton.click();
    await pacman.waitForLoading();

    const noUpdates = pacman.page.locator('text="System is up to date"');
    const updateList = pacman.page.locator("table");

    const hasNoUpdates = await noUpdates.isVisible().catch(() => false);
    const hasUpdateList = await updateList.isVisible().catch(() => false);

    expect(hasNoUpdates || hasUpdateList).toBe(true);
  });
});

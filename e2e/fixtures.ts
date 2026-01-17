import { test as base, expect, Page } from "@playwright/test";

const PLUGIN_PATH = "/cockpit/@localhost/pacman/";

export interface PackmanPage {
  page: Page;
  navigateToPlugin: () => Promise<void>;
  switchTab: (tabName: string) => Promise<void>;
  waitForLoading: () => Promise<void>;
}

export const test = base.extend<{ pacman: PackmanPage }>({
  pacman: async ({ page }, use) => {
    const pacman: PackmanPage = {
      page,

      async navigateToPlugin() {
        await page.goto(PLUGIN_PATH);
        await page.waitForLoadState("networkidle");
        await page.waitForSelector('[role="tablist"]', { timeout: 30000 });
      },

      async switchTab(tabName: string) {
        const tabButton = page.locator(`button[role="tab"]:has-text("${tabName}")`);
        await tabButton.click();
        await page.waitForTimeout(500);
      },

      async waitForLoading() {
        const spinner = page.locator(".pf-v6-c-spinner");
        if (await spinner.isVisible()) {
          await spinner.waitFor({ state: "hidden", timeout: 30000 });
        }
      },
    };

    await use(pacman);
  },
});

export { expect };

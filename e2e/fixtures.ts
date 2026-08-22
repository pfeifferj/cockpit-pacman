import { test as base, expect, FrameLocator, Locator, Page } from "@playwright/test";

const SHELL_PATH = "/pacman";
const PLUGIN_FRAME = 'iframe[name*="pacman"], iframe[src*="pacman"]';

async function ensureLoggedIn(page: Page) {
  const username = process.env.COCKPIT_USER;
  const password = process.env.COCKPIT_PASSWORD;
  if (!username || !password) {
    throw new Error("COCKPIT_USER and COCKPIT_PASSWORD environment variables are required");
  }

  await page.goto("/");
  if (await page.locator("#login-user-input").isVisible().catch(() => false)) {
    await page.fill("#login-user-input", username);
    await page.fill("#login-password-input", password);
    await page.click("#login-button");
  }
  await page.waitForSelector("#nav-system", { timeout: 30000 });

  await escalate(page, password);
}

async function escalate(page: Page, password: string) {
  const indicator = page.locator("#super-user-indicator");
  await indicator.waitFor({ timeout: 30000 });
  if ((await indicator.innerText()).includes("Administrative")) {
    return;
  }

  await indicator.click();
  const dialog = page.locator('[role="dialog"]');
  const prompt = dialog.locator('input[type="password"]');
  if (await prompt.isVisible({ timeout: 3000 }).catch(() => false)) {
    await prompt.fill(password);
    await dialog.locator('button:has-text("Authenticate")').click();
  }
  await expect(indicator).toContainText("Administrative", { timeout: 15000 });

  const close = dialog.locator('button:has-text("Close")');
  if (await close.isVisible().catch(() => false)) {
    await close.click();
  }
}

export interface PackmanPage {
  page: Page;
  frame: FrameLocator;
  panel: Locator;
  navigateToPlugin: () => Promise<void>;
  switchTab: (tabName: string) => Promise<void>;
  selectFilter: (label: string) => Promise<void>;
  waitForLoading: () => Promise<void>;
}

export const test = base.extend<{ pacman: PackmanPage }>({
  pacman: async ({ page }, use) => {
    const frame = page.frameLocator(PLUGIN_FRAME);

    const panel = frame.locator('[role="tabpanel"]:visible').first();

    const pacman: PackmanPage = {
      page,
      frame,
      panel,

      async navigateToPlugin() {
        await ensureLoggedIn(page);
        await page.goto(SHELL_PATH);
        await frame.locator('[role="tablist"]').first().waitFor({ timeout: 60000 });
      },

      async switchTab(tabName: string) {
        await frame.locator(`button[role="tab"]:has-text("${tabName}")`).click();
        await page.waitForTimeout(500);
      },

      async selectFilter(label: string) {
        await panel.locator(`.pf-v6-c-toggle-group__button:has-text("${label}")`).click();
        await page.waitForTimeout(500);
      },

      async waitForLoading() {
        const spinner = panel.locator(".pf-v6-c-spinner").first();
        await spinner.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
        await spinner.waitFor({ state: "hidden", timeout: 30000 });
      },
    };

    await use(pacman);
  },
});

export { expect };

export const GRAPH_NODES = "svg g.nodes > g";

export async function graphFor(pacman: PackmanPage, name: string) {
  const search = pacman.panel.getByPlaceholder("Search packages...");
  await search.fill(name);
  await search.press("Enter");
  await pacman.waitForLoading();
  await expect(pacman.panel.locator(GRAPH_NODES).first()).toBeAttached({ timeout: 30000 });
}

import { expect, FrameLocator, Locator, Page } from "@playwright/test";
import { test as base, authenticate } from "./auth";

const SHELL_PATH = "/pacman";
const PLUGIN_FRAME = 'iframe[name*="pacman"], iframe[src*="pacman"]';

export interface PackmanPage {
  page: Page;
  frame: FrameLocator;
  panel: Locator;
  navigateToPlugin: (route?: string) => Promise<void>;
  tab: (tabName: string) => Locator;
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

      async navigateToPlugin(route?: string) {
        await authenticate(page);
        await page.goto(route ? `${SHELL_PATH}#${route}` : SHELL_PATH);
        await frame.locator('[role="tablist"]').first().waitFor({ timeout: 60000 });
      },

      tab(tabName: string) {
        const name = new RegExp(`^${tabName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i");
        return frame.getByRole("tab", { name });
      },

      async switchTab(tabName: string) {
        await pacman.tab(tabName).click();
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
  const search = pacman.panel.getByPlaceholder("Search packages…");
  await search.fill(name);
  await search.press("Enter");
  await pacman.waitForLoading();
  await expect(pacman.panel.locator(GRAPH_NODES).first()).toBeAttached({ timeout: 30000 });
}

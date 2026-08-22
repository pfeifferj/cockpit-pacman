import { test, graphFor } from "./fixtures";

const IMG = "docs/img";

test.describe.configure({ mode: "serial" });

test.describe("docs screenshots", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test("updates", async ({ pacman }) => {
    await pacman.waitForLoading();
    await pacman.page.screenshot({ path: `${IMG}/updates.png` });
  });

  test("installed", async ({ pacman }) => {
    await pacman.switchTab("Installed Packages");
    await pacman.waitForLoading();
    await pacman.page.screenshot({ path: `${IMG}/installed.png` });
  });

  test("details", async ({ pacman }) => {
    await pacman.switchTab("Installed Packages");
    await pacman.waitForLoading();
    await pacman.panel.locator("table tbody tr td a, table tbody tr td button").first().click();

    const dialog = pacman.frame.locator('[role="dialog"]').first();
    await dialog.waitFor();
    await dialog.locator(".pf-v6-c-spinner").first().waitFor({ state: "hidden", timeout: 30000 });
    await pacman.page.waitForTimeout(500);
    await pacman.page.screenshot({ path: `${IMG}/details.png` });
  });

  test("graph", async ({ pacman }) => {
    await pacman.switchTab("Installed Packages");
    await pacman.waitForLoading();
    await pacman.selectFilter("Graph");

    await graphFor(pacman, "linux");
    await pacman.page.waitForTimeout(1500);
    await pacman.page.screenshot({ path: `${IMG}/graph.png` });
  });

  test("search", async ({ pacman }) => {
    await pacman.switchTab("Search Packages");
    const input = pacman.panel.locator('input[type="search"], input[placeholder*="Search"]').first();
    await input.fill("linux");
    await input.press("Enter");
    await pacman.waitForLoading();
    await pacman.page.screenshot({ path: `${IMG}/search.png` });
  });

  test("history", async ({ pacman }) => {
    await pacman.switchTab("History");
    await pacman.waitForLoading();

    const toggles = pacman.panel.locator("button.pf-v6-c-accordion__toggle");
    const open = Math.min(await toggles.count(), 2);
    for (let i = 0; i < open; i++) {
      await toggles.nth(i).click();
    }
    await pacman.page.waitForTimeout(500);
    await pacman.page.screenshot({ path: `${IMG}/history.png` });
  });

  for (const [tab, name] of [
    ["Cache", "cache"],
    ["Keyring", "keyring"],
    ["Mirrors", "mirrors"],
    ["Repositories", "repositories"],
  ]) {
    test(name, async ({ pacman }) => {
      await pacman.switchTab(tab);
      await pacman.waitForLoading();
      await pacman.page.screenshot({ path: `${IMG}/${name}.png` });
    });
  }

  test("upgrade-progress", async ({ pacman }) => {
    await pacman.waitForLoading();
    await pacman.frame.locator('button:has-text("Apply")').first().click();

    const confirm = pacman.frame.locator('[role="dialog"] button:has-text("Apply")').first();
    if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirm.click();
    }

    await pacman.frame.getByText("Applying Updates").waitFor({ timeout: 60000 });
    await pacman.page.waitForTimeout(2500);
    await pacman.page.screenshot({ path: `${IMG}/upgrade-progress.png` });
  });
});

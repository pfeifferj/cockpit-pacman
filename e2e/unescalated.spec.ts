import { test, expect, type Page } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

const PLUGIN_FRAME = 'iframe[name*="pacman"], iframe[src*="pacman"]';

async function openPluginUnescalated(page: Page) {
  const username = process.env.COCKPIT_USER;
  const password = process.env.COCKPIT_PASSWORD;
  if (!username || !password) {
    throw new Error("COCKPIT_USER and COCKPIT_PASSWORD are required");
  }

  await page.goto("/");
  await page.fill("#login-user-input", username);
  await page.fill("#login-password-input", password);
  await page.click("#login-button");
  await page.waitForSelector("#nav-system", { timeout: 30000 });

  await page.goto("/pacman");
  const frame = page.frameLocator(PLUGIN_FRAME);
  await frame.locator('[role="tablist"]').first().waitFor({ timeout: 60000 });
  return frame;
}

test.describe("unescalated session", () => {
  test("reads every view that does not need root", async ({ page }) => {
    const frame = await openPluginUnescalated(page);

    const panel = frame.locator('[role="tabpanel"]:visible').first();

    for (const tab of ["Installed Packages", "History", "Cache", "Mirrors", "Repositories"]) {
      await frame.locator(`button[role="tab"]:has-text("${tab}")`).click();
      await page.waitForTimeout(800);
      await expect(panel).not.toContainText("Not permitted", { timeout: 15000 });
    }
  });

  test("does not offer to initialize a keyring it cannot read", async ({ page }) => {
    const frame = await openPluginUnescalated(page);
    await frame.locator('button[role="tab"]:has-text("Keyring")').click();

    await expect(frame.getByText(/could not be determined/i)).toBeVisible({ timeout: 15000 });
    await expect(frame.getByRole("button", { name: /Initialize Keyring/i })).toHaveCount(0);
  });
});

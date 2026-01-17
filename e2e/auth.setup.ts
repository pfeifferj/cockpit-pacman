import { test as setup, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const authDir = path.join(process.cwd(), ".auth");
const authFile = path.join(authDir, "session.json");

setup("authenticate with cockpit", async ({ page }) => {
  const username = process.env.COCKPIT_USER;
  const password = process.env.COCKPIT_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "COCKPIT_USER and COCKPIT_PASSWORD environment variables are required"
    );
  }

  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  await page.goto("/");

  await page.waitForSelector("#login-user-input", { timeout: 10000 });

  await page.fill("#login-user-input", username);
  await page.fill("#login-password-input", password);
  await page.click("#login-button");

  await expect(page.locator("#host-toggle")).toBeVisible({ timeout: 30000 });

  await page.context().storageState({ path: authFile });
});

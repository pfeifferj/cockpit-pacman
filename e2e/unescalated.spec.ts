import { expect, type Page } from "@playwright/test";
import { test, authenticate } from "./auth";
import { BACKEND, guestCommand } from "./guest";
import type { KeyringStatusResponse } from "../src/bindings";

test.use({ storageState: { cookies: [], origins: [] } });

async function openPluginUnescalated(page: Page) {
  await authenticate(page, false);
  await page.goto("/pacman");
  const frame = page.frameLocator('iframe[name*="pacman"], iframe[src*="pacman"]');
  await frame.locator('[role="tablist"]').first().waitFor({ timeout: 60000 });
  return frame;
}

test.describe("unescalated session", () => {
  test("reads installed packages, history, cache, mirrors and repositories", async ({ page }) => {
    const frame = await openPluginUnescalated(page);
    const installed = (await guestCommand(frame, ["pacman", "-Q", "htop"], false)).trim().split(" ")[1];
    const panel = frame.locator('[role="tabpanel"]:visible').first();
    await frame.getByRole("tab", { name: "Installed packages", exact: true }).click();
    await panel.getByRole("textbox", { name: "Search installed packages" }).fill("htop");
    const row = panel.locator("tbody tr").filter({ hasText: "htop" }).first();
    await expect(row).toContainText(installed);

    await frame.getByRole("tab", { name: "History", exact: true }).click();
    await panel.getByRole("button", { name: "Flat", exact: true }).click();
    await panel.getByPlaceholder("Filter by package name...").fill("htop");
    const history = panel.getByRole("grid", { name: "Package history (flat)" });
    await expect(history.locator("tbody tr").first()).toContainText("htop");
    await expect(history.locator("tbody tr").first()).toContainText(/installed|upgraded|downgraded|reinstalled/);

    await frame.getByRole("tab", { name: "Cache", exact: true }).click();
    await panel.getByRole("textbox", { name: "Filter cached packages" }).fill("htop");
    await expect(panel.getByRole("grid", { name: "Cached packages" }).locator("tbody tr").first()).toContainText("htop");

    await frame.getByRole("tab", { name: "Mirrors", exact: true }).click();
    await expect(panel.getByRole("grid", { name: "Mirror list" }).locator("tbody tr").first()).toContainText(/https?:\/\//);

    await frame.getByRole("tab", { name: "Repositories", exact: true }).click();
    const repositories = panel.getByRole("grid", { name: "Repository list" });
    await expect(repositories.locator("tbody tr").filter({ hasText: "core" }).first()).toBeVisible();
    await expect(panel.getByRole("switch", { name: "Enable repository core", exact: true })).toBeChecked();
    await expect(page.locator("#super-user-indicator")).not.toContainText("Administrative");
  });

  test("explains why advisory settings need administrative access", async ({ page }) => {
    const frame = await openPluginUnescalated(page);
    const panel = frame.locator('[role="tabpanel"]:visible').first();
    await expect(panel.getByRole("button", { name: "Overview settings" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Error checking for updates" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Overview settings" }).click();
    const toggle = frame.getByRole("checkbox", { name: /Check security advisories/ });
    await expect(toggle).toBeDisabled();
    await expect(frame.getByText("Not permitted to change system settings", { exact: true })).toBeVisible();
  });

  test("shows the readable keyring state without offering initialization", async ({ page }) => {
    const frame = await openPluginUnescalated(page);
    const status = JSON.parse(await guestCommand(frame, [BACKEND, "keyring-status"], false)) as KeyringStatusResponse;
    await frame.getByRole("tab", { name: "Keyring", exact: true }).click();
    for (const warning of status.warnings) await expect(frame.getByText(warning, { exact: true })).toBeVisible();
    if (status.total) {
      await expect(frame.getByText(`${status.total} keys in keyring`, { exact: true })).toBeVisible();
      await expect(frame.getByRole("grid").locator("tbody tr").first()).toContainText(status.keys[0].fingerprint);
    } else {
      expect(status.warnings.length).toBeGreaterThan(0);
    }
    await expect(frame.getByRole("button", { name: /Initialize Keyring/i })).toHaveCount(0);
  });
});

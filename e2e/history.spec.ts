import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";
import type { LogResponse } from "../src/bindings";

const ACTIONS = /^(upgraded|downgraded|installed|removed|reinstalled)$/;

async function showFlatEntries(pacman: PackmanPage) {
  await pacman.panel.locator('.pf-v6-c-toggle-group__button:has-text("Flat")').click();
  await pacman.waitForLoading();
}

test.describe("History Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.page.setViewportSize({ width: 1600, height: 1000 });
    await pacman.navigateToPlugin();
    await pacman.switchTab("History");
    await pacman.waitForLoading();
  });

  test("groups the log into transactions", async ({ pacman }) => {
    const groups = pacman.panel.locator(".pf-v6-c-accordion__toggle");
    await expect(groups.first()).toBeVisible({ timeout: 30000 });

    await groups.first().click();
    const packages = pacman.panel.locator('td[data-label="Package"]');
    await expect(packages.first()).toBeVisible();
    await expect(packages.first()).not.toBeEmpty();
  });

  test("names the action pacman recorded for each entry", async ({ pacman }) => {
    await showFlatEntries(pacman);

    const actions = pacman.panel.locator('td[data-label="Action"]');
    await expect(actions.first()).toBeVisible({ timeout: 30000 });
    await expect(actions.filter({ hasNotText: ACTIONS })).toHaveCount(0);
  });

  test("keeps only the action the filter selects", async ({ pacman }) => {
    await showFlatEntries(pacman);
    await pacman.panel.getByRole("button", { name: "All actions" }).click();
    await pacman.frame.getByRole("option", { name: "Installed", exact: true }).click();
    await pacman.waitForLoading();

    const actions = pacman.panel.locator('td[data-label="Action"]');
    await expect(actions.first()).toBeVisible({ timeout: 30000 });
    expect(await actions.count()).toBeGreaterThan(0);
    await expect(actions.filter({ hasNotText: /^installed$/ })).toHaveCount(0);
  });

  test("filters by package name", async ({ pacman }) => {
    await showFlatEntries(pacman);
    await pacman.panel.locator('input[aria-label="Filter history by package name"]').fill("pacman");
    await pacman.waitForLoading();

    const packages = pacman.panel.locator('td[data-label="Package"]');
    await expect(packages.first()).toBeVisible({ timeout: 30000 });
    await expect(packages.filter({ hasNotText: /pacman/ })).toHaveCount(0);
  });

  test("bounds history by date and returns to the latest entries", async ({ pacman }) => {
    await showFlatEntries(pacman);
    await pacman.panel.getByLabel("Show history up to date", { exact: true }).fill("1970-01-01");
    await pacman.panel.getByLabel("Show history up to date", { exact: true }).press("Tab");
    await expect(pacman.panel.getByRole("heading", { name: "No matching entries" })).toBeVisible();
    await pacman.panel.getByRole("button", { name: "Back to latest", exact: true }).click();
    await expect(pacman.panel.locator('td[data-label="Package"]').first()).toBeVisible();
  });

  test("opens package details without leaving the history list", async ({ pacman }) => {
    await showFlatEntries(pacman);
    await pacman.panel.getByLabel("Filter history by package name", { exact: true }).fill("htop");
    const packageButton = pacman.panel.getByRole("button", { name: "htop", exact: true }).first();
    await packageButton.click();
    const drawer = pacman.panel.locator('[data-details-for="htop"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("role", "region");
    await expect(drawer.getByRole("heading", { level: 2, name: /^htop\b/ })).toBeVisible();
    await expect(pacman.panel.getByRole("grid", { name: "Package history (flat)", exact: true })).toBeVisible();
    await expect(pacman.panel.getByLabel("Filter history by package name", { exact: true })).toHaveValue("htop");
    await expect(pacman.frame.getByRole("dialog")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Close package details", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(packageButton).toBeFocused();
  });

  test("pages through the log", async ({ pacman }) => {
    await showFlatEntries(pacman);
    const rows = pacman.panel.getByRole("grid", { name: "Package history (flat)", exact: true }).locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30000 });
    const pageSize = await rows.count();
    const expected: LogResponse = JSON.parse(await guestCommand(pacman.frame,
      [BACKEND, "history", String(pageSize), String(pageSize), "all", ""], false));
    expect(expected.entries.length).toBeGreaterThan(0);

    await pacman.panel.getByRole("button", { name: "Go to next page" }).first().click();
    const range = `${pageSize + 1} - ${pageSize + expected.entries.length} of ${expected.total}`;
    await expect(pacman.panel.getByRole("button", { name: range, exact: true }).first()).toBeVisible();
    await expect.poll(() => rows.evaluateAll(elements => elements.map(row => ({
      package: row.querySelector('[data-label="Package"]')?.textContent?.trim(),
      version: row.querySelector('[data-label="Version"]')?.textContent?.trim(),
      action: row.querySelector('[data-label="Action"]')?.textContent?.trim(),
      timestamp: row.querySelector("time")?.getAttribute("datetime"),
    })))).toEqual(expected.entries.map(entry => ({
      package: entry.package,
      version: [entry.old_version, entry.new_version].filter(Boolean).join(" -> "),
      action: entry.action,
      timestamp: new Date(entry.timestamp).toISOString(),
    })));
    await expect(pacman.panel.getByRole("button", { name: "Go to previous page" }).first()).toBeEnabled();
  });
});

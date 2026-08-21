import { test, expect, type PackmanPage } from "./fixtures";

const ACTIONS = /^(upgraded|downgraded|installed|removed|reinstalled)$/;

async function showFlatEntries(pacman: PackmanPage) {
  await pacman.panel.locator('.pf-v6-c-toggle-group__button:has-text("Flat")').click();
  await pacman.waitForLoading();
}

test.describe("History Tab", () => {
  test.beforeEach(async ({ pacman }) => {
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

  test("pages through the log", async ({ pacman }) => {
    await showFlatEntries(pacman);
    const packages = pacman.panel.locator('td[data-label="Package"]');
    await expect(packages.first()).toBeVisible({ timeout: 30000 });
    const firstOnPageOne = await packages.first().innerText();

    await pacman.panel.getByRole("button", { name: "Go to next page" }).first().click();
    await pacman.waitForLoading();
    await expect(packages.first()).not.toHaveText(firstOnPageOne);
  });
});

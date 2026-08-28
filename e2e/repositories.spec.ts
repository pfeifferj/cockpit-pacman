import { test, expect } from "./fixtures";

const REPO_ROWS = 'table[aria-label="Repository list"] > tbody > tr';

test.describe("Repositories Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Repositories");
    await pacman.waitForLoading();
  });

  test("lists the repositories pacman.conf defines", async ({ pacman }) => {
    const names = pacman.panel.locator(`${REPO_ROWS} td[data-label="Repository"]`);
    await expect(names.first()).toBeVisible({ timeout: 30000 });

    await expect(names.filter({ hasText: "[core]" })).toHaveCount(1);
  });

  test("counts the servers each repository has", async ({ pacman }) => {
    const core = pacman.panel.locator(REPO_ROWS, { hasText: "[core]" }).first();
    await expect(core).toBeVisible({ timeout: 30000 });

    await expect(core.locator('td[data-label="Servers"]')).toHaveText(/^[1-9]\d*$/);
  });

  test("expands a repository to the directives behind it", async ({ pacman }) => {
    const core = pacman.panel.locator(REPO_ROWS, { hasText: "[core]" }).first();
    await expect(core).toBeVisible({ timeout: 30000 });
    await core.getByRole("button", { name: "Expand core" }).click();

    const directives = pacman.panel.locator('table[aria-label="Directives for core"] tbody tr');
    const values = directives.locator('td[data-label="Value"]');
    await expect(values.first()).toBeVisible();

    const existing = await values.count() - 1;
    expect(existing).toBeGreaterThan(0);
    for (let i = 0; i < existing; i++) {
      await expect(values.nth(i)).toHaveText(/^(https?:\/\/|\/)\S+/);
    }
  });

  test("does not offer to write a pacman.conf nothing has changed", async ({ pacman }) => {
    const save = pacman.panel.getByRole("button", { name: "Save Changes" });
    await expect(save).toBeDisabled({ timeout: 30000 });

    const core = pacman.panel.locator(REPO_ROWS, { hasText: "[core]" }).first();
    await core.locator('label:has(input[aria-label="Enable repository core"])').click();
    await expect(save).toBeEnabled();
  });
});

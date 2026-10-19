import { test, expect } from "./fixtures";
import { guestCommand } from "./guest";
import { withSavedConfig } from "./config-file";

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

  test("does not offer to write an unchanged pacman.conf", async ({ pacman }) => {
    const save = pacman.panel.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled({ timeout: 30000 });

    const core = pacman.panel.locator(REPO_ROWS, { hasText: "[core]" }).first();
    await core.locator('label:has(input[aria-label="Enable repository core"])').click();
    await expect(save).toBeEnabled();
  });
});


test("saves a repository change and undoes it on disk", async ({ pacman }) => {
  test.skip(process.env.COCKPIT_FAULT_TESTS !== "1", "requires a disposable VM snapshot");
  await pacman.navigateToPlugin();
  await withSavedConfig(pacman.frame, "repo", async () => {
    const before = await guestCommand(pacman.frame, ["sha256sum", "/etc/pacman.conf"]);
    await pacman.switchTab("Repositories");
    const core = pacman.panel.locator(REPO_ROWS, { hasText: "[core]" }).first();
    const enabled = core.getByRole("switch", { name: "Enable repository core" });
    await expect(enabled).toBeChecked();
    await core.locator('label:has(input[aria-label="Enable repository core"])').click({ timeout: 15000 });
    await pacman.panel.getByRole("button", { name: "Save changes", exact: true }).click({ timeout: 15000 });
    await expect(pacman.panel.getByRole("heading", { name: /^Success alert:\s*Saved \/etc\/pacman\.conf$/ })).toBeVisible();
    expect(await guestCommand(pacman.frame, ["sha256sum", "/etc/pacman.conf"])).not.toBe(before);
    await expect(enabled).not.toBeChecked();
    await pacman.panel.getByRole("button", { name: "Undo", exact: true }).click({ timeout: 15000 });
    await expect(pacman.panel.getByRole("heading", { name: /^Success alert:\s*Undid the \/etc\/pacman\.conf change$/ })).toBeVisible();
    expect(await guestCommand(pacman.frame, ["sha256sum", "/etc/pacman.conf"])).toBe(before);
    await expect(enabled).toBeChecked();
  });
});

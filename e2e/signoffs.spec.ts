import { test, expect } from "./fixtures";
import { FIXTURE, guestCommand } from "./guest";

const SIGNOFFS_TAB = 'button[role="tab"]:has-text("Signoffs")';

test.describe("Signoffs Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test("hides signoffs from a session with no archweb credentials", async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "secrets-disable"]);
    await pacman.page.reload();
    await pacman.frame.getByRole("tab", { name: "Updates", exact: true }).waitFor();
    await expect(pacman.frame.locator(SIGNOFFS_TAB)).toHaveCount(0);
  });

  test("loads session credentials and signs off through the ArchWeb fixture", async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "secrets-enable"]);
    try {
      await pacman.page.reload();
      await pacman.frame.locator(SIGNOFFS_TAB).click();
      const row = pacman.panel.getByRole("grid", { name: "Signoff packages" }).locator("tbody tr").filter({ hasText: "htop" });
      const version = (await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim().split(" ")[1];
      await expect(row.locator('[data-label="Local"]')).toHaveText(version);
      await expect(row.locator('[data-label="Signoffs"]')).toHaveText("0 / 1");
      await expect(row.locator('[data-label="Status"]')).toHaveText("Pending");
      await row.getByRole("button", { name: "Sign off", exact: true }).click();
      await expect(row.locator('[data-label="Signoffs"]')).toHaveText("1 / 1");
      await expect(row.locator('[data-label="Status"]')).toHaveText("Approved");
      await row.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(row.locator('[data-label="Signoffs"]')).toHaveText("0 / 1");
      await expect(row.locator('[data-label="Status"]')).toHaveText("Pending");
      const state = JSON.parse(await guestCommand(pacman.frame, [FIXTURE, "state"])) as { signed: boolean; logins: number };
      expect(state.signed).toBe(false);
      expect(state.logins).toBeGreaterThanOrEqual(3);
    } finally {
      await guestCommand(pacman.frame, [FIXTURE, "secrets-disable"]);
    }
  });
});

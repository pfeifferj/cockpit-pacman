import { test, expect } from "./fixtures";
import { FIXTURE, guestCommand } from "./guest";

const SIGNOFFS_TAB = 'button[role="tab"]:has-text("Signoffs")';

test.describe("Signoffs Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test("hides Signoffs when the session has no stored credentials", async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "secrets-disable"]);
    await pacman.page.goto("/pacman#/signoffs");
    await expect(pacman.frame.getByRole("heading", { name: /^Info alert:\s*Signoffs are not available$/ })).toBeVisible();
    await expect(pacman.tab("Updates")).toHaveAttribute("aria-selected", "true");
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
      await row.getByRole("button", { name: "Sign off htop", exact: true }).click();
      await expect(row.locator('[data-label="Signoffs"]')).toHaveText("1 / 1");
      await expect(row.locator('[data-label="Status"]')).toHaveText("Approved");
      await row.getByRole("button", { name: "Revoke signoff for htop", exact: true }).click();
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

test("bulk signoff reuses a session and keeps failed packages selected", async ({ pacman }) => {
  await pacman.navigateToPlugin();
  await guestCommand(pacman.frame, [FIXTURE, "secrets-enable"]);
  await guestCommand(pacman.frame, [FIXTURE, "signoffs-partial"]);
  const sessionCounts = async () => JSON.parse(await guestCommand(pacman.frame, [FIXTURE, "state"])) as { logins: number; logouts: number };
  try {
    await pacman.page.reload();
    await pacman.frame.locator(SIGNOFFS_TAB).click();
    const table = pacman.panel.getByRole("grid", { name: "Signoff packages" });
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect.poll(async () => {
      const counts = await sessionCounts();
      return counts.logins - counts.logouts;
    }).toBe(0);
    const before = await sessionCounts();
    await pacman.panel.getByLabel("Select all packages on this page").check();
    await pacman.panel.getByRole("button", { name: "Sign off 2 packages", exact: true }).click();
    await expect(pacman.frame.getByRole("dialog")).toHaveCount(0);
    await expect(pacman.panel.getByText(/tree:.*500/)).toBeVisible();
    await expect(pacman.panel.getByRole("button", { name: "Sign off 1 package", exact: true })).toBeEnabled();
    await expect(table.locator("tbody tr").filter({ hasText: "htop" }).locator('[data-label="Status"]')).toHaveText("Approved");
    await expect.poll(async () => (await sessionCounts()).logouts - before.logouts).toBe(2);
    expect((await sessionCounts()).logins - before.logins).toBe(2);

    await guestCommand(pacman.frame, [FIXTURE, "signoffs-bulk"]);
    await pacman.panel.getByRole("button", { name: "Sign off 1 package", exact: true }).click();
    await expect(pacman.frame.getByRole("dialog")).toHaveCount(0);
    await expect(table.locator("tbody tr").filter({ hasText: "tree" }).locator('[data-label="Status"]')).toHaveText("Approved");
    await expect(pacman.panel.getByRole("button", { name: /Sign off \d+ packages?/ })).toHaveCount(0);
  } finally {
    await guestCommand(pacman.frame, [FIXTURE, "secrets-disable"]);
  }
});

import { test, expect } from "./fixtures";

const SIGNOFFS_TAB = 'button[role="tab"]:has-text("Signoffs")';

test.describe("Signoffs Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test("hides signoffs from a session with no archweb credentials", async ({ pacman }) => {
    const tab = pacman.frame.locator(SIGNOFFS_TAB);
    test.skip(await tab.count() > 0, "this session has archweb credentials");

    await expect(pacman.frame.getByRole("button", { name: /signoff/i })).toHaveCount(0);
  });

  test("lists the packages awaiting signoff", async ({ pacman }) => {
    const tab = pacman.frame.locator(SIGNOFFS_TAB);
    test.skip(await tab.count() === 0, "no archweb credentials in the session keyring");

    await tab.click();
    await pacman.waitForLoading();

    const rows = pacman.panel.locator('table[aria-label="Signoff packages"] > tbody > tr');
    test.skip(await rows.count() === 0, "nothing is awaiting signoff right now");

    const counts = pacman.panel.locator('td[data-label="Signoffs"]');
    await expect(counts.filter({ hasNotText: /^\d+ \/ \d+$/ })).toHaveCount(0);

    const statuses = pacman.panel.locator('td[data-label="Status"]');
    await expect(statuses.filter({ hasNotText: /^(Pending|Approved|Known Bad)$/ })).toHaveCount(0);
  });
});

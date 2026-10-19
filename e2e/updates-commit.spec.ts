import { test, expect } from "./fixtures";
import { guestCommand } from "./guest";

const FIXTURE = "/usr/local/libexec/cockpit-pacman-e2e/commit-fixture.py";

test.describe("Updates commit", () => {
  test.skip(process.env.COCKPIT_E2E_FIXTURE !== "1", "requires disposable guest transaction fixtures");

  test("keeps cancellation pending until package writes and hooks finish", async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await guestCommand(pacman.frame, [FIXTURE, "setup", "--phase", "pre"]);
    try {
      await pacman.page.reload();
      const apply = pacman.panel.getByRole("button", { name: "Apply 1 update", exact: true });
      await expect(apply).toBeVisible({ timeout: 30000 });
      await apply.click();
      const confirm = pacman.frame.getByRole("dialog", { name: /^Upgrade / });
      await expect.poll(async () => {
        const state = JSON.parse(await guestCommand(pacman.frame, [FIXTURE, "state"]));
        return state.pre || await confirm.isVisible();
      }).toBe(true);
      if (await confirm.isVisible()) {
        await confirm.getByRole("button", { name: "Upgrade 1 package", exact: true }).click();
      }
      await expect.poll(async () => JSON.parse(await guestCommand(pacman.frame, [FIXTURE, "state"])).pre).toBe(true);
      await pacman.panel.getByRole("button", { name: "Cancel", exact: true }).click();
      const cancellation = pacman.frame.getByRole("dialog", { name: /Cancel upgrade\?$/ });
      await cancellation.getByRole("button", { name: /^(Request cancellation|Cancel upgrade)$/ }).click();
      await expect(pacman.panel.getByRole("button", { name: "Cancelling…", exact: true })).toBeDisabled();
      const pending = JSON.parse(await guestCommand(pacman.frame, [FIXTURE, "state"]));
      expect(pending.locked).toBe(true);
      expect(pending.post).toBe(false);
      await guestCommand(pacman.frame, [FIXTURE, "release"]);
      await expect.poll(async () => {
        const state = JSON.parse(await guestCommand(pacman.frame, [FIXTURE, "state"]));
        return { version: state.version, post: state.post, locked: state.locked, pids: state.pids };
      }, { timeout: 30000 }).toEqual({ version: "2-1", post: true, locked: false, pids: [] });
      await expect(pacman.panel.getByRole("heading", { name: /Upgrade finished before the cancel took effect/ })).toBeVisible();
      await expect(pacman.panel.getByRole("button", { name: "Cancelling…", exact: true })).toHaveCount(0);
    } finally {
      await guestCommand(pacman.frame, [FIXTURE, "cleanup"]);
    }
  });
});

import { test, expect, type PackmanPage } from "./fixtures";
import { guestCommand } from "./guest";

const FIXTURE = "/usr/local/libexec/cockpit-pacman-e2e/keyring-fixture.py";

async function state(pacman: PackmanPage): Promise<{ ready: boolean; pids: number[]; locked: boolean }> {
  return JSON.parse(await guestCommand(pacman.frame, [FIXTURE, "state"]));
}

test.describe("keyring process cleanup", () => {
  test.skip(process.env.COCKPIT_E2E_FIXTURE !== "1", "requires disposable guest subprocess fixtures");

  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Keyring");
    await expect(pacman.panel.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
    await guestCommand(pacman.frame, [FIXTURE, "setup"]);
  });

  test.afterEach(async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "cleanup"]);
  });

  test("cancelling refresh terminates its grandchild and releases its lock", async ({ pacman }) => {
    await pacman.panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(async () => (await state(pacman)).ready).toBe(true);
    const running = await state(pacman);
    expect(running.pids).toHaveLength(2);
    expect(running.locked).toBe(true);
    await pacman.panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => state(pacman)).toEqual({ ready: true, pids: [], locked: false });
    await expect(pacman.panel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(pacman.panel.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  });
});

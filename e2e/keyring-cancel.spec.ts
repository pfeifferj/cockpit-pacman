import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";

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
    await pacman.panel.getByRole("button", { name: "Stop", exact: true }).click();
    await pacman.panel.getByRole("button", { name: "Stop refreshing", exact: true }).click();
    await expect.poll(() => state(pacman)).toEqual({ ready: true, pids: [], locked: false });
    await expect(pacman.panel.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(pacman.panel.getByRole("button", { name: "Back to keyring", exact: true })).toBeVisible();
  });
  for (const command of ["receive-key", "lsign-key"] as const) {
    test(`${command} cancellation stops descendants before returning`, async ({ pacman }) => {
      const result = JSON.parse(await guestCommand(pacman.frame, ["python3", "-c", `
import json, pathlib, subprocess, sys, time
state = pathlib.Path('/run/cockpit-pacman-e2e/keyring')
process = subprocess.Popen([sys.argv[1], sys.argv[2], '3B94A80E50A477C7C8E44F8A0FA8E1BCB1F1A2C0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    deadline = time.monotonic() + 15
    while not (state / 'ready').exists():
        if process.poll() is not None:
            raise RuntimeError(process.communicate())
        if time.monotonic() > deadline:
            raise RuntimeError('Key subprocess did not start')
        time.sleep(0.05)
    process.stdin.write('cancel\\n')
    process.stdin.flush()
    output, error = process.communicate(timeout=10)
    print(json.dumps({'code': process.returncode, 'response': json.loads(output), 'arguments': (state / 'arguments').read_text().splitlines()}))
finally:
    if process.poll() is None:
        process.terminate()
        process.communicate(timeout=10)
`, BACKEND, command]));
      expect(result.response.code).toBe("cancelled");
      expect(result.arguments).toContain(command === "receive-key" ? "--recv-keys" : "--lsign-key");
      expect(result.arguments).not.toContain(command === "receive-key" ? "--lsign-key" : "--recv-keys");
      await expect.poll(() => state(pacman)).toEqual({ ready: true, pids: [], locked: false });
    });
  }
});

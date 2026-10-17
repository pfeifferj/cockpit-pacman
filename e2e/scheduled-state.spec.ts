import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";
import type { ScheduledRunsResponse } from "../src/bindings";

const FIXTURE = "/usr/local/libexec/cockpit-pacman-e2e/schedule-fixture.py";

interface ScheduleState {
  service: string;
  exit_status: number;
  result: string;
  invocation_id: string;
  pre: boolean;
  post: boolean;
  version: string | null;
  locked: boolean;
  latest_run: { status: string; packages_upgraded: number; details: string[] } | null;
  journal: { message: string; priority: string }[];
}

async function fixture(pacman: PackmanPage, ...args: string[]) {
  return guestCommand(pacman.frame, [FIXTURE, ...args]);
}

async function state(pacman: PackmanPage): Promise<ScheduleState> {
  return JSON.parse(await fixture(pacman, "state"));
}

async function runs(pacman: PackmanPage): Promise<ScheduledRunsResponse> {
  return JSON.parse(await guestCommand(pacman.frame, [BACKEND, "list-scheduled-runs", "0", "10"], false));
}

test.describe("scheduled service state and deferrals", () => {
  test.skip(process.env.COCKPIT_E2E_FIXTURE !== "1", "requires the disposable guest package fixture");

  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test.afterEach(async ({ pacman }) => {
    await fixture(pacman, "cleanup");
  });

  test("shows a running and stopping unit until its hooks complete", async ({ pacman }) => {
    await fixture(pacman, "setup");
    await fixture(pacman, "start");
    await expect.poll(async () => (await state(pacman)).pre, { timeout: 30000 }).toBe(true);
    const running = await runs(pacman);
    expect(running.current_run?.state).toBe("activating");
    expect(running.current_run?.started_at).toBeTruthy();
    expect(running.current_run?.invocation_id).toBe((await state(pacman)).invocation_id);
    expect(running.runs.some(run => run.invocation_id === "previous-fixture-run" && run.status === "ok")).toBe(true);
    expect(running.runs.some(run => run.invocation_id === running.current_run?.invocation_id)).toBe(false);

    await pacman.panel.getByRole("button", { name: "Manage Schedule" }).click();
    const modal = pacman.frame.getByRole("dialog");
    await expect(modal.getByText("Scheduled upgrade is running")).toBeVisible();
    await fixture(pacman, "stop");
    await expect.poll(async () => (await runs(pacman)).current_run?.state).toBe("deactivating");
    await expect(modal.getByText("Scheduled upgrade is stopping")).toBeVisible({ timeout: 10000 });
    expect((await state(pacman)).post).toBe(false);

    await fixture(pacman, "release");
    await expect.poll(async () => (await state(pacman)).service, { timeout: 30000 }).toBe("inactive");
    await expect(modal.getByText("Scheduled upgrade is stopping")).toHaveCount(0, { timeout: 10000 });
    await modal.getByRole("button", { name: "Show run history" }).click();
    const latest = modal.getByRole("grid", { name: "Scheduled run history" }).locator("tbody tr").first();
    await expect(latest.locator('[data-label="Status"]')).toContainText("Success");
    await expect(latest.locator('[data-label="Packages"]')).toHaveText("1 upgraded");
    expect((await runs(pacman)).current_run).toBeUndefined();
    expect(await state(pacman)).toMatchObject({ version: "2-1", post: true, locked: false });
  });

  const deferrals = [
    { scenario: "lock", reason: /database locked/i },
    { scenario: "limit", reason: /exceed safety limit/i },
    { scenario: "intervention", reason: /conflicts detected/i },
  ];
  for (const { scenario, reason } of deferrals) {
    test(`${scenario} deferral warns in the journal and triggers OnFailure`, async ({ pacman }) => {
      await fixture(pacman, "setup", "--scenario", scenario);
      await fixture(pacman, "start");
      await expect.poll(async () => (await state(pacman)).service, { timeout: 30000 }).toBe("failed");
      const result = await state(pacman);
      expect(result.exit_status).not.toBe(0);
      expect(result.result).toBe("exit-code");
      expect(result.latest_run).toMatchObject({ status: "skipped", packages_upgraded: 0 });
      expect(result.latest_run?.details.join("; ")).toMatch(reason);
      expect(result).toMatchObject({ version: "1-1", pre: false, post: false });
      expect(result.locked).toBe(scenario === "lock");
      await expect.poll(async () => {
        const current = await state(pacman);
        return {
          warning: current.journal.some(event => event.priority === "4" && /Scheduled upgrade deferred/.test(event.message) && reason.test(event.message)),
          onFailure: current.journal.some(event => event.priority === "3" && /scheduled run failed: unit=cockpit-pacman-scheduled\.service/.test(event.message)),
        };
      }).toEqual({ warning: true, onFailure: true });
      const history = await runs(pacman);
      expect(history.current_run).toBeUndefined();
      expect(history.runs[0].status).toBe("skipped");
    });
  }
});

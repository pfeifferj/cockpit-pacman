import { test, expect } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";
import type { ScheduleConfig } from "../src/bindings";

test.describe("Scheduled upgrades", () => {
  let original: ScheduleConfig | undefined;

  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    original = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "get-schedule"]));
    await guestCommand(pacman.frame, [BACKEND, "set-schedule", "true", "check", "daily", "7"]);
  });

  test.afterEach(async ({ pacman }) => {
    if (original) {
      await guestCommand(pacman.frame, [BACKEND, "set-schedule", String(original.enabled), original.mode,
        original.schedule, String(original.max_packages)]);
    }
  });

  test("loads saved settings, persists edits and shows a real scheduled run", async ({ pacman }) => {
    await pacman.panel.getByRole("button", { name: "Manage Schedule" }).click();
    let modal = pacman.frame.getByRole("dialog");
    await expect(modal.getByRole("heading", { name: "Scheduled Upgrades" })).toBeVisible();
    await expect(modal.locator("#schedule-enabled")).toBeChecked();
    await expect(modal.locator("#schedule-mode")).toHaveValue("check");
    await expect(modal.locator("#schedule-preset")).toHaveValue("daily");
    await expect(modal.getByText("Active", { exact: true })).toBeVisible();
    await modal.locator("#schedule-mode").selectOption("upgrade");
    await expect(modal.locator("#schedule-max-packages input")).toHaveValue("7");
    await modal.locator("#schedule-max-packages input").fill("5");
    await modal.locator("#schedule-mode").selectOption("check");
    await modal.locator("#schedule-preset").selectOption("weekly");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await expect(modal.getByRole("heading", { name: /Saved/ })).toBeVisible();
    const saved = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "get-schedule"])) as ScheduleConfig;
    expect(saved).toMatchObject({ enabled: true, mode: "check", schedule: "weekly", max_packages: 5, timer_active: true });
    await modal.getByRole("button", { name: "Close", exact: true }).last().click();
    await guestCommand(pacman.frame, ["systemctl", "start", "cockpit-pacman-scheduled.service"]);
    await pacman.panel.getByRole("button", { name: "Manage Schedule" }).click();
    modal = pacman.frame.getByRole("dialog");
    await expect(modal.locator("#schedule-mode")).toHaveValue("check");
    await expect(modal.locator("#schedule-preset")).toHaveValue("weekly");
    await modal.getByRole("button", { name: "Show run history" }).click();
    const latest = modal.getByRole("grid", { name: "Scheduled run history" }).locator("tbody tr").first();
    await expect(latest.locator('[data-label="Mode"]')).toHaveText("check");
    await expect(latest.locator('[data-label="Status"]')).toContainText("Success");
    await expect(latest.locator('[data-label="Packages"]')).toHaveText(/^\d[\d,]* checked$/);
  });
});

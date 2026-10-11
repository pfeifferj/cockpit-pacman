import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { test, expect, type PackmanPage } from "./fixtures";
import type { CacheInfo, CacheFiles } from "../src/bindings";

const fixture = readFileSync(new URL("../test/e2e/cache-fixture.py", import.meta.url), "utf8");
const backend = "/usr/libexec/cockpit-pacman/cockpit-pacman-backend";

async function guestCommand(pacman: PackmanPage, args: string[], input?: string): Promise<string> {
  return pacman.frame.locator("body").evaluate(async (_body, request) => {
    const cockpit = Reflect.get(globalThis, "cockpit") as {
      spawn(args: string[], options: { superuser: "require"; err: "message" }): Promise<string> & { input(data: string): void };
    };
    const process = cockpit.spawn(request.args, { superuser: "require", err: "message" });
    if (request.input !== undefined) process.input(request.input);
    return await process;
  }, { args, input });
}

test("pages cache groups and files, then cleans only selected packages", async ({ pacman }) => {
  test.setTimeout(180000);
  await pacman.navigateToPlugin();
  const prepared: { path: string; groups: number; files: number } = JSON.parse(
    await guestCommand(pacman, ["python3", "-", "prepare"], fixture),
  );
  try {
    const summary: CacheInfo = JSON.parse(await guestCommand(pacman, [backend, "cache-info"]));
    expect(summary.path).toBe(prepared.path);
    expect(summary.package_count).toBe(prepared.files);
    expect(summary.total).toBe(prepared.groups);
    expect(summary.groups).toHaveLength(50);
    expect(JSON.stringify(summary).length).toBeLessThan(10000);

    await pacman.navigateToPlugin();
    await pacman.frame.getByRole("tab", { name: "Cache", exact: true }).click();
    const rows = pacman.panel.locator('table[aria-label="Cached packages"] tbody tr');
    await expect(rows).toHaveCount(50);
    await expect(rows.first()).toContainText("cache-fixture-000");

    await pacman.panel.getByRole("button", { name: "View cached files for cache-fixture-000" }).click();
    const filesDialog = pacman.frame.getByRole("dialog", { name: "Cached files for cache-fixture-000" });
    const filenames = filesDialog.locator('td[data-label="Filename"]');
    await expect(filenames).toHaveCount(50);
    await expect(filenames.nth(0)).toHaveText("cache-fixture-000-59-1-any.pkg.tar.zst");
    await expect(filenames.nth(1)).toHaveText("cache-fixture-000-59-1-x86_64.pkg.tar.zst");
    await filesDialog.getByRole("button", { name: "Go to next page" }).click();
    await expect(filenames).toHaveCount(11);
    await expect(filenames.last()).toHaveText("cache-fixture-000-0-1-any.pkg.tar.zst");
    await filesDialog.getByRole("button", { name: "Close", exact: true }).last().click();

    await rows.first().getByRole("checkbox").uncheck();
    await pacman.panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(pacman.panel.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(rows.first().getByRole("checkbox")).not.toBeChecked();
    await pacman.panel.getByRole("button", { name: "Go to next page" }).first().click();
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("cache-fixture-050");
    await expect(rows.first().getByRole("checkbox")).toBeChecked();
    await pacman.panel.getByLabel("Filter cached packages", { exact: true }).fill("cache-fixture-001");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("cache-fixture-001");
    const clean = pacman.panel.getByRole("button", { name: "Clean selected packages", exact: true });
    await expect(clean).toBeEnabled();
    await clean.click();
    const confirmation = pacman.frame.getByRole("dialog", { name: "Clean package cache?" });
    const slider = confirmation.getByRole("slider");
    for (let index = 0; index < 3; index++) await slider.press("ArrowLeft");
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await confirmation.getByRole("button", { name: "Clean Cache", exact: true }).click();
    await expect(pacman.panel.getByRole("heading", { name: "Cache cleaned" })).toBeVisible({ timeout: 30000 });

    const remaining: CacheInfo = JSON.parse(await guestCommand(pacman, [backend, "cache-info"]));
    expect(remaining.unique_packages).toBe(1);
    expect(remaining.package_count).toBe(61);
    expect(remaining.groups[0].name).toBe("cache-fixture-000");
    const removed: CacheFiles = JSON.parse(await guestCommand(pacman, [backend, "cache-files", "cache-fixture-001"]));
    expect(removed.total).toBe(0);
    const excluded: CacheFiles = JSON.parse(await guestCommand(pacman, [backend, "cache-files", "cache-fixture-000"]));
    expect(excluded.total).toBe(61);
    expect(excluded.files).toHaveLength(50);

    await pacman.panel.getByRole("button", { name: "View Cache", exact: true }).click();
    await expect(pacman.panel.getByText("No cached packages match this filter")).toBeVisible();
    await pacman.panel.getByLabel("Filter cached packages", { exact: true }).fill("");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("cache-fixture-000");
  } finally {
    await guestCommand(pacman, ["python3", "-", "cleanup", prepared.path], fixture);
  }
});

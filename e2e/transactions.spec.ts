import { test, expect, type PackmanPage } from "./fixtures";
import { FIXTURE, guestCommand } from "./guest";

async function archiveState(pacman: PackmanPage) {
  return JSON.parse(await guestCommand(pacman.frame, [FIXTURE, "state"])) as {
    downloads: number; completed: number; active_transactions: number; signature_requests: number; disconnections: number;
  };
}

async function openArchive(pacman: PackmanPage) {
  await pacman.switchTab("Installed Packages");
  await pacman.panel.getByPlaceholder("Search packages...").fill("htop");
  await pacman.panel.getByRole("button", { name: "htop", exact: true }).click();
  await pacman.frame.getByRole("dialog").getByRole("button", { name: "Downgrade", exact: true }).click();
  const modal = pacman.frame.getByRole("dialog");
  await modal.getByRole("button", { name: "Archive", exact: true }).click();
  const row = modal.locator("tbody tr").first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^Select / }).click();
  return modal;
}

test.describe("Archive transactions", () => {
  let installed: string;

  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    installed = (await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim();
  });

  test.afterEach(async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "archive-release"]);
    await expect.poll(async () => (await archiveState(pacman)).active_transactions, { timeout: 30000 }).toBe(0);
    await expect.poll(async () => guestCommand(pacman.frame, ["test", "!", "-e", "/var/lib/pacman/db.lck"])
      .then(() => true, () => false), { timeout: 30000 }).toBe(true);
    await guestCommand(pacman.frame, [FIXTURE, "restore-package"]);
    expect((await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim()).toBe(installed);
  });

  test("reports a failed download without modifying the installed version", async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "archive-failure"]);
    const modal = await openArchive(pacman);
    await expect(modal).toContainText(/Failed to download htop[^:]+: failed to retrieve some files/);
    await expect(modal).toContainText(/The requested URL returned error:\s*503/);
    await expect(modal.getByRole("button", { name: "Check again", exact: true })).toBeEnabled();
    await expect(modal.getByText("Version change complete", { exact: true })).toHaveCount(0);
    const state = await archiveState(pacman);
    expect(state.downloads).toBeGreaterThan(0);
    expect((await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim()).toBe(installed);
  });

  test("cancels an archive preview download without changing packages", async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "archive-stall"]);
    const modal = await openArchive(pacman);
    await expect.poll(async () => (await archiveState(pacman)).downloads).toBeGreaterThan(0);
    await expect.poll(async () => (await archiveState(pacman)).active_transactions).toBeGreaterThan(0);
    await modal.getByRole("button", { name: "Cancel download", exact: true }).click();
    await expect(modal.locator("tbody tr").first()).toBeVisible();
    await expect.poll(async () => (await archiveState(pacman)).active_transactions, { timeout: 10000 }).toBe(0);
    await expect.poll(async () => (await archiveState(pacman)).disconnections, { timeout: 10000 }).toBeGreaterThan(0);
    expect((await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim()).toBe(installed);
    await guestCommand(pacman.frame, [FIXTURE, "archive-ready"]);
    await modal.locator("tbody tr").first().getByRole("button", { name: /^Select / }).click();
    await expect(modal.getByRole("button", { name: /^Upgrade htop to / })).toBeVisible({ timeout: 30000 });
    expect((await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim()).toBe(installed);
  });

  test("installs the signed archive when the transfer is not cancelled", async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "archive-ready"]);
    const modal = await openArchive(pacman);
    await modal.getByRole("button", { name: /^Upgrade htop to / }).click();
    await expect(modal.getByText("Version change complete", { exact: true })).toBeVisible({ timeout: 30000 });
    expect((await archiveState(pacman)).signature_requests).toBeGreaterThan(0);
    expect((await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim()).not.toBe(installed);
  });

  test("rejects the archive when its required signature is missing", async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "archive-unsigned"]);
    const modal = await openArchive(pacman);
    await expect(modal).toContainText(/Failed to download htop[^:]+: failed to retrieve some files/);
    await expect(modal).toContainText(/failed retrieving file 'htop-[^']+\.sig'/);
    await expect(modal).toContainText(/The requested URL returned error:\s*404/);
    await expect(modal.getByRole("button", { name: "Check again", exact: true })).toBeEnabled();
    await expect(modal.getByText("Version change complete", { exact: true })).toHaveCount(0);
    const state = await archiveState(pacman);
    expect(state.completed).toBeGreaterThan(0);
    expect(state.signature_requests).toBeGreaterThan(0);
    expect((await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim()).toBe(installed);
  });
  test("preserves a cached rollback package without its required signature", async ({ pacman }) => {
    await guestCommand(pacman.frame, [FIXTURE, "archive-ready"]);
    const paths = JSON.parse(await guestCommand(pacman.frame, ["cat", "/run/cockpit-pacman-e2e/packages.json"]));
    await guestCommand(pacman.frame, ["cp", paths.target, paths.cached_target]);
    const before = await guestCommand(pacman.frame, ["sha256sum", paths.cached_target]);
    const modal = await openArchive(pacman);
    await expect(modal).toContainText("missing required signature");
    expect(await guestCommand(pacman.frame, ["sha256sum", paths.cached_target])).toBe(before);
    expect((await archiveState(pacman)).downloads).toBe(0);
    expect((await guestCommand(pacman.frame, ["pacman", "-Q", "htop"])).trim()).toBe(installed);
  });

});

import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";

const FIXTURE = "/usr/local/libexec/cockpit-pacman-e2e/commit-fixture.py";
const PACKAGE = "cockpit-pacman-e2e-commit";

interface CommitState {
  version: string | null;
  victim_version: string | null;
  payload: string | null;
  pre: boolean;
  scriptlet: boolean;
  post: boolean;
  pids: number[];
  locked: boolean;
  service: string;
  latest_run: { status: string; packages_upgraded: number } | null;
  signing: { fingerprint: string; keyring_fingerprints: string[] } | null;
}

interface ProcessHandle extends Promise<string> {
  stream(callback: (chunk: string) => void): void;
  input(data: string, stream?: boolean): void;
  close(problem: string): void;
}

interface BrowserRun {
  process: ProcessHandle;
  output: string;
  done: boolean;
  error?: string;
}

async function fixture(pacman: PackmanPage, ...args: string[]) {
  return guestCommand(pacman.frame, [FIXTURE, ...args]);
}

async function state(pacman: PackmanPage): Promise<CommitState> {
  return JSON.parse(await fixture(pacman, "state"));
}

async function start(pacman: PackmanPage, args = ["install-package", PACKAGE]) {
  await pacman.frame.locator("body").evaluate((_body, args) => {
    const cockpit = Reflect.get(globalThis, "cockpit") as {
      spawn(args: string[], options: { superuser: "require"; err: "message" }): ProcessHandle;
    };
    const process = cockpit.spawn(args, { superuser: "require", err: "message" });
    const run: BrowserRun = { process, output: "", done: false };
    Reflect.set(globalThis, "commitSafetyRun", run);
    process.stream(chunk => { run.output += chunk; });
    void process.then(() => { run.done = true; }, error => {
      run.done = true;
      run.error = String(error);
    });
  }, [BACKEND, ...args]);
}

async function control(pacman: PackmanPage, action: "cancel" | "close") {
  await pacman.frame.locator("body").evaluate((_body, action) => {
    const run = Reflect.get(globalThis, "commitSafetyRun") as BrowserRun;
    if (action === "cancel") run.process.input("cancel\n", true);
    else run.process.close("cancelled");
  }, action);
}

async function result(pacman: PackmanPage) {
  return pacman.frame.locator("body").evaluate(() => {
    const run = Reflect.get(globalThis, "commitSafetyRun") as BrowserRun;
    return { done: run.done, error: run.error, output: run.output };
  });
}

async function waitForBarrier(pacman: PackmanPage, phase: "pre" | "scriptlet") {
  await expect.poll(async () => (await state(pacman))[phase], { timeout: 30000 }).toBe(true);
  const pending = await state(pacman);
  expect(pending.post).toBe(false);
  expect(pending.pids).toHaveLength(1);
  expect(pending.locked).toBe(true);
}

async function expectCommitted(pacman: PackmanPage) {
  await fixture(pacman, "release");
  await expect.poll(async () => {
    const current = await state(pacman);
    return { version: current.version, payload: current.payload, post: current.post,
      pids: current.pids, locked: current.locked };
  }, { timeout: 30000 }).toEqual({ version: "2-1", payload: "2-1", post: true, pids: [], locked: false });
}

test.describe("package transaction boundaries", () => {
  test.skip(process.env.COCKPIT_E2E_FIXTURE !== "1", "requires the disposable guest package fixture");

  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test.afterEach(async ({ pacman }) => {
    await fixture(pacman, "cleanup");
  });

  test("finishes post hooks after cancellation during a pre-transaction hook", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "pre");
    await start(pacman);
    await waitForBarrier(pacman, "pre");
    await control(pacman, "cancel");
    expect((await result(pacman)).done).toBe(false);
    await expectCommitted(pacman);
    await expect.poll(async () => (await result(pacman)).done).toBe(true);
    const events = (await result(pacman)).output.trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.type === "complete")?.success).toBe(true);
  });

  test("finishes package writes and post hooks after SIGTERM", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "scriptlet");
    await start(pacman);
    await waitForBarrier(pacman, "scriptlet");
    await fixture(pacman, "term");
    expect((await result(pacman)).done).toBe(false);
    await expectCommitted(pacman);
    await expect.poll(async () => (await result(pacman)).done).toBe(true);
  });

  test("finishes post hooks after Cockpit closes the process channel", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "scriptlet");
    await start(pacman);
    await waitForBarrier(pacman, "scriptlet");
    await control(pacman, "close");
    const pending = await state(pacman);
    expect(pending.pids).toHaveLength(1);
    expect(pending.locked).toBe(true);
    await expectCommitted(pacman);
  });

  test("finishes post hooks when the scheduled unit is stopped during commit", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "pre");
    await fixture(pacman, "scheduled-start");
    await waitForBarrier(pacman, "pre");
    await fixture(pacman, "scheduled-stop");
    await expectCommitted(pacman);
    await expect.poll(async () => (await state(pacman)).service).toBe("inactive");
    expect((await state(pacman)).latest_run).toMatchObject({ status: "ok", packages_upgraded: 1 });
  });

  test("retains the commit failure when cancellation is pending", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "pre", "--fail");
    await start(pacman);
    await waitForBarrier(pacman, "pre");
    await control(pacman, "cancel");
    await fixture(pacman, "release");
    await expect.poll(async () => (await result(pacman)).done, { timeout: 30000 }).toBe(true);
    const current = await state(pacman);
    expect(current).toMatchObject({ version: "1-1", payload: "1-1", post: false, pids: [], locked: false });
    const events = (await result(pacman)).output.trim().split("\n").map(line => JSON.parse(line));
    const complete = events.find(event => event.type === "complete");
    expect(complete?.success).toBe(false);
    expect(complete?.message).toMatch(/hook/i);
  });

  test("requires new consent when refreshed metadata introduces a removal", async ({ pacman }) => {
    await fixture(pacman, "setup", "--removal");
    const originalPreview = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "preflight-upgrade"]));
    expect(originalPreview.removals ?? []).toEqual([]);
    await fixture(pacman, "publish-conflict");

    await start(pacman, ["upgrade"]);
    await expect.poll(async () => (await result(pacman)).done, { timeout: 30000 }).toBe(true);
    expect((await result(pacman)).output).toContain("was not approved");
    expect(await state(pacman)).toMatchObject({
      version: "1-1", victim_version: "1-1", pre: false, post: false, pids: [], locked: false,
    });

    const preview = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "preflight-upgrade"]));
    expect(preview.removals).toEqual([PACKAGE + "-old"]);
    await fixture(pacman, "release");
    await start(pacman, ["upgrade", "", "", preview.removals.join(",")]);
    await expect.poll(async () => (await result(pacman)).done, { timeout: 30000 }).toBe(true);
    expect(await state(pacman)).toMatchObject({
      version: "3-1", victim_version: null, payload: "3-1", pre: true, post: true, pids: [], locked: false,
    });
    const events = (await result(pacman)).output.trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.type === "complete")?.success).toBe(true);
  });

  test("keeps a saved ignore when an update appears after preview", async ({ pacman }) => {
    await fixture(pacman, "setup", "--current-repo");
    await guestCommand(pacman.frame, [BACKEND, "add-ignored", PACKAGE]);
    const before = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "sync-package-info", PACKAGE]));
    expect(before.version).toBe("1-1");
    const preview = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "preflight-upgrade"]));
    expect(preview.packages_to_upgrade).toBe(0);
    await fixture(pacman, "publish-update");
    await fixture(pacman, "release");

    await start(pacman, ["upgrade"]);
    await expect.poll(async () => (await result(pacman)).done, { timeout: 30000 }).toBe(true);
    const events = (await result(pacman)).output.trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.type === "complete")?.success).toBe(true);
    const after = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "sync-package-info", PACKAGE]));
    expect(after.version).toBe("2-1");
    expect(await state(pacman)).toMatchObject({
      version: "1-1", payload: "1-1", pre: false, post: false, pids: [], locked: false,
    });
    const ignored = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "list-ignored"]));
    expect(ignored.packages).toContain(PACKAGE);
  });

  for (const operation of ["install", "downgrade"] as const) {
    test(`${operation} refuses to remove a conflicting installed package`, async ({ pacman }) => {
      await fixture(pacman, "setup", "--removal");
      if (operation === "install") {
        await fixture(pacman, "uninstall-target");
        await fixture(pacman, "publish-conflict");
        await guestCommand(pacman.frame, [BACKEND, "sync-database"]);
      } else {
        await fixture(pacman, "cached-conflict");
      }
      await fixture(pacman, "release");
      await start(pacman, operation === "install" ? ["install-package", PACKAGE] : ["downgrade", PACKAGE, "0-1"]);
      await expect.poll(async () => (await result(pacman)).done, { timeout: 30000 }).toBe(true);
      const output = (await result(pacman)).output;
      expect(output).toContain("Review the removal with pacman before retrying");
      const events = output.trim().split("\n").map(line => JSON.parse(line));
      expect(events.find(event => event.type === "complete")?.success).toBe(false);
      expect(await state(pacman)).toMatchObject({
        version: operation === "install" ? null : "1-1", victim_version: "1-1",
        payload: operation === "install" ? null : "1-1", pre: false, post: false, pids: [], locked: false,
      });
    });
  }

  test("refuses a signing key first requested during commit", async ({ pacman }) => {
    await fixture(pacman, "setup");
    await fixture(pacman, "unknown-signer");
    await guestCommand(pacman.frame, [BACKEND, "sync-database"]);
    const before = await state(pacman);
    expect(before.signing?.keyring_fingerprints).toEqual([]);
    const preview = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "preflight-upgrade"]));
    expect(preview.packages_to_upgrade).toBe(1);
    expect(preview.import_keys ?? []).toEqual([]);
    await fixture(pacman, "release");

    await start(pacman, ["upgrade"]);
    await expect.poll(async () => (await result(pacman)).done, { timeout: 30000 }).toBe(true);
    const output = (await result(pacman)).output;
    expect(output).toContain("needs verification");
    expect(output).toContain(before.signing!.fingerprint.slice(-16));
    const events = output.trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.type === "complete")?.success).toBe(false);
    expect(await state(pacman)).toMatchObject({
      version: "1-1", payload: "1-1", pre: false, post: false, pids: [], locked: false,
      signing: { fingerprint: before.signing!.fingerprint, keyring_fingerprints: [] },
    });
  });
  for (const operation of ["install"] as const) {
    test(`${operation} rejects a changed removal plan and accepts renewed consent`, async ({ pacman }) => {
      await fixture(pacman, "setup", "--removal", "--phase", "pre");
      if (operation === "install") {
        await fixture(pacman, "uninstall-target");
        await fixture(pacman, "publish-conflict");
        await guestCommand(pacman.frame, [BACKEND, "sync-database"]);
      } else {
        await fixture(pacman, "cached-conflict");
      }
      const previewArgs = operation === "install" ? ["preflight-install", PACKAGE] : ["preflight-downgrade", PACKAGE, "0-1"];
      const commandArgs = operation === "install" ? ["install-package", PACKAGE, ""] : ["downgrade", PACKAGE, "0-1", ""];
      const preview = JSON.parse(await guestCommand(pacman.frame, [BACKEND, ...previewArgs]));
      expect(preview.success).toBe(true);
      expect(preview.remove.map((pkg: { name: string }) => pkg.name)).toEqual([`${PACKAGE}-old`]);
      await fixture(pacman, "install-extra");
      await start(pacman, [...commandArgs, `${PACKAGE}-old`]);
      await expect.poll(async () => (await result(pacman)).done).toBe(true);
      expect((await result(pacman)).output).toContain(`removal of ${PACKAGE}-other was not approved`);
      expect(await state(pacman)).toMatchObject({
        version: operation === "install" ? null : "1-1", victim_version: "1-1", extra_version: "1-1",
        pre: false, post: false, pids: [], locked: false,
      });
      const refreshed = JSON.parse(await guestCommand(pacman.frame, [BACKEND, ...previewArgs]));
      const approved = refreshed.remove.map((pkg: { name: string }) => pkg.name).sort();
      expect(approved).toEqual([`${PACKAGE}-old`, `${PACKAGE}-other`]);
      await start(pacman, [...commandArgs, approved.join(",")]);
      await waitForBarrier(pacman, "pre");
      await fixture(pacman, "release");
      await expect.poll(async () => (await result(pacman)).done).toBe(true);
      const version = operation === "install" ? "3-1" : "0-1";
      expect(await state(pacman)).toMatchObject({ version, payload: version, victim_version: null, extra_version: null,
        post: true, pids: [], locked: false });
    });
  }

  test("refuses a recursive removal added after the preview", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "pre");
    await fixture(pacman, "removal-graph");
    const preview = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "preflight-remove", PACKAGE]));
    expect(preview.remove.map((pkg: { name: string }) => pkg.name)).toEqual([PACKAGE]);
    await guestCommand(pacman.frame, ["pacman", "-R", "--noconfirm", `${PACKAGE}-consumer`]);
    await start(pacman, ["remove-package", PACKAGE, "", PACKAGE]);
    await expect.poll(async () => (await result(pacman)).done).toBe(true);
    expect((await result(pacman)).output).toContain(`removal of ${PACKAGE}-dep was not approved`);
    expect(await state(pacman)).toMatchObject({ version: "4-1", dependency_version: "1-1", pre: false, post: false, locked: false });
    const refreshed = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "preflight-remove", PACKAGE]));
    expect(refreshed.remove.map((pkg: { name: string }) => pkg.name).sort()).toEqual([PACKAGE, `${PACKAGE}-dep`]);
    await start(pacman, ["remove-package", PACKAGE, "", `${PACKAGE},${PACKAGE}-dep`]);
    await waitForBarrier(pacman, "pre");
    await fixture(pacman, "release");
    await expect.poll(async () => (await result(pacman)).done).toBe(true);
    expect(await state(pacman)).toMatchObject({ version: null, dependency_version: null, post: true, pids: [], locked: false });
  });

  test("refuses an orphan that became explicitly installed after preview", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "pre");
    await guestCommand(pacman.frame, ["pacman", "-D", "--asdeps", PACKAGE]);
    const preview = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "preflight-remove-orphans", PACKAGE]));
    expect(preview.remove.map((pkg: { name: string }) => pkg.name)).toEqual([PACKAGE]);
    await guestCommand(pacman.frame, ["pacman", "-D", "--asexplicit", PACKAGE]);
    await start(pacman, ["remove-orphans", "", PACKAGE, PACKAGE]);
    await expect.poll(async () => (await result(pacman)).done).toBe(true);
    const events = (await result(pacman)).output.trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.type === "complete")).toMatchObject({ success: false, code: "transaction_failed" });
    expect(await state(pacman)).toMatchObject({ version: "1-1", pre: false, post: false, pids: [], locked: false });
  });

  async function openInstall(pacman: PackmanPage) {
    await pacman.switchTab("Search Packages");
    await pacman.panel.getByPlaceholder(/Search/).first().fill(PACKAGE);
    await pacman.panel.getByRole("button", { name: PACKAGE, exact: true }).click();
    await pacman.frame.getByRole("dialog").getByRole("button", { name: "Install", exact: true }).click();
    const dialog = pacman.frame.getByRole("dialog", { name: `Install ${PACKAGE}` });
    await expect(dialog.getByRole("button", { name: `Install ${PACKAGE}`, exact: true })).toBeVisible();
    return dialog;
  }

  for (const fail of [false, true]) {
    test(`keeps the install dialog busy through cancelled commit${fail ? " failure" : " and post hooks"}`, async ({ pacman }) => {
      await fixture(pacman, "setup", "--phase", "pre", ...(fail ? ["--fail"] : []));
      await fixture(pacman, "uninstall-target");
      const dialog = await openInstall(pacman);
      await dialog.getByRole("button", { name: `Install ${PACKAGE}`, exact: true }).click();
      await waitForBarrier(pacman, "pre");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.getByRole("button", { name: `Stop installing ${PACKAGE}`, exact: true }).click();
      await expect(dialog.getByRole("button", { name: /Cancelling/ })).toHaveAttribute("aria-disabled", "true");
      await pacman.page.keyboard.press("Escape");
      await pacman.frame.locator(".pf-v6-c-backdrop").click({ position: { x: 1, y: 1 } });
      await expect(dialog).toBeVisible();
      expect((await state(pacman)).post).toBe(false);
      await fixture(pacman, "release");
      await expect.poll(async () => (await state(pacman)).pids).toEqual([]);
      await expect(dialog.getByRole("button", { name: /Cancelling/ })).toHaveCount(0);
      if (fail) {
        await expect(dialog).toContainText(/failed to run transaction hooks/);
        expect(await state(pacman)).toMatchObject({ version: null, post: false, locked: false });
      } else {
        await expect(dialog).toContainText(`${PACKAGE} has been installed.`);
        await expect(dialog).toContainText(/finished before it could be stopped/);
        expect(await state(pacman)).toMatchObject({ version: "2-1", payload: "2-1", post: true, locked: false });
      }
    });
  }

  test("keeps a background install attached to its original process", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "pre");
    await fixture(pacman, "uninstall-target");
    const dialog = await openInstall(pacman);
    await dialog.getByRole("button", { name: `Install ${PACKAGE}`, exact: true }).click();
    await waitForBarrier(pacman, "pre");
    const pids = (await state(pacman)).pids;
    await dialog.getByRole("button", { name: "Run in background", exact: true }).click();
    await pacman.switchTab("Installed Packages");
    await expect(pacman.frame.getByRole("heading", { name: new RegExp(`Installing ${PACKAGE} is running`) })).toBeVisible();
    await pacman.frame.getByRole("button", { name: "View progress", exact: true }).click();
    await expect(dialog.getByRole("log")).not.toBeEmpty();
    expect((await state(pacman)).pids).toEqual(pids);
    await dialog.getByRole("button", { name: "Run in background", exact: true }).click();
    await expectCommitted(pacman);
    await expect(pacman.frame.getByRole("heading", { name: new RegExp(`Install ${PACKAGE} finished`) })).toHaveCount(1);
    await pacman.frame.getByRole("button", { name: "View result", exact: true }).click();
    await expect(dialog).toContainText("Package installed");
  });

  test("requires removal consent in the install preview", async ({ pacman }) => {
    await fixture(pacman, "setup", "--removal", "--phase", "pre");
    await fixture(pacman, "uninstall-target");
    await fixture(pacman, "publish-conflict");
    await guestCommand(pacman.frame, [BACKEND, "sync-database"]);
    const dialog = await openInstall(pacman);
    const commit = dialog.getByRole("button", { name: `Install ${PACKAGE}`, exact: true });
    await expect(commit).toHaveAttribute("aria-disabled", "true");
    expect((await state(pacman)).pids).toEqual([]);
    await dialog.getByRole("checkbox", { name: `Remove ${PACKAGE}-old`, exact: true }).check();
    await expect(commit).not.toHaveAttribute("aria-disabled", "true");
    await commit.click();
    await waitForBarrier(pacman, "pre");
    await fixture(pacman, "release");
    await expect(dialog).toContainText("Package installed");
    expect(await state(pacman)).toMatchObject({ version: "3-1", victim_version: null, post: true, locked: false });
  });

  test("keeps a selected orphan removal alive when its filter closes", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "pre");
    await fixture(pacman, "removal-graph");
    await guestCommand(pacman.frame, ["pacman", "-D", "--asdeps", PACKAGE]);
    const tree = await guestCommand(pacman.frame, ["pacman", "-Q", "tree"]);
    await pacman.switchTab("Installed Packages");
    await pacman.selectFilter("Orphans");
    await pacman.panel.getByRole("checkbox", { name: "Select all orphans", exact: true }).uncheck();
    await pacman.panel.getByRole("row").filter({ has: pacman.frame.getByRole("button", { name: PACKAGE, exact: true }) })
      .getByRole("checkbox").check();
    await pacman.panel.getByRole("button", { name: "Remove 1 orphan", exact: true }).click();
    const confirm = pacman.frame.getByRole("dialog", { name: "Remove orphan packages?" });
    await confirm.getByRole("button", { name: "Remove 1 orphan", exact: true }).click();
    await waitForBarrier(pacman, "pre");
    const pids = (await state(pacman)).pids;
    await pacman.selectFilter("All");
    await expect(pacman.frame.getByRole("button", { name: "View progress", exact: true })).toBeVisible();
    expect((await state(pacman)).pids).toEqual(pids);
    await pacman.frame.getByRole("button", { name: "View progress", exact: true }).click();
    await expect(pacman.panel.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    expect((await state(pacman)).pids).toEqual(pids);
    await fixture(pacman, "release");
    await expect.poll(async () => (await state(pacman)).pids).toEqual([]);
    expect(await state(pacman)).toMatchObject({ version: null, dependency_version: "1-1", consumer_version: "1-1", post: true, locked: false });
    expect(await guestCommand(pacman.frame, ["pacman", "-Q", "tree"])).toBe(tree);
  });

  test("requires a refreshed install preview after an outside package change", async ({ pacman }) => {
    await fixture(pacman, "setup", "--removal", "--phase", "pre");
    await fixture(pacman, "uninstall-target");
    await fixture(pacman, "publish-conflict");
    await guestCommand(pacman.frame, [BACKEND, "sync-database"]);
    const dialog = await openInstall(pacman);
    await dialog.getByRole("checkbox", { name: `Remove ${PACKAGE}-old`, exact: true }).check();
    const commit = dialog.getByRole("button", { name: `Install ${PACKAGE}`, exact: true });
    await expect(commit).not.toHaveAttribute("aria-disabled", "true");
    await fixture(pacman, "install-extra");
    await expect(commit).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("button", { name: "Refresh preview", exact: true }).click();
    const removal = dialog.getByRole("checkbox", { name: new RegExp(`Remove .*${PACKAGE}-`) });
    await expect(removal).not.toBeChecked();
    await expect(commit).toHaveAttribute("aria-disabled", "true");
    await removal.check();
    await commit.click();
    await waitForBarrier(pacman, "pre");
    await fixture(pacman, "release");
    await expect(dialog).toContainText("Package installed");
    expect(await state(pacman)).toMatchObject({ version: "3-1", victim_version: null, extra_version: null, post: true, locked: false });
  });

  test("refuses an unknown signing key when an install reaches commit", async ({ pacman }) => {
    await fixture(pacman, "setup", "--phase", "pre");
    await fixture(pacman, "uninstall-target");
    await fixture(pacman, "unknown-signer");
    await guestCommand(pacman.frame, [BACKEND, "sync-database"]);
    const before = await state(pacman);
    const dialog = await openInstall(pacman);
    await dialog.getByRole("button", { name: `Install ${PACKAGE}`, exact: true }).click();
    await expect(dialog).toContainText("needs verification");
    await expect(dialog).toContainText(before.signing!.fingerprint.slice(-16));
    expect(await state(pacman)).toMatchObject({ version: null, pre: false, post: false, locked: false,
      signing: { fingerprint: before.signing!.fingerprint, keyring_fingerprints: [] } });
  });

});

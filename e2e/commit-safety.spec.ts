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
});

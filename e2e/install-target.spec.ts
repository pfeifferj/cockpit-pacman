import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";
import type { TransactionPreview } from "../src/bindings";

const FIXTURE = "/usr/local/libexec/cockpit-pacman-e2e/commit-fixture.py";
const PACKAGE = "cockpit-pacman-e2e-commit";
const SECOND_REPO = PACKAGE + "-secondary";

interface InstallState {
  version: string | null;
  payload: string | null;
  pre: boolean;
  scriptlet: boolean;
  post: boolean;
  pids: number[];
  locked: boolean;
}

async function fixture(pacman: PackmanPage, ...args: string[]) {
  return guestCommand(pacman.frame, [FIXTURE, ...args]);
}

async function state(pacman: PackmanPage): Promise<InstallState> {
  return JSON.parse(await fixture(pacman, "state"));
}

async function preview(pacman: PackmanPage, repository: string, version: string, reinstall = false): Promise<TransactionPreview> {
  return JSON.parse(await guestCommand(pacman.frame, [
    BACKEND, "preflight-install", PACKAGE, repository, version, String(reinstall),
  ]));
}

async function commit(pacman: PackmanPage, repository: string, version: string, reinstall = false) {
  const result = await pacman.frame.locator("body").evaluate(async (_body, args) => {
    const cockpit = Reflect.get(globalThis, "cockpit") as {
      spawn(args: string[], options: { superuser: "require"; err: "message" }): Promise<string> & {
        stream(callback: (chunk: string) => void): void;
      };
    };
    const process = cockpit.spawn(args, { superuser: "require", err: "message" });
    let output = "";
    process.stream(chunk => { output += chunk; });
    try {
      await process;
      return { output, error: null };
    } catch (error) {
      return { output, error: String(error) };
    }
  }, [BACKEND, "install-package", PACKAGE, "30", "", repository, version, String(reinstall)]);
  const records: Record<string, unknown>[] = result.output.trim().split("\n").map(line => JSON.parse(line));
  return { records, error: result.error };
}

async function expectUnchanged(pacman: PackmanPage, version: string | null = "1-1") {
  expect(await state(pacman)).toMatchObject({
    version, payload: version, pre: false, scriptlet: false, post: false, pids: [], locked: false,
  });
}

function expectRefused(result: Awaited<ReturnType<typeof commit>>, message: RegExp, code: string | null = "validation_error") {
  expect(result.error).toBeNull();
  expect(result.records).toContainEqual(expect.objectContaining({ message: expect.stringMatching(message) }));
  if (code) expect(result.records).toContainEqual(expect.objectContaining({ code }));
  expect(result.records).not.toContainEqual(expect.objectContaining({ type: "complete", success: true }));
}

test.describe("install target validation", () => {
  test.skip(process.env.COCKPIT_E2E_FIXTURE !== "1", "requires the disposable guest package fixture");

  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
  });

  test.afterEach(async ({ pacman }) => {
    await fixture(pacman, "cleanup");
  });

  test("installs the selected repository's version when another repository has priority", async ({ pacman }) => {
    await fixture(pacman, "setup", "--current-repo");
    await fixture(pacman, "add-repository");
    await fixture(pacman, "uninstall-target");
    await guestCommand(pacman.frame, [BACKEND, "sync-database"]);
    const plan = await preview(pacman, SECOND_REPO, "2-1");
    expect(plan.success).toBe(true);
    expect(plan.add).toEqual([expect.objectContaining({ name: PACKAGE, repo: SECOND_REPO, version: "2-1" })]);
    await expectUnchanged(pacman, null);
    await fixture(pacman, "release");

    const result = await commit(pacman, SECOND_REPO, "2-1");
    expect(result.error).toBeNull();
    expect(result.records).toContainEqual(expect.objectContaining({ type: "complete", success: true }));
    expect(await state(pacman)).toMatchObject({ version: "2-1", payload: "2-1", pre: true, post: true, pids: [], locked: false });
  });

  test("does not fall back when the selected repository is absent", async ({ pacman }) => {
    await fixture(pacman, "setup", "--current-repo");
    const plan = await preview(pacman, SECOND_REPO, "1-1");
    expect(plan.success).toBe(false);
    expect(plan.error).toMatch(/not found in the selected repositories/);
    expectRefused(await commit(pacman, SECOND_REPO, "1-1"), /not found in the selected repositories/, null);
    await expectUnchanged(pacman);
  });

  test("reinstalls only when the selected repository and installed versions match", async ({ pacman }) => {
    await fixture(pacman, "setup", "--current-repo");
    const plan = await preview(pacman, PACKAGE, "1-1", true);
    expect(plan.success).toBe(true);
    expect(plan.add).toEqual([expect.objectContaining({ name: PACKAGE, repo: PACKAGE, version: "1-1", old_version: "1-1" })]);
    await expectUnchanged(pacman);
    await fixture(pacman, "release");

    const result = await commit(pacman, PACKAGE, "1-1", true);
    expect(result.error).toBeNull();
    expect(result.records).toContainEqual(expect.objectContaining({ type: "complete", success: true }));
    expect(await state(pacman)).toMatchObject({ version: "1-1", payload: "1-1", pre: true, post: true, pids: [], locked: false });
  });

  for (const missing of ["repository", "version"] as const) {
    test(`refuses a reinstall without its expected ${missing}`, async ({ pacman }) => {
      await fixture(pacman, "setup", "--current-repo");
      const repository = missing === "repository" ? "" : PACKAGE;
      const version = missing === "version" ? "" : "1-1";
      const plan = await preview(pacman, repository, version, true);
      expect(plan.success).toBe(false);
      expect(plan.error).toMatch(/Reinstall requires/);
      expectRefused(await commit(pacman, repository, version, true), /Reinstall requires/);
      await expectUnchanged(pacman);
    });
  }

  for (const version of ["1-1", "2-1"]) {
    test(`refuses reinstalling ${version} when the repository and installed versions differ`, async ({ pacman }) => {
      await fixture(pacman, "setup");
      const plan = await preview(pacman, PACKAGE, version, true);
      expect(plan.success).toBe(false);
      expect(plan.error).toMatch(/version.*changed/i);
      expectRefused(await commit(pacman, PACKAGE, version, true), /version.*changed/i);
      await expectUnchanged(pacman);
    });
  }

  test("rejects repository version drift after an install preview before running hooks", async ({ pacman }) => {
    await fixture(pacman, "setup", "--current-repo");
    await fixture(pacman, "uninstall-target");
    expect((await preview(pacman, PACKAGE, "1-1")).success).toBe(true);
    await fixture(pacman, "publish-update");
    await guestCommand(pacman.frame, [BACKEND, "sync-database"]);

    expectRefused(await commit(pacman, PACKAGE, "1-1"), /version.*changed/i);
    await expectUnchanged(pacman, null);
  });

  test("rejects installed version drift after a reinstall preview before running hooks", async ({ pacman }) => {
    await fixture(pacman, "setup", "--current-repo");
    expect((await preview(pacman, PACKAGE, "1-1", true)).success).toBe(true);
    await fixture(pacman, "install-update");
    await expectUnchanged(pacman, "2-1");

    expectRefused(await commit(pacman, PACKAGE, "1-1", true), /version.*changed/i);
    await expectUnchanged(pacman, "2-1");
  });

  test("does not overwrite a package installed after its install preview", async ({ pacman }) => {
    await fixture(pacman, "setup", "--current-repo");
    await fixture(pacman, "uninstall-target");
    expect((await preview(pacman, PACKAGE, "1-1")).success).toBe(true);
    await fixture(pacman, "install-update");
    await expectUnchanged(pacman, "2-1");

    const result = await commit(pacman, PACKAGE, "1-1");
    expectRefused(result, /already installed/);
    await expectUnchanged(pacman, "2-1");
  });

  test("carries the repository selected in Search through its install preview and commit", async ({ pacman }) => {
    await fixture(pacman, "setup", "--current-repo", "--phase", "pre");
    await fixture(pacman, "add-repository");
    await fixture(pacman, "uninstall-target");
    await guestCommand(pacman.frame, [BACKEND, "sync-database"]);
    await pacman.switchTab("Search packages");
    await pacman.panel.getByRole("textbox", { name: "Search Arch repositories" }).fill(PACKAGE);
    const row = pacman.panel.locator("tbody tr").filter({
      has: pacman.frame.locator('td[data-label="Repository"]').filter({ hasText: new RegExp(`^${SECOND_REPO}$`) }),
    });
    await row.getByRole("button", { name: PACKAGE, exact: true }).click();
    const details = pacman.panel.locator(`[data-details-for="${PACKAGE}"]`);
    await details.getByRole("button", { name: `Install ${PACKAGE}`, exact: true }).click();
    const dialog = pacman.frame.getByRole("dialog", { name: `Install ${PACKAGE}`, exact: true });
    await expect(dialog.getByRole("grid", { name: "Will be installed", exact: true })).toContainText("2-1");
    await dialog.getByRole("button", { name: `Install ${PACKAGE}`, exact: true }).click();
    await expect.poll(async () => (await state(pacman)).pre).toBe(true);
    expect(await state(pacman)).toMatchObject({ version: null, post: false, locked: true });
    await fixture(pacman, "release");
    await expect(dialog).toContainText("Package installed");
    expect(await state(pacman)).toMatchObject({ version: "2-1", payload: "2-1", post: true, pids: [], locked: false });
  });
});

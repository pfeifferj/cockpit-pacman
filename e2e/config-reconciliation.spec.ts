import { Buffer } from "node:buffer";
import type { Locator } from "@playwright/test";
import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";

const FIXTURE = "/usr/local/libexec/cockpit-pacman-e2e/reconciliation-fixture.py";
const MERGED = "# reviewed configuration\nmode = merged\nkeep = yes\n";
const XATTR = "user.cockpit-pacman-e2e";

type ConfigurationFixture = {
  path: string;
  current_path: string;
  kind: "pacnew" | "pacsave";
  current_content: string | null;
  pending_content: string;
};

type SavedFile = {
  path: string;
  content: string;
  bytes: string;
  mode: number;
  uid: number;
  gid: number;
  xattrs: Record<string, string>;
  symlink?: string;
};

type FixtureState = {
  current: SavedFile | null;
  pending: SavedFile | null;
  backups: SavedFile[];
  temporary: SavedFile[];
  outside: SavedFile | null;
};

type Preview = ConfigurationFixture & { revision: string };
type Failure = { status: number; response: { code: string; message: string; details?: string } };

async function fixtureCommand<T>(pacman: PackmanPage, ...args: string[]): Promise<T> {
  return JSON.parse(await guestCommand(pacman.frame, [FIXTURE, ...args]));
}

async function withFixture(
  pacman: PackmanPage,
  scenario: "pacnew" | "pacsave-missing" | "symlink",
  run: (fixture: ConfigurationFixture) => Promise<void>,
) {
  await pacman.navigateToPlugin("/updates");
  await guestCommand(pacman.frame, [FIXTURE, "cleanup"]);
  const fixture = await fixtureCommand<ConfigurationFixture>(pacman, "setup", "--scenario", scenario);
  try {
    await run(fixture);
  } finally {
    if (!pacman.page.isClosed()) await guestCommand(pacman.frame, [FIXTURE, "cleanup"]);
  }
}

async function openReview(pacman: PackmanPage, fixture: ConfigurationFixture): Promise<Locator> {
  await pacman.navigateToPlugin("/updates");
  await pacman.panel.getByRole("button", { name: "Review configuration files", exact: true }).click();
  const dialog = pacman.frame.getByRole("dialog", { name: "Review configuration files", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Configuration file", { exact: true }).selectOption(fixture.path);
  await expect(dialog.getByRole("button", {
    name: fixture.kind === "pacsave" ? "Restore saved version" : "Use new version", exact: true,
  })).toBeEnabled();
  return dialog;
}

function expectBackup(state: FixtureState, content: string, xattr: string) {
  const backup = state.backups.find(file => file.bytes === Buffer.from(content).toString("base64"));
  expect(backup, "the replaced file has an exact backup").toBeDefined();
  expect(backup).toMatchObject({ mode: 0o600, uid: 0, gid: 0 });
  expect(backup!.xattrs[XATTR]).toBe(xattr);
}

async function failedRequest(pacman: PackmanPage, args: string[], input = "", administrative = true): Promise<Failure> {
  return JSON.parse(await guestCommand(pacman.frame, ["python3", "-c", `
import json, subprocess, sys
process = subprocess.run(sys.argv[2:], input=sys.argv[1], capture_output=True, text=True, timeout=20)
print(json.dumps({'status': process.returncode, 'response': json.loads(process.stdout)}))
`, input, BACKEND, ...args], administrative));
}

function expectRejection(failure: Failure, code: string) {
  expect(failure).toMatchObject({ status: 0, response: { code, message: expect.any(String) } });
  expect(failure.response.message).not.toBe("");
}

test.describe("configuration reconciliation", () => {
  test.skip(process.env.COCKPIT_FAULT_TESTS !== "1", "requires the disposable Arch guest");

  for (const resolution of ["keep_current", "use_pending", "save_merged"] as const) {
    test(`${resolution} resolves a pacnew and preserves recoverable file metadata`, async ({ pacman }) => {
      await withFixture(pacman, "pacnew", async fixture => {
        const dialog = await openReview(pacman, fixture);
        if (resolution === "save_merged") {
          await dialog.getByRole("button", { name: "Edit merged result", exact: true }).click();
          await dialog.getByRole("textbox", { name: "Merged configuration", exact: true }).fill(MERGED);
          await dialog.getByRole("button", { name: "Save merge", exact: true }).click();
        } else {
          await dialog.getByRole("button", {
            name: resolution === "keep_current" ? "Keep current" : "Use new version", exact: true,
          }).click();
        }
        const expected = resolution === "keep_current" ? fixture.current_content!
          : resolution === "use_pending" ? fixture.pending_content : MERGED;
        await expect.poll(async () => (await fixtureCommand<FixtureState>(pacman, "state")).pending).toBeNull();
        const state = await fixtureCommand<FixtureState>(pacman, "state");
        expect(state.current).toMatchObject({
          content: expected, bytes: Buffer.from(expected).toString("base64"), mode: 0o600, uid: 0, gid: 0,
        });
        expect(state.current!.xattrs[XATTR]).toBe(resolution === "use_pending" ? "pending" : "current");
        expect(state.temporary).toEqual([]);
        expectBackup(state, fixture.pending_content, "pending");
        if (resolution !== "keep_current") expectBackup(state, fixture.current_content!, "current");
      });
    });
  }

  test("restores a pacsave whose package and current file are absent", async ({ pacman }) => {
    await withFixture(pacman, "pacsave-missing", async fixture => {
      const preview: Preview = JSON.parse(
        await guestCommand(pacman.frame, [BACKEND, "preview-pacnew", fixture.path]),
      );
      expect(preview.current_content).toBeNull();
      const dialog = await openReview(pacman, fixture);
      await dialog.getByRole("button", { name: "Restore saved version", exact: true }).click();
      await expect.poll(async () => (await fixtureCommand<FixtureState>(pacman, "state")).pending).toBeNull();
      const state = await fixtureCommand<FixtureState>(pacman, "state");
      expect(state.current).toMatchObject({ content: fixture.pending_content, mode: 0o600, uid: 0, gid: 0 });
      expect(state.current!.xattrs[XATTR]).toBe("pending");
      expectBackup(state, fixture.pending_content, "pending");
    });
  });

  test("keeps a merge draft when an external edit requires reloading", async ({ pacman }) => {
    await withFixture(pacman, "pacnew", async fixture => {
      const dialog = await openReview(pacman, fixture);
      await dialog.getByRole("button", { name: "Edit merged result", exact: true }).click();
      const editor = dialog.getByRole("textbox", { name: "Merged configuration", exact: true });
      await editor.fill(MERGED);
      await guestCommand(pacman.frame, [FIXTURE, "external-change"]);
      const external = await fixtureCommand<FixtureState>(pacman, "state");
      await dialog.getByRole("button", { name: "Save merge", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: /The configuration changed/ })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Save merge", exact: true })).toBeDisabled();
      await expect(editor).toHaveValue(MERGED);
      expect(await fixtureCommand<FixtureState>(pacman, "state")).toEqual(external);
      await dialog.getByRole("button", { name: "Reload files", exact: true }).click();
      await dialog.getByRole("button", { name: "Files", exact: true }).click();
      await expect(dialog).toContainText("mode = external");
      await dialog.getByRole("button", { name: "Keep current", exact: true }).click();
      await dialog.getByRole("button", { name: "Discard edits and keep current", exact: true }).click();
      await expect.poll(async () => (await fixtureCommand<FixtureState>(pacman, "state")).pending).toBeNull();
      expect((await fixtureCommand<FixtureState>(pacman, "state")).current).toEqual(external.current);
    });
  });

  test("keeps file comparisons and the merge editor inside a narrow dialog", async ({ pacman }) => {
    await withFixture(pacman, "pacnew", async fixture => {
      const dialog = await openReview(pacman, fixture);
      await pacman.page.setViewportSize({ width: 360, height: 740 });
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
      for (const view of ["Changes", "Files"]) {
        await dialog.getByRole("button", { name: view, exact: true }).click();
        expect(await pacman.frame.locator("html").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await dialog.getByRole("button", { name: "Edit merged result", exact: true }).click();
      await expect(dialog.getByRole("textbox", { name: "Merged configuration", exact: true })).toBeVisible();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
      await expect(dialog).not.toBeVisible();
    });
  });

  test("refuses traversal, unprivileged reads and writes, and an active pacman lock", async ({ pacman }) => {
    await withFixture(pacman, "pacnew", async fixture => {
      const before = await fixtureCommand<FixtureState>(pacman, "state");
      const preview: Preview = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "preview-pacnew", fixture.path]));
      const request = JSON.stringify({ path: fixture.path, revision: preview.revision, resolution: "use_pending" });
      const attempts = [
        await failedRequest(pacman, ["preview-pacnew", `/etc/../etc/${fixture.path.split("/").pop()}`]),
        await failedRequest(pacman, ["preview-pacnew", fixture.path], "", false),
        await failedRequest(pacman, ["resolve-pacnew"], request, false),
        await fixtureCommand<Failure>(pacman, "locked-resolve", "--request", request),
      ];
      const codes = ["validation_error", "permission_denied", "permission_denied", "database_locked"];
      attempts.forEach((failure, index) => expectRejection(failure, codes[index]));
      expect(await fixtureCommand<FixtureState>(pacman, "state")).toEqual(before);

      await guestCommand(pacman.frame, ["chown", "dev:dev", fixture.current_path]);
      const untrusted = await fixtureCommand<FixtureState>(pacman, "state");
      expect(untrusted.current!.uid).not.toBe(0);
      const rejected = await failedRequest(pacman, ["resolve-pacnew"], request);
      expectRejection(rejected, "validation_error");
      expect(await fixtureCommand<FixtureState>(pacman, "state")).toEqual(untrusted);
    });
  });

  test("refuses symlinked pending files without reading or replacing the target", async ({ pacman }) => {
    await withFixture(pacman, "symlink", async fixture => {
      const before = await fixtureCommand<FixtureState>(pacman, "state");
      const failure = await failedRequest(pacman, ["preview-pacnew", fixture.path]);
      expectRejection(failure, "validation_error");
      const status: { files: { path: string }[] } = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "pacnew-status"]));
      expect(status.files.some(file => file.path === fixture.path)).toBe(false);
      expect(await fixtureCommand<FixtureState>(pacman, "state")).toEqual(before);
    });
  });
});

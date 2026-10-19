import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSpawn } from "./test/setup";
import { createMockSpawnPromise } from "./test/mocks";
import {
  checkOutsideRun, dismissOutsideRun, getActiveTransaction, getGroupedHistory, getOutsideRun,
  installPackage, lsignKey, normalizeFingerprint, onOutsideRun, previewCacheCleanup,
  rebootDismissal, receiveKey, RECEIVE_KEY_TIMEOUT_MS, saveMirrorlist, saveRepos,
  undoMirrorSave, undoRepoSave,
} from "./api";

const FINGERPRINT = "3B94A80E50A477C7C8E44F8A0FA8E1BCB1F1A2C0";
const key = { fingerprint: FINGERPRINT, uid: "Test key", created: null, expires: null, trust: "unknown" };

function pendingProcess() {
  let finish!: (output: string) => void;
  const process = Object.assign(new Promise<string>(resolve => { finish = resolve; }), {
    input: vi.fn(), close: vi.fn(),
  });
  mockSpawn.mockReturnValue(process);
  return { process, finish };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawn.mockReturnValue(createMockSpawnPromise("{}"));
});
afterEach(() => vi.useRealTimers());

it("preserves revisions for save and Undo, including an explicit overwrite", async () => {
  await saveRepos([], "repo-revision");
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["save-repos", "[]", "repo-revision"]);
  await saveMirrorlist([], "mirror-revision");
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["save-mirrorlist", "[]", "mirror-revision"]);
  await undoRepoSave(123, "saved-repo");
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["undo-repo-save", "123", "saved-repo"]);
  await undoMirrorSave(456, "saved-mirror");
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["undo-mirror-save", "456", "saved-mirror"]);
});

it("guards dismissal Undo with the signature it replaces", async () => {
  await rebootDismissal.restore("previous", "current");
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["restore-dismissed", "reboot", "current", "previous"]);
  await rebootDismissal.restore(null, "current");
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["restore-dismissed", "reboot", "current"]);
});

it("uses the same full cache selection for estimates as cleanup", async () => {
  await previewCacheCleanup(2, { mode: "except", names: ["linux", "bash"] });
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["cache-cleanup-preview", "2", "linux,bash", "except"]);
  await previewCacheCleanup(1, { mode: "only", names: ["linux"] });
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["cache-cleanup-preview", "1", "linux", "only"]);
});

it("passes history date bounds and aborts superseded reads", async () => {
  const { process, finish } = pendingProcess();
  const controller = new AbortController();
  const result = getGroupedHistory({ until: "2026-10-01", filter: "downgraded", signal: controller.signal });
  expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["history-grouped", "0", "20", "downgraded", "", "2026-10-01"]);
  controller.abort();
  expect(process.close).toHaveBeenCalledWith("cancelled");
  finish("{}");
  await result;
});

describe("key actions", () => {
  it("requires a full fingerprint", () => {
    expect(normalizeFingerprint(`0x${FINGERPRINT.toLowerCase()}`)).toBe(FINGERPRINT);
    expect(normalizeFingerprint("3B94 A80E 50A4 77C7 C8E4 4F8A 0FA8 E1BC B1F1 A2C0")).toBe(FINGERPRINT);
    expect(normalizeFingerprint(FINGERPRINT.slice(-16))).toBeNull();
  });

  it("keeps all mutations blocked until a cancelled import exits", async () => {
    const { process, finish } = pendingProcess();
    const controller = new AbortController();
    const result = receiveKey(FINGERPRINT, "hkps://keys.example.org", controller.signal);
    expect(getActiveTransaction()?.command).toBe("receive-key");
    controller.abort();
    expect(process.input).toHaveBeenCalledWith("cancel\n", true);
    expect(process.close).not.toHaveBeenCalled();
    expect(getActiveTransaction()?.command).toBe("receive-key");
    await expect(lsignKey(FINGERPRINT)).rejects.toMatchObject({ code: "database_locked" });
    const onError = vi.fn();
    installPackage({ onComplete: vi.fn(), onError }, "vim");
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.any(String), "database_locked");
    finish(JSON.stringify({ code: "cancelled", message: "Cancelled" }));
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(getActiveTransaction()).toBeNull();
  });

  it("requests timeout cancellation without releasing ownership early", async () => {
    vi.useFakeTimers();
    const { process, finish } = pendingProcess();
    const result = receiveKey(FINGERPRINT);
    await vi.advanceTimersByTimeAsync(RECEIVE_KEY_TIMEOUT_MS);
    expect(process.input).toHaveBeenCalledWith("cancel\n", true);
    expect(process.close).not.toHaveBeenCalled();
    expect(getActiveTransaction()?.command).toBe("receive-key");
    finish(JSON.stringify({ code: "timeout", message: "Keyserver timed out" }));
    await expect(result).rejects.toMatchObject({ code: "timeout" });
    expect(getActiveTransaction()).toBeNull();
  });

  it("fetches and locally signs as separate privileged operations", async () => {
    mockSpawn.mockReturnValue(createMockSpawnPromise(JSON.stringify({ key })));
    expect(await receiveKey(FINGERPRINT)).toEqual({ key });
    expect(mockSpawn.mock.lastCall?.[1]).toEqual({ err: "message", superuser: "require" });
    expect(await lsignKey(FINGERPRINT)).toEqual({ key });
    expect(mockSpawn.mock.lastCall?.[0].slice(1)).toEqual(["lsign-key", FINGERPRINT]);
  });
});

it("counts bounded history parts as one external transaction and reports truncated totals", async () => {
  let groups: Record<string, unknown>[] = [];
  let total = 0;
  mockSpawn.mockImplementation((args: string[]) => createMockSpawnPromise(JSON.stringify(args[1] === "check-lock"
    ? { locked: false, stale: false }
    : { groups, total_groups: total })));
  dismissOutsideRun();
  const unsubscribe = onOutsideRun(vi.fn());
  try {
    await checkOutsideRun(false);
    const part = (index: number) => ({
      id: `group-0-${index}`, start_time: "2026-10-17T12:00:00+0000", end_time: "2026-10-17T12:01:00+0000",
      command: "pacman -Syu", origin: "pacman", entries: [], part: index, parts: 2,
      upgraded_count: index === 1 ? 100 : 20, installed_count: 0, removed_count: 0,
      downgraded_count: 0, reinstalled_count: 0,
    });
    groups = [part(1), part(2)]; total = 3;
    await checkOutsideRun();
    expect(getOutsideRun()).toMatchObject({ runs: 1, counts: { upgraded: 120 }, partial: true });
    await checkOutsideRun();
    expect(getOutsideRun()?.counts.upgraded).toBe(120);
  } finally { unsubscribe(); dismissOutsideRun(); }
});

it("observes separate transactions logged in the same second", async () => {
  const group = (index: number) => ({
    id: `group-${index}-0`, start_time: "2026-10-17T12:00:00+0000", end_time: "2026-10-17T12:00:00+0000",
    command: "pacman -Syu", origin: "cockpit", entries: [], upgraded_count: 1,
    installed_count: 0, removed_count: 0, downgraded_count: 0, reinstalled_count: 0,
  });
  let groups = [group(0)];
  mockSpawn.mockImplementation((args: string[]) => createMockSpawnPromise(JSON.stringify(args[1] === "check-lock"
    ? { locked: false, stale: false }
    : { groups, total_groups: groups.length })));
  const unsubscribe = onOutsideRun(vi.fn());
  try {
    await checkOutsideRun(false);
    groups = [group(1), ...groups];
    await checkOutsideRun();
    expect(getOutsideRun()).toMatchObject({ runs: 1, counts: { upgraded: 1 }, partial: false });
    groups = [group(2), ...groups];
    await checkOutsideRun();
    expect(getOutsideRun()).toMatchObject({ runs: 2, counts: { upgraded: 2 } });
    await checkOutsideRun();
    expect(getOutsideRun()?.runs).toBe(2);
  } finally { unsubscribe(); dismissOutsideRun(); }
});

it("checks activity hidden by an in-flight key action after the process exits", async () => {
  const { process, finish } = pendingProcess();
  let groups: Record<string, unknown>[] = [];
  mockSpawn.mockImplementation((args: string[]) => args[1] === "receive-key" ? process :
    createMockSpawnPromise(JSON.stringify(args[1] === "check-lock"
      ? { locked: false, stale: false } : { groups, total_groups: groups.length })));
  const unsubscribe = onOutsideRun(vi.fn());
  try {
    await checkOutsideRun(false);
    const result = receiveKey(FINGERPRINT);
    groups = [{
      id: "group-10-0", start_time: new Date().toISOString(), end_time: new Date().toISOString(),
      command: "pacman -Syu", origin: "cockpit", entries: [], upgraded_count: 4,
      installed_count: 0, removed_count: 0, downgraded_count: 0, reinstalled_count: 0,
    }];
    finish(JSON.stringify({ key }));
    await result;
    await vi.waitFor(() => expect(getOutsideRun()).toMatchObject({ runs: 1, counts: { upgraded: 4 } }));
  } finally { unsubscribe(); dismissOutsideRun(); }
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useMutationGate,
  transactionOwner,
  transactionLabel,
  useActiveTransaction,
  useExternalLockWatch,
  EXTERNAL_LOCK_POLL_MS,
} from "./useMutationGate";
import {
  runUpgrade,
  cleanCache,
  installPackage,
  syncDatabase,
  previewInstall,
  getActiveTransaction,
  refreshExternalLockHolder,
} from "../api";
import { mockSpawn } from "../test/setup";
import { createMockSpawnPromise, createMockStreamingProcess } from "../test/mocks";

type StreamingMockProcess = ReturnType<typeof createMockStreamingProcess>;

const noop = { onComplete: vi.fn(), onError: vi.fn() };

function startProc(): StreamingMockProcess {
  const proc = createMockStreamingProcess();
  mockSpawn.mockReturnValueOnce(proc);
  return proc;
}

describe("useMutationGate", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("orders reasons: access check, then access off, then a running transaction", () => {
    const proc = startProc();
    act(() => { runUpgrade(noop); });

    const pending = renderHook(() => useMutationGate("clean the cache", { permission: null }));
    expect(pending.result.current).toEqual({ blocked: true, reason: "Checking administrative access…" });

    const denied = renderHook(() => useMutationGate("clean the cache", { permission: false }));
    expect(denied.result.current).toEqual({
      blocked: true,
      reason: "Turn on administrative access to clean the cache",
    });

    const busy = renderHook(() => useMutationGate("clean the cache", { permission: true }));
    expect(busy.result.current).toEqual({
      blocked: true,
      reason: "An upgrade is running.",
    });

    act(() => {
      proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n"); proc._complete();
    });
    expect(busy.result.current).toEqual({ blocked: false });
  });

  it("clears on completion, error and cancel", () => {
    const { result } = renderHook(() => useMutationGate("x", { permission: true }));
    expect(result.current.blocked).toBe(false);

    const ok = startProc();
    act(() => { cleanCache(noop, 2); });
    expect(result.current.blocked).toBe(true);
    act(() => { ok._emit(JSON.stringify({ type: "complete", success: true }) + "\n"); ok._complete(); });
    expect(result.current.blocked).toBe(false);

    const failing = startProc();
    act(() => { cleanCache(noop, 2); });
    expect(result.current.blocked).toBe(true);
    act(() => { failing._emit(JSON.stringify({ code: "database_locked", message: "locked" }) + "\n"); failing._complete(); });
    expect(result.current.blocked).toBe(false);

    const cancelled = startProc();
    let handle: ReturnType<typeof installPackage> | undefined;
    act(() => { handle = installPackage(noop, "vim"); });
    expect(result.current.reason).toBe("Installing vim is running.");
    act(() => {
      handle!.forceStop();
      cancelled._fail({ problem: "cancelled" });
    });
    expect(result.current.blocked).toBe(false);
    expect(getActiveTransaction()).toBeNull();
  });

  it("lets the owner view through its own command", () => {
    const proc = startProc();
    act(() => { syncDatabase(noop); });

    const owner = renderHook(() => useMutationGate("apply updates", { permission: true, owner: "updates" }));
    expect(owner.result.current.blocked).toBe(false);

    const other = renderHook(() => useMutationGate("refresh keys", { permission: true, owner: "keyring" }));
    expect(other.result.current.reason).toBe("A database sync is running.");

    act(() => { proc._complete(); });
    expect(other.result.current.blocked).toBe(false);
  });

  it("does not register previews", async () => {
    mockSpawn.mockReturnValueOnce(Promise.resolve(JSON.stringify({ packages: [] })));
    const { result } = renderHook(() => useMutationGate("x", { permission: true }));
    await act(async () => {
      await previewInstall("vim").catch(() => undefined);
    });
    expect(result.current.blocked).toBe(false);
  });
});

describe("transaction owner and label", () => {
  it("maps commands to the view showing their progress", () => {
    expect(transactionOwner("upgrade")).toBe("updates");
    expect(transactionOwner("sync-database")).toBe("updates");
    expect(transactionOwner("clean-cache")).toBe("cache");
    expect(transactionOwner("init-keyring")).toBe("keyring");
    expect(transactionOwner("remove-orphans")).toBe("orphans");
    expect(transactionOwner("install-package")).toBeUndefined();
  });

  it("names an outside lock holder by its process", () => {
    expect(transactionLabel({ command: "external", target: "pacman (pid 42)", startedAt: 0 })).toBe("pacman (pid 42)");
    expect(transactionLabel({ command: "external", startedAt: 0 })).toBe("Another program");
  });

  it("names the target for single-package commands", () => {
    expect(transactionLabel({ command: "downgrade-archive", target: "glibc", startedAt: 0 })).toBe("Downgrading glibc");
    expect(transactionLabel({ command: "remove-package", target: "vim", startedAt: 0 })).toBe("Removing vim");
  });
});

const lockedBy = (process: string | undefined) =>
  createMockSpawnPromise(JSON.stringify({
    locked: process !== undefined, stale: false, lock_path: "/var/lib/pacman/db.lck", holder_unknown: false,
    ...(process ? { blocking_process: process } : {}),
  }));

const checkLockCalls = () => mockSpawn.mock.calls.filter(([argv]) => (argv as string[])[1] === "check-lock").length;

describe("external lock holders", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(async () => {
    mockSpawn.mockReturnValue(lockedBy(undefined));
    await refreshExternalLockHolder();
    mockSpawn.mockReset();
  });

  it("blocks every gate with the holding process", async () => {
    mockSpawn.mockReturnValueOnce(lockedBy("pacman (pid 42)"));
    await act(async () => {
      await refreshExternalLockHolder();
    });
    const gate = renderHook(() => useMutationGate("apply updates", { permission: true, owner: "updates" }));
    expect(gate.result.current).toEqual({ blocked: true, reason: "pacman (pid 42) is running." });
  });

  it("keeps the same entry across progress updates", () => {
    vi.useFakeTimers();
    try {
      const proc = startProc();
      act(() => { runUpgrade(noop); });
      const { result } = renderHook(() => useActiveTransaction());
      const first = result.current;
      act(() => {
        proc._emit(JSON.stringify({ type: "progress", operation: "upgrade_start", package: "a", percent: 50, current: 1, total: 2 }) + "\n");
        vi.advanceTimersByTime(300);
      });
      expect(getActiveTransaction()?.percent).toBeDefined();
      expect(result.current).toBe(first);
      act(() => { proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n"); proc._complete(); });
      expect(result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks on mount, on activation and every 15 s while visible, and stops while hidden", async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const add = vi.spyOn(cockpit, "addEventListener").mockImplementation((event, handler) => {
      if (event === "visibilitychange") listeners.add(handler);
    });
    const remove = vi.spyOn(cockpit, "removeEventListener").mockImplementation((event, handler) => {
      if (event === "visibilitychange") listeners.delete(handler);
    });
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(cockpit, "hidden", { value: hidden, configurable: true, writable: true });
      act(() => { for (const listener of [...listeners]) listener(); });
    };
    try {
      mockSpawn.mockImplementation(() => lockedBy(undefined));
      const { rerender, unmount } = renderHook(({ tab }) => useExternalLockWatch(tab), { initialProps: { tab: 0 } });
      expect(checkLockCalls()).toBe(1);

      await act(async () => { vi.advanceTimersByTime(EXTERNAL_LOCK_POLL_MS); });
      expect(checkLockCalls()).toBe(2);

      rerender({ tab: 4 });
      expect(checkLockCalls()).toBe(3);

      setHidden(true);
      await act(async () => { vi.advanceTimersByTime(EXTERNAL_LOCK_POLL_MS * 3); });
      expect(checkLockCalls()).toBe(3);

      setHidden(false);
      expect(checkLockCalls()).toBe(4);
      unmount();
    } finally {
      add.mockRestore();
      remove.mockRestore();
      delete (cockpit as { hidden?: boolean }).hidden;
      vi.useRealTimers();
    }
  });
});

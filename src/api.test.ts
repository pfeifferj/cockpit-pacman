import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockSpawn } from "./test/setup";
import {
  mockPackageListResponse,
  mockUpdatesResponse,
  mockPackageDetails,
  mockSearchResponse,
  mockDependencyTreeResponse,
  createMockSpawnPromise,
  createMockStreamingProcess,
} from "./test/mocks";
import { STREAM_FIRST_OUTPUT_TIMEOUT_MS } from "./constants";
import { getActiveTransaction, previewDowngradeArchive, installPackage, getSignoffList, signoffPackage, signoffPackages, revokeSignoff } from "./api";
import {
  formatSize,
  listInstalled,
  checkUpdates,
  getPackageInfo,
  getDependencyTree,
  searchPackages,
  runUpgrade,
  syncDatabase,
  listArchiveVersions,
  downgradeFromArchive,
  servicesDismissal,
  rebootDismissal,
  pacnewDismissal,
  scheduledDismissal,
  StreamEvent,
  BackendError,
  isNetworkErrorCode,
  listMirrorBackups,
  testMirrors,
  refreshMirrors,
  getPacnewStatus,
  previewPacnew,
  resolvePacnew,
  refreshExternalLockHolder,
} from "./api";

it("requires administrative access to preview configuration contents", async () => {
  mockSpawn.mockReturnValue(createMockSpawnPromise("{}"));
  await previewPacnew("/etc/example.conf.pacnew");
  expect(mockSpawn).toHaveBeenLastCalledWith(
    ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "preview-pacnew", "/etc/example.conf.pacnew"],
    { superuser: "require", err: "message" },
  );
});

it("sends merged configuration over stdin without exposing contents in arguments", async () => {
  const process = createMockSpawnPromise("{}");
  const input = vi.spyOn(process, "input");
  mockSpawn.mockReturnValue(process);
  const request = { path: "/etc/example.conf.pacnew", revision: "pair", resolution: "save_merged" as const, merged_content: "password=secret-ä\n" };
  await resolvePacnew(request);
  expect(mockSpawn).toHaveBeenLastCalledWith(
    ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "resolve-pacnew"],
    { superuser: "require", err: "message" },
  );
  expect(input).toHaveBeenCalledWith(JSON.stringify(request));
});

it("scans pending files with administrative access when the session has it", async () => {
  mockSpawn.mockReturnValue(createMockSpawnPromise('{"has_pacnew":false,"files":[]}'));
  await getPacnewStatus();
  expect(mockSpawn).toHaveBeenLastCalledWith(
    ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "pacnew-status"],
    { superuser: "try", err: "message" },
  );
});

it("can complete the pending-file scan with administrative access", async () => {
  mockSpawn.mockReturnValue(createMockSpawnPromise('{"has_pacnew":false,"files":[]}'));
  await getPacnewStatus(true);
  expect(mockSpawn).toHaveBeenLastCalledWith(
    ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "pacnew-status"],
    { superuser: "require", err: "message" },
  );
});

it("does not report reconciliation's database lock as an outside operation", async () => {
  mockSpawn.mockClear();
  let finish!: (value: string) => void;
  const process = Object.assign(new Promise<string>(resolve => { finish = resolve; }), {
    input: vi.fn(), close: vi.fn(), stream: vi.fn(),
  });
  mockSpawn.mockReturnValue(createMockSpawnPromise('{"locked":false,"stale":false}'));
  mockSpawn.mockReturnValueOnce(process);
  const request = resolvePacnew({ path: "/etc/example.conf.pacnew", revision: "pair", resolution: "keep_current" });
  await refreshExternalLockHolder();
  expect(mockSpawn).toHaveBeenCalledTimes(1);
  finish('{"success":true,"message":"Reviewed","backup_paths":[],"warnings":[]}');
  await request;
});

it("reads protected mirror undo backups with administrative access", async () => {
  mockSpawn.mockClear();
  mockSpawn.mockReturnValue(createMockSpawnPromise(JSON.stringify({ backups: [], warnings: [] })));
  await listMirrorBackups();
  expect(mockSpawn).toHaveBeenCalledExactlyOnceWith(
    ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "list-mirror-backups"],
    { superuser: "require", err: "message" },
  );
});

it("tests and ranks mirrors as the session user", async () => {
  mockSpawn.mockReturnValueOnce(createMockStreamingProcess());
  testMirrors({ onComplete: vi.fn(), onError: vi.fn() });
  expect(mockSpawn).toHaveBeenLastCalledWith(expect.arrayContaining(["test-mirrors"]), { err: "out" });
  mockSpawn.mockReturnValueOnce(createMockSpawnPromise("{}"));
  await refreshMirrors();
  expect(mockSpawn).toHaveBeenLastCalledWith(expect.arrayContaining(["refresh-mirrors"]), { err: "message" });
});

describe.each([
  { kind: "services", api: servicesDismissal },
  { kind: "reboot", api: rebootDismissal },
  { kind: "pacnew", api: pacnewDismissal },
  { kind: "scheduled", api: scheduledDismissal },
])("$kind dismissal", ({ kind, api }) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads its state without requesting privilege", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify({ signature: "previous-alert" }))
    );

    await api.get();

    expect(mockSpawn).toHaveBeenCalledExactlyOnceWith(
      ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "dismissal-state", kind],
      { err: "message" }
    );
  });

  it("passes the kind before the signature without requesting privilege", async () => {
    const signature = "linux:6.19.1-1 linux-lts:6.18.7-1";
    mockSpawn.mockReturnValue(createMockSpawnPromise(JSON.stringify({ signature })));

    await api.mark(signature);

    expect(mockSpawn).toHaveBeenCalledExactlyOnceWith(
      ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "mark-dismissed", kind, signature],
      { err: "message" }
    );
  });
});

describe("getDependencyTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { params: { name: "linux" }, args: ["linux", "3", "forward", "0"] },
    {
      params: { name: "linux", depth: 2, direction: "reverse" as const, optionalDepth: 5 },
      args: ["linux", "2", "reverse", "5"],
    },
  ])("passes dependency options to the backend: $args", async ({ params, args }) => {
    mockSpawn.mockReturnValue(createMockSpawnPromise(JSON.stringify(mockDependencyTreeResponse)));

    const response = await getDependencyTree(params);

    expect(mockSpawn).toHaveBeenCalledWith(
      ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "dependency-tree", ...args],
      { err: "message" }
    );
    expect(response).toEqual(mockDependencyTreeResponse);
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(0)).toBe("0 B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0 KiB");
    expect(formatSize(2048)).toBe("2.0 KiB");
    expect(formatSize(1536)).toBe("1.5 KiB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MiB");
    expect(formatSize(1024 * 1024 * 5.5)).toBe("5.5 MiB");
  });

  it("formats gigabytes", () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.00 GiB");
    expect(formatSize(1024 * 1024 * 1024 * 2.5)).toBe("2.50 GiB");
  });

  it("formats negative sizes correctly", () => {
    expect(formatSize(-500)).toBe("-500 B");
    expect(formatSize(-1536)).toBe("-1.5 KiB");
    expect(formatSize(-1198151)).toBe("-1.1 MiB");
    expect(formatSize(-1024 * 1024 * 1024 * 2.5)).toBe("-2.50 GiB");
  });
});

describe("listInstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches installed packages with default params", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify(mockPackageListResponse))
    );

    const result = await listInstalled();

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "list-installed",
        "0",
        "50",
        "",
        "all",
        "all",
        "",
        "",
      ],
      { err: "message" }
    );
    expect(result.packages).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("passes custom params correctly", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify(mockPackageListResponse))
    );

    await listInstalled({
      offset: 10,
      limit: 25,
      search: "linux",
      filter: "explicit",
      repo: "core",
      sortBy: "name",
      sortDir: "desc",
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "list-installed",
        "10",
        "25",
        "linux",
        "explicit",
        "core",
        "name",
        "desc",
      ],
      { err: "message" }
    );
  });

  it("throws on empty response", async () => {
    mockSpawn.mockReturnValue(createMockSpawnPromise(""));

    await expect(listInstalled()).rejects.toThrow(
      "Backend returned empty response"
    );
  });

  it("throws on invalid JSON", async () => {
    mockSpawn.mockReturnValue(createMockSpawnPromise("not json"));

    await expect(listInstalled()).rejects.toThrow("invalid JSON");
  });

  it("throws on spawn failure", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise("", true, new Error("Permission denied"))
    );

    await expect(listInstalled()).rejects.toThrow("Permission denied");
  });

  it("parses a structured error envelope into a coded BackendError", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(
        JSON.stringify({
          code: "network_error",
          message: "could not resolve host",
          details: "ureq: host not found",
        })
      )
    );

    await expect(listInstalled()).rejects.toMatchObject({
      name: "BackendError",
      code: "network_error",
      message: "could not resolve host",
    });
  });

  it("surfaces an envelope with an unrecognized code as an internal_error", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(
        JSON.stringify({ code: "some_future_code", message: "backend said something" })
      )
    );

    await expect(listInstalled()).rejects.toMatchObject({
      name: "BackendError",
      code: "internal_error",
      message: "backend said something",
    });
  });
});

describe("isNetworkErrorCode", () => {
  it("treats only explicit network errors as connectivity failures", () => {
    expect(isNetworkErrorCode("network_error")).toBe(true);
    expect(isNetworkErrorCode("timeout")).toBe(false);
  });

  it("treats other codes as non-connectivity", () => {
    expect(isNetworkErrorCode("database_locked")).toBe(false);
    expect(isNetworkErrorCode("internal_error")).toBe(false);
    expect(BackendError.name).toBe("BackendError");
  });
});

describe("checkUpdates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches available updates", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify(mockUpdatesResponse))
    );

    const result = await checkUpdates();

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "check-updates",
      ],
      { err: "message" }
    );
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].name).toBe("linux");
  });
});

describe("getPackageInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches package details", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify(mockPackageDetails))
    );

    const result = await getPackageInfo("linux");

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "local-package-info",
        "linux",
      ],
      { err: "message" }
    );
    expect(result.name).toBe("linux");
    expect(result.licenses).toContain("GPL-2.0-only");
  });
});

describe("searchPackages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches packages by query with pagination", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify(mockSearchResponse))
    );

    const result = await searchPackages({ query: "linux", offset: 0, limit: 50 });

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "search",
        "linux",
        "0",
        "50",
        "all",
        "",
        "",
      ],
      { err: "message" }
    );
    expect(result.results).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.results[0].name).toBe("linux");
    expect(result.results[1].name).toBe("linux-lts");
  });
});

describe("runUpgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes only explicitly approved removals in the consent argument", () => {
    mockSpawn.mockReturnValue(createMockStreamingProcess());
    runUpgrade({ onComplete: vi.fn(), onError: vi.fn() }, ["ignored"], ["old-driver", "old-library"]);
    expect(mockSpawn.mock.calls[0][0]).toEqual([
      expect.any(String), "upgrade", "ignored", "", "old-driver,old-library",
    ]);
  });

  it("sends an empty removal approval list by default", () => {
    mockSpawn.mockReturnValue(createMockStreamingProcess());
    runUpgrade({ onComplete: vi.fn(), onError: vi.fn(), timeout: 900 });
    expect(mockSpawn.mock.calls[0][0]).toEqual([
      expect.any(String), "upgrade", "", "900", "",
    ]);
  });

  it("calls onComplete when receiving success complete event", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
    };

    runUpgrade(callbacks);

    const completeEvent: StreamEvent = { type: "complete", success: true };
    mockProc._emit(JSON.stringify(completeEvent) + "\n");

    mockProc._complete();

    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("requests cancellation on a silent mutation and waits for process exit", () => {
    vi.useFakeTimers();
    try {
      const mockProc = createMockStreamingProcess();
      const close = vi.fn();
      mockProc.close = close;
      mockProc.input = vi.fn();
      mockSpawn.mockReturnValue(mockProc);

      const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
      runUpgrade(callbacks);

      vi.advanceTimersByTime(STREAM_FIRST_OUTPUT_TIMEOUT_MS + 1);

      mockProc._complete();

      expect(callbacks.onError).toHaveBeenCalledTimes(1);
      expect(callbacks.onError.mock.calls[0][1]).toBe("timeout");
      expect(close).not.toHaveBeenCalled();
      expect(mockProc.input).toHaveBeenCalledWith("cancel\n", true);
      expect(callbacks.onComplete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out once the stream has produced output", () => {
    vi.useFakeTimers();
    try {
      const mockProc = createMockStreamingProcess();
      mockSpawn.mockReturnValue(mockProc);

      const callbacks = { onComplete: vi.fn(), onError: vi.fn(), onData: vi.fn() };
      runUpgrade(callbacks);

      mockProc._emit(JSON.stringify({ type: "log", level: "info", message: "working" }) + "\n");
      vi.advanceTimersByTime(STREAM_FIRST_OUTPUT_TIMEOUT_MS * 10);

      expect(callbacks.onError).not.toHaveBeenCalled();

      mockProc._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
      mockProc._complete();
      expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onError when receiving failed complete event", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    const completeEvent: StreamEvent = {
      type: "complete",
      success: false,
      message: "Package conflict",
    };
    mockProc._emit(JSON.stringify(completeEvent) + "\n");

    mockProc._complete();

    expect(callbacks.onError).toHaveBeenCalledWith("Package conflict", "internal_error", undefined);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
  });

  it("treats a structured error envelope on stdout as a terminal error with its code", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    // A handler that returns Err makes main.rs print this envelope (no `type`)
    // instead of a complete event.
    mockProc._emit(
      JSON.stringify({ code: "network_error", message: "failed retrieving file" }) + "\n"
    );

    mockProc._complete();

    expect(callbacks.onError).toHaveBeenCalledWith("failed retrieving file", "network_error", undefined);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
  });

  it("carries the envelope's details through to onError", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    mockProc._emit(
      JSON.stringify({
        code: "network_error",
        message: "failed to refresh package databases",
        details: "failed to refresh package databases: could not resolve host mirror.example",
      }) + "\n"
    );

    mockProc._complete();

    expect(callbacks.onError).toHaveBeenCalledWith(
      "failed to refresh package databases",
      "network_error",
      "failed to refresh package databases: could not resolve host mirror.example"
    );
  });

  it("surfaces a streaming envelope with an unrecognized code instead of dropping it", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    mockProc._emit(JSON.stringify({ code: "some_future_code", message: "unexpected" }) + "\n");

    mockProc._complete();

    expect(callbacks.onError).toHaveBeenCalledWith("unexpected", "internal_error", undefined);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
  });

  it("processes log events and calls onEvent", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
      onData: vi.fn(),
    };

    runUpgrade(callbacks);

    const logEvent: StreamEvent = {
      type: "log",
      level: "info",
      message: "Starting upgrade",
    };
    mockProc._emit(JSON.stringify(logEvent) + "\n");

    expect(callbacks.onEvent).toHaveBeenCalledWith(logEvent);
    expect(callbacks.onData).toHaveBeenCalledWith("[info] Starting upgrade\n");
  });

  it("processes progress events", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
      onData: vi.fn(),
    };

    runUpgrade(callbacks);

    const progressEvent: StreamEvent = {
      type: "progress",
      operation: "upgrade_start",
      package: "linux",
      current: 1,
      total: 5,
      percent: 20,
    };
    mockProc._emit(JSON.stringify(progressEvent) + "\n");

    expect(callbacks.onEvent).toHaveBeenCalledWith(progressEvent);
    expect(callbacks.onData).toHaveBeenCalledWith("[upgrade_start] linux 20%\n");
  });

  it("handles buffered incomplete lines", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
    };

    runUpgrade(callbacks);

    const event: StreamEvent = { type: "complete", success: true };
    const json = JSON.stringify(event);

    mockProc._emit(json.substring(0, 10));
    expect(callbacks.onEvent).not.toHaveBeenCalled();

    mockProc._emit(json.substring(10) + "\n");
    mockProc._complete();
    expect(callbacks.onComplete).toHaveBeenCalled();
  });

  it("prevents duplicate complete callbacks", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    const completeEvent: StreamEvent = { type: "complete", success: true };
    mockProc._emit(JSON.stringify(completeEvent) + "\n");
    mockProc._emit(JSON.stringify(completeEvent) + "\n");

    mockProc._complete();

    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
  });

  it("treats malformed JSON as raw output", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
      onData: vi.fn(),
    };

    runUpgrade(callbacks);

    mockProc._emit("not valid json\n");

    expect(callbacks.onData).toHaveBeenCalledWith("not valid json\n");
  });

  it("calls onError when process fails", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    mockProc._fail({ message: "Permission denied" });

    mockProc._complete();

    expect(callbacks.onError).toHaveBeenCalledWith("Permission denied", "permission_denied", undefined);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
  });

  it("passes ignore list as argument", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks, ["linux", "linux-headers"]);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["upgrade", "linux,linux-headers"]),
      expect.any(Object)
    );
  });

  it("cancel sends the stdin control line and keeps the channel open", () => {
    const mockProc = createMockStreamingProcess();
    mockProc.close = vi.fn();
    mockProc.input = vi.fn();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    const { cancel } = runUpgrade(callbacks);
    cancel();

    expect(mockProc.input).toHaveBeenCalledWith("cancel\n", true);
    expect(mockProc.close).not.toHaveBeenCalled();
  });

  it("forceStop closes the channel", () => {
    const mockProc = createMockStreamingProcess();
    mockProc.close = vi.fn();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    const { forceStop } = runUpgrade(callbacks);
    forceStop();

    expect(mockProc.close).toHaveBeenCalledWith("cancelled");
  });

  it("cancels database sync through stdin and waits for the backend", () => {
    const mockProc = createMockStreamingProcess();
    mockProc.close = vi.fn();
    mockProc.input = vi.fn();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
    const { cancel } = syncDatabase(callbacks);
    cancel();

    expect(mockProc.close).not.toHaveBeenCalled();
    expect(mockProc.input).toHaveBeenCalledWith("cancel\n", true);
    mockProc._emit(JSON.stringify({ type: "complete", success: false, code: "cancelled", message: "Operation cancelled" }) + "\n");
    expect(callbacks.onError).not.toHaveBeenCalled();
    mockProc._complete();
    expect(callbacks.onError).toHaveBeenCalledWith("Operation cancelled", "cancelled", undefined);
  });

  it("handles complete event in buffer when process ends", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    const completeEvent: StreamEvent = { type: "complete", success: true };
    mockProc._emit(JSON.stringify(completeEvent));
    mockProc._complete();

    mockProc._complete();

    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("calls onError when process ends without complete event", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    const logEvent: StreamEvent = { type: "log", level: "info", message: "Starting" };
    mockProc._emit(JSON.stringify(logEvent) + "\n");
    mockProc._complete();

    mockProc._complete();

    expect(callbacks.onError).toHaveBeenCalledWith(
      "Backend process ended without sending completion status",
      "internal_error",
      undefined
    );
    expect(callbacks.onComplete).not.toHaveBeenCalled();
  });

  it("works without optional callbacks", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runUpgrade(callbacks);

    const logEvent: StreamEvent = { type: "log", level: "info", message: "test" };
    mockProc._emit(JSON.stringify(logEvent) + "\n");

    const completeEvent: StreamEvent = { type: "complete", success: true };
    mockProc._emit(JSON.stringify(completeEvent) + "\n");

    mockProc._complete();

    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});

describe("syncDatabase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only forces a re-download when asked to", () => {
    const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
    const first = createMockStreamingProcess();
    mockSpawn.mockReturnValue(first);
    syncDatabase(callbacks);
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["sync-database", "false"]),
      expect.any(Object)
    );

    first._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
    first._complete();
    mockSpawn.mockReturnValue(createMockStreamingProcess());
    syncDatabase(callbacks, true);

    expect(mockSpawn).toHaveBeenLastCalledWith(
      expect.arrayContaining(["sync-database", "true"]),
      expect.any(Object)
    );
  });

  it("handles download progress events", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn(),
      onData: vi.fn(),
    };

    syncDatabase(callbacks);

    const downloadEvent: StreamEvent = {
      type: "download",
      filename: "core.db",
      event: "progress",
      downloaded: 50000,
      total: 100000,
    };
    mockProc._emit(JSON.stringify(downloadEvent) + "\n");

    expect(callbacks.onEvent).toHaveBeenCalledWith(downloadEvent);
    expect(callbacks.onData).toHaveBeenCalledWith("Downloading core.db: 50%\n");
  });

  it("handles download completed events", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
      onData: vi.fn(),
    };

    syncDatabase(callbacks);

    const downloadEvent: StreamEvent = {
      type: "download",
      filename: "core.db",
      event: "completed",
    };
    mockProc._emit(JSON.stringify(downloadEvent) + "\n");

    expect(callbacks.onData).toHaveBeenCalledWith("Downloaded core.db\n");
  });
});

describe("listArchiveVersions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the list-archive-versions backend command with the package name", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify({ packages: [], total: 0 }))
    );

    await listArchiveVersions("bash");

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "list-archive-versions",
        "bash",
      ],
      expect.any(Object)
    );
  });

  it("passes the version query as a fourth argument when provided", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify({ packages: [], total: 0 }))
    );

    await listArchiveVersions("bash", "5.1");

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "list-archive-versions",
        "bash",
        "5.1",
      ],
      expect.any(Object)
    );
  });

  it("omits the query argument when blank", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnPromise(JSON.stringify({ packages: [], total: 0 }))
    );

    await listArchiveVersions("bash", "   ");

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "list-archive-versions",
        "bash",
      ],
      expect.any(Object)
    );
  });

  it("parses the DowngradeResponse shape", async () => {
    const response = {
      packages: [
        {
          name: "bash",
          version: "5.1.016-1",
          filename: "bash-5.1.016-1-x86_64.pkg.tar.zst",
          size: 0,
          installed_version: "5.2.015-1",
          is_older: true,
        },
      ],
      total: 1,
    };
    mockSpawn.mockReturnValue(createMockSpawnPromise(JSON.stringify(response)));

    const result = await listArchiveVersions("bash");

    expect(result.total).toBe(1);
    expect(result.packages[0].filename).toBe("bash-5.1.016-1-x86_64.pkg.tar.zst");
    expect(result.packages[0].is_older).toBe(true);
  });
});

describe("downgradeFromArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams the downgrade-archive command with name and filename", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    downgradeFromArchive(callbacks, "bash", "bash-5.1.016-1-x86_64.pkg.tar.zst");

    expect(mockSpawn).toHaveBeenCalledWith(
      [
        "/usr/libexec/cockpit-pacman/cockpit-pacman-backend",
        "downgrade-archive",
        "bash",
        "bash-5.1.016-1-x86_64.pkg.tar.zst",
        "",
        "",
      ],
      { superuser: "require", err: "out" }
    );
  });

  it("calls onComplete on a success event", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
    downgradeFromArchive(callbacks, "bash", "bash-5.1.016-1-x86_64.pkg.tar.zst");

    const completeEvent: StreamEvent = { type: "complete", success: true };
    mockProc._emit(JSON.stringify(completeEvent) + "\n");

    mockProc._complete();

    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});

describe("signoff credentials", () => {
  const credentials = { username: "someone", password: "hunter2" };

  let sentToStdin: string[];

  beforeEach(() => {
    sentToStdin = [];
    const promise = createMockSpawnPromise(JSON.stringify({ groups: [] }));
    promise.input = ((data: string) => {
      sentToStdin.push(data);
    }) as unknown as () => void;
    mockSpawn.mockReturnValue(promise);
  });

  it.each([
    ["signoff-list", () => getSignoffList(credentials)],
    ["signoff-sign", () => signoffPackage("linux", "core", "x86_64", credentials)],
    ["signoff-revoke", () => revokeSignoff("linux", "core", "x86_64", credentials)],
  ])("passes credentials to %s on stdin, never in argv", async (_cmd, call) => {
    await call();

    const [argv] = mockSpawn.mock.calls[0];
    const joined = (argv as string[]).join(" ");
    expect(joined).not.toContain(credentials.password);
    expect(joined).not.toContain(credentials.username);
    expect(joined).not.toContain(btoa(JSON.stringify(credentials)));

    expect(sentToStdin).toHaveLength(1);
    expect(JSON.parse(atob(sentToStdin[0]))).toEqual(credentials);
  });
});


describe("stream settlement", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([true, false])("preserves an explicit Complete code before an envelope with newline=%s", (newline) => {
    const process = createMockStreamingProcess();
    mockSpawn.mockReturnValue(process);
    const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
    runUpgrade(callbacks);
    process._emit(JSON.stringify({ type: "complete", success: false, code: "transaction_failed", message: "disk full" }) + "\n");
    process._emit(JSON.stringify({ code: "internal_error", message: "Failed to commit: disk full", details: "Writing /usr/lib/example: disk full" }) + (newline ? "\n" : ""));
    expect(callbacks.onError).not.toHaveBeenCalled();
    process._complete();
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith("Failed to commit: disk full", "transaction_failed", "Writing /usr/lib/example: disk full");
  });

  it.each([false, true])("reports uncertain completion after connection loss with terminal=%s", (hasTerminal) => {
    const process = createMockStreamingProcess();
    mockSpawn.mockReturnValue(process);
    const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
    runUpgrade(callbacks);
    if (hasTerminal) process._emit(JSON.stringify({ type: "complete", success: true, details: "Package changes were written" }) + "\n");
    process._fail({ problem: "disconnected", message: "Cockpit transport closed" });
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
      "Connection to the backend was lost. The operation may still be finishing; check its state before retrying.",
      "internal_error",
      hasTerminal ? "Package changes were written" : "Cockpit transport closed",
    );
  });

  it.each([true, false])("waits for exit after a Complete event with success=%s", (success) => {
    const process = createMockStreamingProcess();
    mockSpawn.mockReturnValue(process);
    const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
    runUpgrade(callbacks);
    process._emit(JSON.stringify({ type: "complete", success, code: "transaction_failed", message: "disk full", details: "Writing /usr/lib/example" }) + "\n");
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    if (success) {
      process._complete();
      expect(callbacks.onComplete).toHaveBeenCalledOnce();
    } else {
      process._fail({ message: "exited with code 1" });
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith("disk full", "transaction_failed", "Writing /usr/lib/example");
    }
  });

  it("does not accept success followed by an unsuccessful exit", () => {
    const process = createMockStreamingProcess();
    mockSpawn.mockReturnValue(process);
    const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
    runUpgrade(callbacks);
    process._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
    process._fail({ message: "process terminated" });
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledOnce();
  });

  it("waits for exit after an error envelope", () => {
    const process = createMockStreamingProcess();
    mockSpawn.mockReturnValue(process);
    const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
    runUpgrade(callbacks);
    process._emit(JSON.stringify({ code: "cancelled", message: "Cancelled before commit" }) + "\n");
    expect(callbacks.onError).not.toHaveBeenCalled();
    process._fail({ message: "exited with code 1" });
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith("Cancelled before commit", "cancelled", undefined);
  });
});

describe("read cancellation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not spawn an already cancelled search", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(searchPackages({ query: "linux", signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("closes a superseded search and removes its listener", async () => {
    let reject!: (error: Error) => void;
    const process = new Promise<string>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const close = vi.fn(() => reject(new Error("Channel closed")));
    Object.assign(process, { close });
    mockSpawn.mockReturnValue(process);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const result = searchPackages({ query: "linux", signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(close).toHaveBeenCalledExactlyOnceWith("cancelled");
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("UTF-8 signoff credentials", () => {
  it.each(["pásswörd", "密碼", "🔑 password"])("round-trips Unicode credentials (%s)", async (password) => {
    const process = createMockSpawnPromise("{}");
    process.input = vi.fn();
    mockSpawn.mockReturnValue(process);
    const credentials = { username: "josie", password };
    await getSignoffList(credentials);
    const encoded = (vi.mocked(process.input).mock.calls[0] as unknown as [string])[0];
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
    expect(JSON.parse(decoded)).toEqual(credentials);
    expect(mockSpawn.mock.lastCall?.[0]).toEqual(expect.not.arrayContaining([password]));
  });
});


describe("backend installation path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the absolute backend path from the installed manifest", async () => {
    cockpit.manifests = { pacman: { config: { backend: "/home/dev/.local/libexec/cockpit-pacman/backend" } } };
    mockSpawn.mockReturnValue(createMockSpawnPromise(JSON.stringify(mockUpdatesResponse)));
    try {
      await checkUpdates();
      expect(mockSpawn.mock.lastCall?.[0][0]).toBe("/home/dev/.local/libexec/cockpit-pacman/backend");
    } finally {
      delete cockpit.manifests;
    }
  });

  it("ignores a relative backend path", async () => {
    cockpit.manifests = { pacman: { config: { backend: "backend" } } };
    mockSpawn.mockReturnValue(createMockSpawnPromise(JSON.stringify(mockUpdatesResponse)));
    try {
      await checkUpdates();
      expect(mockSpawn.mock.lastCall?.[0][0]).toBe("/usr/libexec/cockpit-pacman/cockpit-pacman-backend");
    } finally {
      delete cockpit.manifests;
    }
  });
});

describe("signoff batch API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends targets together with UTF-8 credentials on stdin", async () => {
    const process = createMockSpawnPromise('{"results":[]}');
    process.input = vi.fn();
    mockSpawn.mockReturnValue(process);
    const targets = [{ pkgbase: "htop", repo: "extra-testing", arch: "x86_64" }];
    await signoffPackages(targets, { username: "fixture", password: "秘密" });
    expect(mockSpawn.mock.lastCall).toEqual([
      ["/usr/libexec/cockpit-pacman/cockpit-pacman-backend", "signoff-batch", JSON.stringify(targets)],
      { err: "message" },
    ]);
    expect(process.input).toHaveBeenCalledOnce();
  });

  it("rejects an oversized batch before spawning", async () => {
    const targets = Array.from({ length: 101 }, (_, index) => ({ pkgbase: `pkg${index}`, repo: "extra-testing", arch: "x86_64" }));
    await expect(signoffPackages(targets, { username: "fixture", password: "secret" })).rejects.toMatchObject({ code: "validation_error" });
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});


describe("transaction ownership", () => {
  it("rejects a competing mutation without replacing the running transaction", async () => {
    const process = createMockStreamingProcess();
    mockSpawn.mockReturnValue(process);
    const running = { onComplete: vi.fn(), onError: vi.fn() };
    const competing = { onComplete: vi.fn(), onError: vi.fn() };
    runUpgrade(running);
    const active = getActiveTransaction();
    mockSpawn.mockClear();
    installPackage(competing, "vim");
    await Promise.resolve();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(competing.onError).toHaveBeenCalledWith("Another package operation is still running.", "database_locked");
    expect(getActiveTransaction()).toBe(active);
    process._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
    expect(getActiveTransaction()).toBe(active);
    expect(running.onComplete).not.toHaveBeenCalled();
    process._complete();
    expect(running.onComplete).toHaveBeenCalledOnce();
    expect(getActiveTransaction()).toBeNull();
  });

  it("terminates an archive preview that exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const process = createMockStreamingProcess();
      process.close = vi.fn(problem => process._fail({ problem }));
      mockSpawn.mockReturnValue(process);
      const pending = previewDowngradeArchive("bash", "bash-1-1-any.pkg.tar.zst");
      const failure = expect(pending).rejects.toMatchObject({ code: "timeout", message: "Archive preview timed out." });
      await vi.advanceTimersByTimeAsync(300_000);
      await failure;
      expect(process.close).toHaveBeenCalledWith("timeout");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

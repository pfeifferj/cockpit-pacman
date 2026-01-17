import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockSpawn } from "./test/setup";
import {
  mockPackageListResponse,
  mockUpdatesResponse,
  mockPackageDetails,
  mockSearchResponse,
  createMockSpawnPromise,
  createMockStreamingProcess,
} from "./test/mocks";
import {
  formatSize,
  formatDate,
  listInstalled,
  checkUpdates,
  getPackageInfo,
  searchPackages,
  runUpgrade,
  syncDatabase,
  StreamEvent,
} from "./api";

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

describe("formatDate", () => {
  it("returns Unknown for null", () => {
    expect(formatDate(null)).toBe("Unknown");
  });

  it("formats unix timestamp", () => {
    const timestamp = 1704067200; // 2024-01-01 00:00:00 UTC
    const result = formatDate(timestamp);
    expect(result).toContain("2024");
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
      { superuser: "try", err: "message" }
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
      { superuser: "try", err: "message" }
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
      { superuser: "try", err: "message" }
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
      { superuser: "try", err: "message" }
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
      { superuser: "try", err: "message" }
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

    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
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

    expect(callbacks.onError).toHaveBeenCalledWith("Package conflict");
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

    expect(callbacks.onError).toHaveBeenCalledWith("Permission denied");
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

  it("returns cancel function", () => {
    const mockProc = createMockStreamingProcess();
    mockProc.close = vi.fn();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    const { cancel } = runUpgrade(callbacks);
    cancel();

    expect(mockProc.close).toHaveBeenCalledWith("cancelled");
  });
});

describe("syncDatabase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns sync-database command with force flag", () => {
    const mockProc = createMockStreamingProcess();
    mockSpawn.mockReturnValue(mockProc);

    const callbacks = {
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    syncDatabase(callbacks);

    expect(mockSpawn).toHaveBeenCalledWith(
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

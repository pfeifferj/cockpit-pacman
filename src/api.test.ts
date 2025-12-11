import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockSpawn } from "./test/setup";
import {
  mockPackageListResponse,
  mockUpdatesResponse,
  mockPackageDetails,
  mockSearchResponse,
  createMockSpawnPromise,
} from "./test/mocks";
import {
  formatSize,
  formatDate,
  listInstalled,
  checkUpdates,
  getPackageInfo,
  searchPackages,
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

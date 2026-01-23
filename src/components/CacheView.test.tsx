import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { CacheView } from "./CacheView";
import * as api from "../api";
import { createMockStreamingProcess } from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getCacheInfo: vi.fn(),
    cleanCache: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
  };
});

const mockGetCacheInfo = vi.mocked(api.getCacheInfo);
const mockCleanCache = vi.mocked(api.cleanCache);
const mockGetPackageInfo = vi.mocked(api.getPackageInfo);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);

const mockCacheInfo: api.CacheInfo = {
  total_size: 5000000000,
  package_count: 150,
  packages: [
    { name: "linux", version: "6.7.0-arch1-1", filename: "linux-6.7.0-arch1-1-x86_64.pkg.tar.zst", size: 150000000 },
    { name: "linux", version: "6.6.0-arch1-1", filename: "linux-6.6.0-arch1-1-x86_64.pkg.tar.zst", size: 148000000 },
    { name: "glibc", version: "2.39-1", filename: "glibc-2.39-1-x86_64.pkg.tar.zst", size: 45000000 },
  ],
  path: "/var/cache/pacman/pkg",
};

const mockPackageDetails: api.PackageDetails = {
  name: "linux",
  version: "6.7.0-arch1-1",
  description: "The Linux kernel and modules",
  url: "https://kernel.org/",
  licenses: ["GPL-2.0-only"],
  groups: [],
  provides: [],
  depends: ["coreutils"],
  optdepends: [],
  conflicts: [],
  replaces: [],
  installed_size: 150000000,
  packager: "heftig",
  architecture: "x86_64",
  build_date: 1704067200,
  install_date: 1704067200,
  reason: "explicit",
  validation: ["pgp"],
  repository: "core",
};

describe("CacheView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCacheInfo.mockResolvedValue(mockCacheInfo);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders loading spinner initially", async () => {
    mockGetCacheInfo.mockImplementation(() => new Promise(() => {}));
    render(<CacheView />);
    expect(screen.getByText(/Loading cache information/i)).toBeInTheDocument();
  });

  it("renders cache info after loading", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText("Package Cache")).toBeInTheDocument();
    });

    expect(screen.getByText("4.66 GiB")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/var/cache/pacman/pkg")).toBeInTheDocument();
  });

  it("displays error message on API failure", async () => {
    mockGetCacheInfo.mockRejectedValue(new Error("Network error"));

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText(/Error loading cache information/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Network error/)).toBeInTheDocument();
  });

  it("shows retry button on error", async () => {
    mockGetCacheInfo.mockRejectedValue(new Error("Network error"));

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    });
  });

  it("renders package table with correct columns", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText("glibc")).toBeInTheDocument();
    });

    expect(screen.getByText("Package")).toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
  });

  it("displays packages in table", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText("glibc")).toBeInTheDocument();
    });

    const linuxCells = screen.getAllByText("linux");
    expect(linuxCells.length).toBe(2);
    expect(screen.getByText("6.7.0-arch1-1")).toBeInTheDocument();
    expect(screen.getByText("6.6.0-arch1-1")).toBeInTheDocument();
    expect(screen.getByText("2.39-1")).toBeInTheDocument();
  });

  it("shows unique and multi-version package counts", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText("Package Cache")).toBeInTheDocument();
    });

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("opens confirmation modal when clicking Clean Cache", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clean Cache/i })).toBeInTheDocument();
    });

    const cleanButton = screen.getByRole("button", { name: /Clean Cache/i });
    await act(async () => {
      fireEvent.click(cleanButton);
    });

    await waitFor(() => {
      expect(screen.getByText("Clean package cache?")).toBeInTheDocument();
    });
  });

  it("shows slider in confirmation modal", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clean Cache/i })).toBeInTheDocument();
    });

    const cleanButton = screen.getByRole("button", { name: /Clean Cache/i });
    await act(async () => {
      fireEvent.click(cleanButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Versions to keep:/i)).toBeInTheDocument();
    });
  });

  it("closes modal when clicking Cancel", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clean Cache/i })).toBeInTheDocument();
    });

    const cleanButton = screen.getByRole("button", { name: /Clean Cache/i });
    await act(async () => {
      fireEvent.click(cleanButton);
    });

    await waitFor(() => {
      expect(screen.getByText("Clean package cache?")).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    await waitFor(() => {
      expect(screen.queryByText("Clean package cache?")).not.toBeInTheDocument();
    });
  });

  it("starts cleanup when confirming", async () => {
    const mockProcess = createMockStreamingProcess();
    mockCleanCache.mockReturnValue({ cancel: mockProcess.close });

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clean Cache/i })).toBeInTheDocument();
    });

    const cleanButton = screen.getByRole("button", { name: /Clean Cache/i });
    await act(async () => {
      fireEvent.click(cleanButton);
    });

    await waitFor(() => {
      expect(screen.getByText("Clean package cache?")).toBeInTheDocument();
    });

    const confirmButtons = screen.getAllByRole("button", { name: /Clean Cache/i });
    const confirmButton = confirmButtons[confirmButtons.length - 1];
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    expect(mockCleanCache).toHaveBeenCalled();
  });

  it("shows cleaning state with progress", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockCleanCache.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn() };
    });

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clean Cache/i })).toBeInTheDocument();
    });

    const cleanButton = screen.getByRole("button", { name: /Clean Cache/i });
    await act(async () => {
      fireEvent.click(cleanButton);
    });

    const confirmButtons = screen.getAllByRole("button", { name: /Clean Cache/i });
    const confirmButton = confirmButtons[confirmButtons.length - 1];
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Cleaning Package Cache/i)).toBeInTheDocument();
    });

    await act(async () => {
      capturedCallbacks?.onData?.("Removing old packages...\n");
    });

    expect(screen.getByText(/Cleaning cache/i)).toBeInTheDocument();
  });

  it("shows success state after cleanup completes", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockCleanCache.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn() };
    });

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clean Cache/i })).toBeInTheDocument();
    });

    const cleanButton = screen.getByRole("button", { name: /Clean Cache/i });
    await act(async () => {
      fireEvent.click(cleanButton);
    });

    const confirmButtons = screen.getAllByRole("button", { name: /Clean Cache/i });
    const confirmButton = confirmButtons[confirmButtons.length - 1];
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await act(async () => {
      capturedCallbacks?.onComplete();
    });

    await waitFor(() => {
      expect(screen.getByText(/Cache cleaned/i)).toBeInTheDocument();
    });
  });

  it("shows error state on cleanup failure", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockCleanCache.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn() };
    });

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clean Cache/i })).toBeInTheDocument();
    });

    const cleanButton = screen.getByRole("button", { name: /Clean Cache/i });
    await act(async () => {
      fireEvent.click(cleanButton);
    });

    const confirmButtons = screen.getAllByRole("button", { name: /Clean Cache/i });
    const confirmButton = confirmButtons[confirmButtons.length - 1];
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await act(async () => {
      capturedCallbacks?.onError("Failed to clean cache");
    });

    await waitFor(() => {
      expect(screen.getByText(/Error loading cache information/i)).toBeInTheDocument();
    });
  });

  it("cancels cleanup when clicking Cancel during operation", async () => {
    const mockCancel = vi.fn();
    mockCleanCache.mockImplementation(() => {
      return { cancel: mockCancel };
    });

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clean Cache/i })).toBeInTheDocument();
    });

    const cleanButton = screen.getByRole("button", { name: /Clean Cache/i });
    await act(async () => {
      fireEvent.click(cleanButton);
    });

    const confirmButtons = screen.getAllByRole("button", { name: /Clean Cache/i });
    const confirmButton = confirmButtons[confirmButtons.length - 1];
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Cleaning Package Cache/i)).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    expect(mockCancel).toHaveBeenCalled();
  });

  it("opens package details modal when clicking a package row", async () => {
    mockGetPackageInfo.mockResolvedValue(mockPackageDetails);

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText("glibc")).toBeInTheDocument();
    });

    const linuxButtons = screen.getAllByRole("button", { name: "linux" });
    await act(async () => {
      fireEvent.click(linuxButtons[0]);
    });

    await waitFor(() => {
      expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    });
  });

  it("falls back to sync package info for uninstalled packages", async () => {
    mockGetPackageInfo.mockRejectedValue(new Error("Package not found"));
    mockGetSyncPackageInfo.mockResolvedValue({
      name: "linux",
      version: "6.7.0-arch1-1",
      description: "The Linux kernel",
      url: "https://kernel.org/",
      licenses: ["GPL-2.0-only"],
      groups: [],
      provides: [],
      depends: [],
      optdepends: [],
      conflicts: [],
      replaces: [],
      download_size: 150000000,
      installed_size: 145000000,
      packager: "heftig",
      architecture: "x86_64",
      build_date: 1704067200,
      repository: "core",
    });

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText("glibc")).toBeInTheDocument();
    });

    const linuxButtons = screen.getAllByRole("button", { name: "linux" });
    await act(async () => {
      fireEvent.click(linuxButtons[0]);
    });

    await waitFor(() => {
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux");
    });
  });

  it("displays empty state when cache is empty", async () => {
    mockGetCacheInfo.mockResolvedValue({
      total_size: 0,
      package_count: 0,
      packages: [],
      path: "/var/cache/pacman/pkg",
    });

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText(/Cache is empty/i)).toBeInTheDocument();
    });
  });

  it("sorts packages by name when clicking header", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText("glibc")).toBeInTheDocument();
    });

    const packageHeader = screen.getByText("Package");
    await act(async () => {
      fireEvent.click(packageHeader);
    });

    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(1);
  });
});

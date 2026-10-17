import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { CacheView } from "./CacheView";
import * as api from "../api";
import { createMockStreamingProcess } from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getCacheInfo: vi.fn(),
    getCacheFiles: vi.fn(),
    cleanCache: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
  };
});

const mockGetCacheFiles = vi.mocked(api.getCacheFiles);
const mockGetCacheInfo = vi.mocked(api.getCacheInfo);
const mockCleanCache = vi.mocked(api.cleanCache);
const mockGetPackageInfo = vi.mocked(api.getPackageInfo);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);

const mockCacheInfo: api.CacheInfo = {
  total_size: 5000000000,
  package_count: 150,
  unique_packages: 2,
  multi_version_packages: 1,
  total: 2,
  groups: [
    { name: "glibc", latest_version: "2.39-1", file_count: 1, total_size: 45000000 },
    { name: "linux", latest_version: "6.7.0-arch1-1", file_count: 2, total_size: 298000000 },
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
  required_by: [],
  optional_for: [],
  installed_size: 150000000,
  packager: "heftig",
  architecture: "x86_64",
  build_date: 1704067200,
  install_date: 1704067200,
  reason: "explicit",
  validation: ["pgp"],
  repository: "core",
  update_stats: null,
};

describe("CacheView", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    expect(linuxCells.length).toBe(1);
    expect(screen.getByText("6.7.0-arch1-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View cached files for linux" })).toHaveTextContent("2 files");
    expect(screen.getByText("2.39-1")).toBeInTheDocument();
  });

  it("shows unique and multi-version package counts", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText("Package Cache")).toBeInTheDocument();
    });

    const uniqueLabel = screen.getByText("Unique Packages");
    expect(uniqueLabel.parentElement?.querySelector("div")?.textContent).toBe("2");
    const multiLabel = screen.getByText("Multi-Version");
    expect(multiLabel.parentElement?.querySelector("div")?.textContent).toBe("1");
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
      expect(screen.getByRole("dialog", { name: "Clean package cache?" })).toBeInTheDocument();
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
    mockCleanCache.mockReturnValue({ cancel: mockProcess.close, forceStop: mockProcess.close });

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
      return { cancel: vi.fn(), forceStop: vi.fn() };
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
      return { cancel: vi.fn(), forceStop: vi.fn() };
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
      return { cancel: vi.fn(), forceStop: vi.fn() };
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
      capturedCallbacks?.onError("Failed to clean cache", "internal_error", "Cannot remove a read-only archive");
    });
    expect(screen.getByText("Cannot remove a read-only archive")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/Error loading cache information/i)).toBeInTheDocument();
    });
  });

  it("cancels cleanup when clicking Cancel during operation", async () => {
    const mockCancel = vi.fn();
    mockCleanCache.mockImplementation(() => {
      return { cancel: mockCancel, forceStop: mockCancel };
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

    expect(mockCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Cancellation requested" })).toBeDisabled();
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
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux", undefined);
    });
  });

  it("displays empty state when cache is empty", async () => {
    mockGetCacheInfo.mockResolvedValue({
      total_size: 0,
      package_count: 0,
      unique_packages: 0,
      multi_version_packages: 0,
      total: 0,
      groups: [],
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

  it("requests group pages and sorting from the backend", async () => {
    mockGetCacheInfo.mockImplementation(async params => ({
      ...mockCacheInfo,
      total: 101,
      unique_packages: 101,
      groups: params?.offset === 50 ? [mockCacheInfo.groups[1]] : [mockCacheInfo.groups[0]],
    }));
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);
    await screen.findByText("linux");
    expect(mockGetCacheInfo).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50, limit: 50 }));
    fireEvent.click(screen.getByText("Version"));
    await waitFor(() => expect(mockGetCacheInfo).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, sortBy: "version", sortDir: "asc" })));
  });

  it("keeps cache totals and the filter when no group matches", async () => {
    mockGetCacheInfo.mockImplementation(async params => ({
      ...mockCacheInfo,
      total: params?.search ? 0 : 2,
      groups: params?.search ? [] : mockCacheInfo.groups,
    }));
    render(<CacheView />);
    await screen.findByText("glibc");
    const input = screen.getByRole("textbox", { name: "Filter cached packages" });
    fireEvent.change(input, { target: { value: "absent" } });
    await screen.findByText("No cached packages match this filter");
    expect(input).toHaveValue("absent");
    expect(screen.getByText("4.66 GiB")).toBeInTheDocument();
    expect(screen.queryByText("Cache is empty")).not.toBeInTheDocument();
  });

  it("discards an older filter response without replacing the current rows", async () => {
    let resolveOlder: ((response: api.CacheInfo) => void) | undefined;
    mockGetCacheInfo.mockImplementation(params => {
      if (params?.search === "linux") return new Promise(resolve => { resolveOlder = resolve; });
      return Promise.resolve({ ...mockCacheInfo, total: 1, groups: [mockCacheInfo.groups[0]] });
    });
    render(<CacheView />);
    await screen.findByText("glibc");
    const input = screen.getByRole("textbox", { name: "Filter cached packages" });
    fireEvent.change(input, { target: { value: "linux" } });
    await waitFor(() => expect(resolveOlder).toBeDefined());
    fireEvent.change(input, { target: { value: "glibc" } });
    await waitFor(() => expect(mockGetCacheInfo).toHaveBeenLastCalledWith(expect.objectContaining({ search: "glibc" })));
    await act(async () => { resolveOlder?.({ ...mockCacheInfo, total: 1, groups: [mockCacheInfo.groups[1]] }); });
    expect(screen.getByText("glibc")).toBeInTheDocument();
    expect(screen.queryByText("linux")).not.toBeInTheDocument();
  });

  it("preserves excluded packages across pages and filters", async () => {
    mockGetCacheInfo.mockImplementation(async params => ({
      ...mockCacheInfo, total: params?.search ? 1 : 101, unique_packages: 101,
      groups: params?.offset || params?.search ? [mockCacheInfo.groups[1]] : [mockCacheInfo.groups[0]],
    }));
    mockCleanCache.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(within(screen.getByRole("row", { name: /glibc/ })).getByRole("checkbox"));
    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);
    await screen.findByText("linux");
    expect(within(screen.getByRole("row", { name: /linux/ })).getByRole("checkbox")).toBeChecked();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "linux" } });
    await waitFor(() => expect(mockGetCacheInfo).toHaveBeenLastCalledWith(expect.objectContaining({ search: "linux", offset: 0 })));
    const clean = screen.getByRole("button", { name: "Clean selected packages" });
    await waitFor(() => expect(clean).toBeEnabled());
    fireEvent.click(clean);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clean Cache" }));
    expect(mockCleanCache).toHaveBeenCalledWith(expect.any(Object), 3, { mode: "except", names: ["glibc"] });
  });

  it("requires a selected package after deselecting all", async () => {
    mockCleanCache.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages" }));
    expect(screen.getByRole("button", { name: "Clean Cache" })).toBeDisabled();
    expect(mockCleanCache).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("row", { name: /linux/ })).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Clean selected packages" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clean Cache" }));
    expect(mockCleanCache).toHaveBeenCalledWith(expect.any(Object), 3, { mode: "only", names: ["linux"] });
  });

  it("preserves exclusions through a failed refresh and retry", async () => {
    mockCleanCache.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(within(screen.getByRole("row", { name: /glibc/ })).getByRole("checkbox"));
    mockGetCacheInfo.mockRejectedValueOnce(new Error("Cache unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("glibc");
    expect(within(screen.getByRole("row", { name: /glibc/ })).getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Clean selected packages" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clean Cache" }));
    expect(mockCleanCache).toHaveBeenCalledWith(expect.any(Object), 3, { mode: "except", names: ["glibc"] });
  });

  it("describes selection without a stale count after an excluded package disappears", async () => {
    mockCleanCache.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(within(screen.getByRole("row", { name: /glibc/ })).getByRole("checkbox"));
    mockGetCacheInfo.mockResolvedValue({
      ...mockCacheInfo, unique_packages: 1, total: 1, groups: [mockCacheInfo.groups[1]],
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("glibc")).not.toBeInTheDocument());
    const clean = screen.getByRole("button", { name: "Clean selected packages" });
    expect(clean).toBeEnabled();
    fireEvent.click(clean);
    expect(screen.getByText("This will clean all cached packages except those you deselected.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clean Cache" }));
    expect(mockCleanCache).toHaveBeenCalledWith(expect.any(Object), 3, { mode: "except", names: ["glibc"] });
  });

  it("preserves an empty explicit selection on refresh", async () => {
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(screen.getByRole("checkbox", { name: "Select all packages" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Clean Cache" })).toBeDisabled();
  });

  it("loads cached files on demand and preserves filenames across file pages", async () => {
    const files = [
      { name: "linux", version: "6.7-1", filename: "linux-6.7-1-aarch64.pkg.tar.zst", size: 100 },
      { name: "linux", version: "6.7-1", filename: "linux-6.7-1-x86_64.pkg.tar.zst", size: 120 },
    ];
    mockGetCacheFiles.mockImplementation(async (_name, offset) => ({ total: 55, files: offset ? [files[1]] : [files[0]] }));
    render(<CacheView />);
    await screen.findByText("glibc");
    expect(mockGetCacheFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View cached files for linux" }));
    await screen.findByText(files[0].filename);
    expect(mockGetCacheFiles).toHaveBeenLastCalledWith("linux", 0, 50);
    const dialog = within(screen.getByRole("dialog", { name: "Cached files for linux" }));
    fireEvent.click(dialog.getByRole("button", { name: "Go to next page" }));
    await screen.findByText(files[1].filename);
    expect(mockGetCacheFiles).toHaveBeenLastCalledWith("linux", 50, 50);
    expect(screen.queryByText(files[0].filename)).not.toBeInTheDocument();
    expect(mockGetPackageInfo).not.toHaveBeenCalled();
  });

  it("resets selection and group pagination after cleanup", async () => {
    let callbacks: api.UpgradeCallbacks | undefined;
    mockGetCacheInfo.mockResolvedValue({ ...mockCacheInfo, total: 101, unique_packages: 101 });
    mockCleanCache.mockImplementation(value => { callbacks = value; return { cancel: vi.fn(), forceStop: vi.fn() }; });
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);
    await waitFor(() => expect(mockGetCacheInfo).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages" }));
    fireEvent.click(within(screen.getByRole("row", { name: /linux/ })).getByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clean selected packages" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Clean selected packages" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clean Cache" }));
    await act(async () => { callbacks?.onComplete(); });
    mockGetCacheInfo.mockResolvedValue({ ...mockCacheInfo, groups: [mockCacheInfo.groups[0]], total: 1, unique_packages: 1 });
    fireEvent.click(screen.getByRole("button", { name: "View Cache" }));
    await screen.findByText("glibc");
    expect(mockGetCacheInfo).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
    expect(screen.getByRole("checkbox", { name: "Select all packages" })).toBeChecked();
  });

});

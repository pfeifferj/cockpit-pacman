import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { CacheView } from "./CacheView";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { NavigationProvider } from "../contexts/NavigationContext";
import { DowngradeProvider } from "../contexts/DowngradeContext";
import { mockPermission, mockSpawn } from "../test/setup";
import { sweepA11y } from "../test/a11ySweep";
import * as api from "../api";
import { createMockStreamingProcess } from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getCacheInfo: vi.fn(),
    getCacheFiles: vi.fn(),
    cleanCache: vi.fn(),
    previewCacheCleanup: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
    listIgnoredPackages: vi.fn(async () => ({ packages: [], total: 0 })),
    listDowngrades: vi.fn(),
    listArchiveVersions: vi.fn(),
    previewDowngrade: vi.fn(),
  };
});

const mockGetCacheFiles = vi.mocked(api.getCacheFiles);
const mockGetCacheInfo = vi.mocked(api.getCacheInfo);
const mockPreviewCacheCleanup = vi.mocked(api.previewCacheCleanup);
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
    { installed_version: "2.39-1", downgrade_version: null, name: "glibc", latest_version: "2.39-1", file_count: 1, total_size: 45000000 },
    { installed_version: "6.7.0-arch1-1", downgrade_version: "6.6.0-arch1-1", name: "linux", latest_version: "6.7.0-arch1-1", file_count: 2, total_size: 298000000 },
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

async function setKeep(target: number) {
  const thumb = screen.getByRole("slider", { name: "Versions to keep" });
  while (Number(thumb.getAttribute("aria-valuenow")) > target) {
    await act(async () => {
      fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    });
  }
}

async function openConfirm() {
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /Clean cache/i })).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Clean cache/i }));
  });
}

describe("CacheView", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetCacheInfo.mockResolvedValue(mockCacheInfo);
    mockPreviewCacheCleanup.mockResolvedValue({ files: 2, bytes: 1000 });
  });

  afterEach(() => {
    cleanup();
  });

  it("blocks cleanup until the latest server projection returns", async () => {
    let resolveOld: ((value: api.CacheCleanupPreview) => void) | undefined;
    mockPreviewCacheCleanup.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    mockPreviewCacheCleanup.mockResolvedValue({ files: 400, bytes: 9 * 1024 * 1024 });
    mockCleanCache.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<CacheView />);
    await openConfirm();
    expect(screen.getByRole("button", { name: "Calculating cleanup…" })).toBeDisabled();
    expect(mockCleanCache).not.toHaveBeenCalled();
    const firstSignal = mockPreviewCacheCleanup.mock.calls[0][2];
    await setKeep(2);
    const commit = await screen.findByRole("button", { name: "Delete up to 400 files (9.0 MiB)" });
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => resolveOld?.({ files: 999, bytes: 123 }));
    expect(commit).toHaveAccessibleName("Delete up to 400 files (9.0 MiB)");
    fireEvent.click(commit);
    expect(mockCleanCache).toHaveBeenCalledWith(expect.any(Object), 2, { mode: "all" });
    expect(mockPreviewCacheCleanup).toHaveBeenLastCalledWith(2, { mode: "all" }, expect.any(AbortSignal));
  });

  it("disables an empty projection and marks deleting every cached version as dangerous", async () => {
    mockPreviewCacheCleanup.mockImplementation(async keep => keep === 0
      ? { files: 150, bytes: 5000000000 } : { files: 0, bytes: 0 });
    render(<CacheView />);
    await openConfirm();
    expect(await screen.findByRole("button", { name: "Nothing to delete" })).toBeDisabled();
    await setKeep(0);
    const commit = await screen.findByRole("button", { name: "Delete up to 150 files (4.66 GiB)" });
    expect(commit).toHaveClass("pf-m-danger");
    expect(screen.getByText("All cached versions of the selected packages will be deleted, including installed versions.")).toBeInTheDocument();
    expect(mockPreviewCacheCleanup).toHaveBeenLastCalledWith(0, { mode: "all" }, expect.any(AbortSignal));
  });

  it("announces the filtered server count after the matching page arrives", async () => {
    let resolveFilter: ((response: api.CacheInfo) => void) | undefined;
    mockGetCacheInfo.mockImplementation(params => params?.search
      ? new Promise(resolve => { resolveFilter = resolve; }) : Promise.resolve(mockCacheInfo));
    render(<AnnouncerProvider><CacheView /></AnnouncerProvider>);
    await screen.findByText("glibc");
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.change(screen.getByLabelText("Filter cached packages"), { target: { value: "zzz" } });
    await waitFor(() => expect(resolveFilter).toBeDefined());
    expect(screen.getByRole("status").textContent).toBe("");
    await act(async () => resolveFilter?.({ ...mockCacheInfo, total: 0, groups: [] }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No cached packages match zzz"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(await screen.findByText("glibc")).toBeInTheDocument();
  });

  it("previews again when a dismissed confirmation is reopened", async () => {
    render(<CacheView />);
    await openConfirm();
    await screen.findByRole("button", { name: /^Delete up to/ });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    mockPreviewCacheCleanup.mockImplementationOnce(() => new Promise(() => {}));
    await openConfirm();
    expect(screen.getByRole("button", { name: "Calculating cleanup…" })).toBeDisabled();
    expect(mockPreviewCacheCleanup).toHaveBeenCalledTimes(2);
  });

  it("shows a typed preview failure and retries without deleting files", async () => {
    mockPreviewCacheCleanup.mockRejectedValueOnce(new api.BackendError("Cache unavailable", "permission_denied", "Cannot inspect package archives"));
    render(<CacheView />);
    await openConfirm();
    expect(await screen.findByText("Cannot inspect package archives")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nothing to delete" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Try again|Retry/ }));
    expect(await screen.findByRole("button", { name: /^Delete up to/ })).toBeEnabled();
    expect(mockCleanCache).not.toHaveBeenCalled();
  });

  it("waits for process exit after the complete event during cancellation", async () => {
    const actual = await vi.importActual<typeof api>("../api");
    const process = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(process);
    mockCleanCache.mockImplementation(actual.cleanCache);
    render(<CacheView />);
    await openConfirm();
    fireEvent.click(await screen.findByRole("button", { name: /^Delete up to/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop cleaning" }));
    await act(async () => process._emit(JSON.stringify({ type: "complete", success: false, code: "cancelled", error: "Stopped after removing 1 file" }) + "\n"));
    expect(screen.getByText("Cleaning package cache")).toBeInTheDocument();
    expect(screen.queryByText("Cache cleaning stopped")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force stop" })).not.toBeInTheDocument();
    await act(async () => process._complete());
    expect(await screen.findByText("Cache cleaning stopped")).toBeInTheDocument();
  });

  it("renders loading spinner initially", async () => {
    mockGetCacheInfo.mockImplementation(() => new Promise(() => {}));
    render(<CacheView />);
    expect(screen.getByText(/Loading cache information/i)).toBeInTheDocument();
  });

  it("renders cache info after loading", async () => {
    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter cached packages")).toBeInTheDocument();
    });

    expect(screen.getByText("4.66 GiB")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
  });

  it("displays error message on API failure", async () => {
    mockGetCacheInfo.mockRejectedValue(new Error("Network error"));

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByText(/Could not load cache information/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Network error/)).toBeInTheDocument();
  });

  it("shows retry button on error", async () => {
    mockGetCacheInfo.mockRejectedValue(new Error("Network error"));

    render(<CacheView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
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
      expect(screen.getByLabelText("Filter cached packages")).toBeInTheDocument();
    });

    const uniqueLabel = screen.getByText("Unique packages");
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
      expect(screen.getByRole("dialog", { name: /Clean package cache\?$/ })).toBeInTheDocument();
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

    const confirmButton = await screen.findByRole("button", { name: /^Delete up to/ });
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

    const confirmButton = await screen.findByRole("button", { name: /^Delete up to/ });
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

    const confirmButton = await screen.findByRole("button", { name: /^Delete up to/ });
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

    const confirmButton = await screen.findByRole("button", { name: /^Delete up to/ });
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await act(async () => {
      capturedCallbacks?.onError("Failed to clean cache", "internal_error", "Cannot remove a read-only archive");
    });
    expect(screen.getByText("Cannot remove a read-only archive")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/Cache clean failed/i)).toBeInTheDocument();
    });
  });

  it("requests a stop and waits for the cleanup process", async () => {
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

    const confirmButton = await screen.findByRole("button", { name: /^Delete up to/ });
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Cleaning Package Cache/i)).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole("button", { name: "Stop" });
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop cleaning" }));
    expect(mockCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Stopping…/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Waiting for the cache cleanup process to exit/)).toBeInTheDocument();
    expect(screen.queryByText("Cache cleaning stopped")).not.toBeInTheDocument();
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
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("Package not found", "not_found"));
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
    await screen.findByText("No matching packages");
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
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /^Delete up to/ }));
    expect(mockCleanCache).toHaveBeenCalledWith(expect.any(Object), 3, { mode: "except", names: ["glibc"] });
  });

  it("requires a selected package after deselecting all", async () => {
    mockCleanCache.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages" }));
    expect(screen.getByRole("button", { name: "Clean cache" })).toHaveAttribute("aria-disabled", "true");
    expect(mockCleanCache).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("row", { name: /linux/ })).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Clean selected packages" }));
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /^Delete up to/ }));
    expect(mockCleanCache).toHaveBeenCalledWith(expect.any(Object), 3, { mode: "only", names: ["linux"] });
  });

  it("preserves exclusions through a failed refresh and retry", async () => {
    mockCleanCache.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(within(screen.getByRole("row", { name: /glibc/ })).getByRole("checkbox"));
    mockGetCacheInfo.mockRejectedValueOnce(new Error("Cache unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText("glibc");
    expect(within(screen.getByRole("row", { name: /glibc/ })).getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Clean selected packages" }));
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /^Delete up to/ }));
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
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /^Delete up to/ }));
    expect(mockCleanCache).toHaveBeenCalledWith(expect.any(Object), 3, { mode: "except", names: ["glibc"] });
  });

  it("preserves an empty explicit selection on refresh", async () => {
    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(screen.getByRole("checkbox", { name: "Select all packages" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Clean cache" })).toHaveAttribute("aria-disabled", "true");
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
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /^Delete up to/ }));
    await act(async () => { callbacks?.onComplete(); });
    mockGetCacheInfo.mockResolvedValue({ ...mockCacheInfo, groups: [mockCacheInfo.groups[0]], total: 1, unique_packages: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Back to cache" }));
    await screen.findByText("glibc");
    expect(mockGetCacheInfo).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
    expect(screen.getByRole("checkbox", { name: "Select all packages" })).toBeChecked();
  });

});


describe("CacheView interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCacheInfo.mockResolvedValue(mockCacheInfo);
    mockPreviewCacheCleanup.mockImplementation(async keep => ({ files: keep === 3 ? 0 : 2, bytes: 148000000 }));
    mockGetPackageInfo.mockResolvedValue(mockPackageDetails);
    mockGetSyncPackageInfo.mockRejectedValue(new api.BackendError("Package not found", "not_found"));
  });
  afterEach(() => cleanup());
  async function startClean() {
    let callbacks: api.UpgradeCallbacks | null = null;
    const cancel = vi.fn();
    const forceStop = vi.fn();
    mockCleanCache.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel, forceStop };
    });
    render(<CacheView />);
    await openConfirm();
    await setKeep(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Delete up to/ }));
    });
    await screen.findByText("Cleaning package cache");
    return { callbacks: () => callbacks!, cancel, forceStop };
  }

  it("asks before stopping and sends nothing until confirmed", async () => {
    const { cancel, forceStop } = await startClean();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });

    expect(screen.getByText("Stop cleaning the cache?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep running" })).toHaveFocus();
    expect(cancel).not.toHaveBeenCalled();
    expect(forceStop).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    });
    expect(screen.queryByText("Stop cleaning the cache?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("passes the a11y sweep while running and while asking to stop", async () => {
    const { callbacks } = await startClean();
    await act(async () => {
      callbacks().onEvent?.({ type: "event", event: "Removed", package: "linux-6.6.0-arch1-1-x86_64.pkg.tar.zst", current: 1, total: 4 });
    });
    sweepA11y();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    sweepA11y();
  });

  it("stops gracefully, then shows the backend's summary with the log kept", async () => {
    const { callbacks, cancel, forceStop } = await startClean();
    await act(async () => {
      callbacks().onData?.("Removed: linux-6.6.0-arch1-1-x86_64.pkg.tar.zst\n");
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop cleaning" }));
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(forceStop).not.toHaveBeenCalled();
    const stopping = screen.getByRole("button", { name: /Stopping…/ });
    expect(stopping).toHaveAttribute("aria-disabled", "true");
    expect(stopping).toHaveFocus();

    await act(async () => {
      callbacks().onError("Stopped after removing 1 file, freed 148 MiB", "cancelled");
    });

    expect(screen.getByRole("heading", { name: "Cache cleaning stopped" })).toBeInTheDocument();
    expect(screen.getByText("Stopped after removing 1 file, freed 148 MiB")).toBeInTheDocument();
    expect(screen.queryByText("Cache clean failed")).not.toBeInTheDocument();
    expect(within(screen.getByRole("log")).getByText(/linux-6\.6\.0/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to cache" }));
    });
    expect(await screen.findByLabelText("Filter cached packages")).toBeInTheDocument();
  });

  it("reports a failure during a stop as a failure", async () => {
    const { callbacks } = await startClean();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop cleaning" }));
    });
    await act(async () => {
      callbacks().onError("Failed to lock the package database", "database_locked");
    });
    expect(screen.getByText("Cache clean failed")).toBeInTheDocument();
  });

  it("counts deleted files in the progress bar only once a total is known", async () => {
    const { callbacks } = await startClean();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await act(async () => {
      callbacks().onEvent?.({ type: "event", event: "Starting cache cleanup" });
    });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await act(async () => {
      callbacks().onEvent?.({ type: "event", event: "Removed", package: "a", current: 1, total: 4 });
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "1 of 4 files");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");

    await act(async () => {
      callbacks().onEvent?.({ type: "event", event: "Removed", package: "b", current: 3, total: 4 });
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "3 of 4 files");
  });

  it("notes a clean that finished before the stop reached it", async () => {
    const { callbacks } = await startClean();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop cleaning" }));
    });
    await act(async () => {
      callbacks().onComplete();
    });
    expect(screen.getByText(/Cleaning finished before it could be stopped/)).toBeInTheDocument();
  });

  it("replaces the details panel in place, keeps the selection and returns focus to the row", async () => {
    mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText("glibc")).toBeInTheDocument());
    const grid = () => screen.getByRole("grid", { name: "Cached packages" });
    const nameButton = (name: string) => within(grid()).getByRole("button", { name });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select glibc" }));

    fireEvent.click(nameButton("linux"));
    await screen.findByRole("region", { name: /^linux/ });
    nameButton("glibc").focus();
    fireEvent.click(nameButton("glibc"));
    await screen.findByRole("region", { name: /^glibc/ });

    expect(screen.queryByRole("region", { name: /^linux/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(nameButton("glibc").closest("tr")).toHaveAttribute("aria-current", "true");
    expect(nameButton("linux").closest("tr")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("checkbox", { name: "Select glibc" })).not.toBeChecked();
    sweepA11y();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: /^glibc/ })).not.toBeInTheDocument());
    expect(nameButton("glibc")).toHaveFocus();
  });

  describe("route options", () => {
    const grid = () => screen.getByRole("grid", { name: "Cached packages" });
    const nameButton = (name: string) => within(grid()).getByRole("button", { name });

    it("opens a routed pkg in the drawer, writes a row open and closes when pkg is cleared", async () => {
      mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
      const onRouteChange = vi.fn();
      const { rerender } = render(<CacheView routeOptions={{ pkg: "linux" }} onRouteChange={onRouteChange} />);
      expect(await screen.findByRole("region", { name: /^linux/ })).toBeInTheDocument();
      expect(screen.queryAllByRole("dialog")).toHaveLength(0);
      expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
      await waitFor(() => expect(nameButton("linux").closest("tr")).toHaveAttribute("aria-current", "true"));

      nameButton("glibc").focus();
      fireEvent.click(nameButton("glibc"));
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ pkg: "glibc" }));
      rerender(<CacheView routeOptions={{ pkg: "glibc" }} onRouteChange={onRouteChange} />);
      const panel = await screen.findByRole("region", { name: /^glibc/ });

      within(panel).getByRole("button", { name: "Close package details" }).focus();
      rerender(<CacheView routeOptions={{}} onRouteChange={onRouteChange} />);
      await waitFor(() => expect(screen.queryByRole("region", { name: /^glibc/ })).not.toBeInTheDocument());
      expect(nameButton("glibc")).toHaveFocus();
    });

    it("reads a routed repository build and drops pkg when the drawer is closed", async () => {
      mockGetSyncPackageInfo.mockResolvedValue({ ...mockPackageDetails, name: "glibc", repository: "core-testing" } as never);
      const onRouteChange = vi.fn();
      render(<CacheView routeOptions={{ pkg: "glibc", repo: "core-testing" }} onRouteChange={onRouteChange} />);
      const panel = await screen.findByRole("region", { name: /^glibc/ });
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("glibc", "core-testing");
      expect(mockGetPackageInfo).not.toHaveBeenCalled();
      fireEvent.click(within(panel).getByRole("button", { name: "Close package details" }));
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({}));
    });
  });

  it("shows the backend's result message after cleaning", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockCleanCache.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<CacheView />);
    await openConfirm();
    await setKeep(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Delete up to/ }));
    });
    await act(async () => {
      capturedCallbacks?.onEvent?.({ type: "complete", success: true, message: "Removed 1 package, freed 141.1 MiB" });
      capturedCallbacks?.onComplete();
    });

    expect(screen.getByText("Removed 1 package, freed 141.1 MiB")).toBeInTheDocument();
  });

  it("announces the projection through the shared announcer when the keep count changes", async () => {
    render(<AnnouncerProvider><CacheView /></AnnouncerProvider>);
    await openConfirm();
    expect(document.querySelectorAll("[aria-live]:not(.pf-v6-c-alert-group)")).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole("status").closest("[aria-hidden]")).toBeNull());
    await setKeep(0);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/^Frees up to .+ \(\d+ files?\)$/));
  });

  it("offers help as named buttons", async () => {
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText("glibc")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /^More information about/ })).toHaveLength(1);
    await openConfirm();
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /^More information about/ })).toHaveLength(1);
  });

  it("toggles selection on Space in a row checkbox without fetching details", async () => {
    render(<CacheView />);
    await screen.findByText("glibc");

    const checkbox = screen.getByText("glibc").closest("tr")!.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox).toBeChecked();
    await act(async () => {
      fireEvent.keyDown(checkbox, { key: " " });
      fireEvent.click(checkbox);
    });

    expect(checkbox).not.toBeChecked();
    expect(mockGetPackageInfo).not.toHaveBeenCalled();
    expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
  });

  it("disables Clean for a session without admin access", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });

    render(<CacheView />);

    const button = await screen.findByRole("button", { name: /Clean cache/i });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.queryByText("Clean package cache?")).not.toBeInTheDocument();
  });

  it("keeps Clean focusable without admin access when nothing is selected", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });

    render(<CacheView />);
    await screen.findByText("glibc");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages" }));

    const button = screen.getByRole("button", { name: /Clean cache/i });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    button.focus();
    expect(button).toHaveFocus();
  });

  it("disables Clean while an upgrade runs and names it", async () => {
    const upgrade = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(upgrade);
    act(() => {
      api.runUpgrade({ onComplete: vi.fn(), onError: vi.fn() });
    });

    render(<CacheView />);
    const button = await screen.findByRole("button", { name: /Clean cache/i });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(button);
      button.focus();
    });
    expect(screen.queryByText("Clean package cache?")).not.toBeInTheDocument();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("An upgrade is running.");

    act(() => {
      upgrade._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
      upgrade._complete();
    });
    expect(screen.getByRole("button", { name: /Clean cache/i })).not.toHaveAttribute("aria-disabled");
  });

  it("disables Clean while administrative access is still being checked", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });

    render(<CacheView />);
    const button = await screen.findByRole("button", { name: /Clean cache/i });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      button.focus();
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Checking administrative access…");
  });

});
describe("CacheView space needed by a blocked upgrade", () => {
  const MIB = 1024 * 1024;
  const need = { deficit: 200 * MIB, mount: "/" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCacheInfo.mockResolvedValue(mockCacheInfo);
    mockPreviewCacheCleanup.mockImplementation(async keep => ({ files: keep === 1 ? 1 : 0, bytes: keep === 1 ? 148000000 : 0 }));
  });

  afterEach(() => {
    cleanup();
  });

  const withFree = (free: number | null, total_size = mockCacheInfo.total_size): api.CacheInfo => ({
    ...mockCacheInfo,
    total_size,
    ...(free === null ? {} : { free_space: { mount: "/", free_bytes: free } }),
  });

  /** Runs one clean; the re-read after it resolves only when the returned function is called. */
  async function cleanOnce(after: api.CacheInfo): Promise<() => Promise<void>> {
    let callbacks: api.UpgradeCallbacks | null = null;
    mockCleanCache.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    await openConfirm();
    await setKeep(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Delete up to/ }));
    });
    let release: (info: api.CacheInfo) => void = () => {};
    mockGetCacheInfo.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    mockGetCacheInfo.mockResolvedValue(after);
    await act(async () => {
      callbacks?.onComplete();
    });
    return async () => {
      await act(async () => {
        release(after);
      });
    };
  }

  it("states measured free space, measures after each clean and makes Back to upgrade the primary", async () => {
    mockGetCacheInfo.mockResolvedValue(withFree(300 * MIB));
    const onBack = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AnnouncerProvider>
        <CacheView upgradeNeed={need} onBackToUpgrade={onBack} onDismissUpgradeNeed={onDismiss} />
      </AnnouncerProvider>,
    );
    expect(await screen.findByRole("heading", { name: /The upgrade needs 200\.0 MiB more on \/$/ })).toBeInTheDocument();
    expect(await screen.findByText(/\/ now has 300\.0 MiB free; the upgrade needs 500\.0 MiB\./)).toBeInTheDocument();

    const reread = await cleanOnce(withFree(450 * MIB, mockCacheInfo.total_size - 150 * MIB));
    expect(screen.getByRole("heading", { name: /Measuring free space…$/ })).toBeInTheDocument();
    await reread();
    expect(screen.getByRole("heading", { name: /50\.0 MiB still needed on \/$/ })).toBeInTheDocument();
    expect(screen.getByText(/\/ now has 450\.0 MiB free; the upgrade needs 500\.0 MiB\./)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("50.0 MiB still needed on /");
    expect(screen.getByRole("button", { name: "Back to cache" })).toHaveClass("pf-m-primary");

    fireEvent.click(screen.getByRole("button", { name: "Back to cache" }));
    await screen.findByLabelText("Filter cached packages");
    await (await cleanOnce(withFree(520 * MIB, mockCacheInfo.total_size - 210 * MIB)))();
    expect(screen.getByRole("heading", { name: /Enough space is free now$/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Enough space is free now");

    const back = screen.getByRole("button", { name: "Back to upgrade" });
    expect(back).toHaveClass("pf-m-primary");
    expect(back).toHaveFocus();
    expect(screen.getByRole("button", { name: "Back to cache" })).toHaveClass("pf-m-secondary");
    sweepA11y();

    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the space need" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("decides by measured free space, not by how much the cache shrank", async () => {
    mockGetCacheInfo.mockResolvedValue(withFree(300 * MIB));
    render(<CacheView upgradeNeed={need} onBackToUpgrade={vi.fn()} />);
    await screen.findByText(/now has 300\.0 MiB free/);

    // Snapshots or hard links keep the blocks allocated, so free space stays put.
    await (await cleanOnce(withFree(300 * MIB, mockCacheInfo.total_size - 400 * MIB)))();
    expect(screen.getByRole("heading", { name: /200\.0 MiB still needed on \/$/ })).toBeInTheDocument();
    expect(screen.queryByText("Enough space is free now")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to cache" })).toHaveClass("pf-m-primary");
  });

  it("reports only what was deleted when free space cannot be measured", async () => {
    mockGetCacheInfo.mockResolvedValue(withFree(null));
    const onBack = vi.fn();
    render(<CacheView upgradeNeed={need} onBackToUpgrade={onBack} />);
    await screen.findByRole("heading", { name: /The upgrade needs 200\.0 MiB more on \/$/ });

    await (await cleanOnce(withFree(null, mockCacheInfo.total_size - 250 * MIB)))();
    expect(screen.getByRole("heading", { name: /Deleted 250\.0 MiB of cache files$/ })).toBeInTheDocument();
    expect(screen.getByText(/Free space on \/ could not be measured\. Back to upgrade checks the space again/)).toBeInTheDocument();
    expect(screen.queryByText("Enough space is free now")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to cache" })).toHaveClass("pf-m-primary");
    const back = screen.getByRole("button", { name: "Back to upgrade" });
    expect(back).not.toHaveClass("pf-m-primary");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("treats a cache on another filesystem as unmeasured", async () => {
    mockGetCacheInfo.mockResolvedValue({ ...mockCacheInfo, free_space: { mount: "/var/cache", free_bytes: 900 * MIB } });
    render(<CacheView upgradeNeed={need} onBackToUpgrade={vi.fn()} />);
    await screen.findByRole("heading", { name: /The upgrade needs 200\.0 MiB more on \/$/ });
    expect(screen.getByText(/Clean old package versions to free it\./)).toBeInTheDocument();
    expect(screen.queryByText(/now has/)).not.toBeInTheDocument();
  });

  it("gates the primary Back to upgrade on administrative access", async () => {
    const listeners = new Set<() => void>();
    const permission = {
      allowed: true as boolean | null,
      addEventListener: vi.fn((_: string, fn: () => void) => { listeners.add(fn); }),
      removeEventListener: vi.fn((_: string, fn: () => void) => { listeners.delete(fn); }),
      close: vi.fn(),
    };
    mockPermission.mockImplementation(() => permission);
    mockGetCacheInfo.mockResolvedValue(withFree(300 * MIB));
    const onBack = vi.fn();
    render(<CacheView upgradeNeed={need} onBackToUpgrade={onBack} />);
    await screen.findByText(/now has 300\.0 MiB free/);
    await (await cleanOnce(withFree(600 * MIB)))();
    const back = screen.getByRole("button", { name: "Back to upgrade" });
    expect(back).not.toHaveAttribute("aria-disabled", "true");
    act(() => {
      permission.allowed = false;
      listeners.forEach((fn) => fn());
    });
    expect(screen.getByRole("button", { name: "Back to upgrade" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to upgrade" }));
    expect(onBack).not.toHaveBeenCalled();
    mockPermission.mockReset();
    mockPermission.mockImplementation(() => ({ ...permission, allowed: true }));
  });

  it("words a need without a way back neutrally and offers no Back to upgrade", async () => {
    render(<CacheView upgradeNeed={need} onDismissUpgradeNeed={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: /The transaction needs 200\.0 MiB more on \/$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Back to upgrade/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to upgrade" })).not.toBeInTheDocument();
    expect(screen.getByText(/Start it again once there is room/)).toBeInTheDocument();
  });

  it("offers Review orphans only when the short filesystem holds the cache", async () => {
    mockGetCacheInfo.mockResolvedValue(withFree(300 * MIB));
    const onViewOrphans = vi.fn();
    const { rerender } = render(
      <NavigationProvider value={{ onViewOrphans }}>
        <CacheView upgradeNeed={{ ...need, holds_cache: false }} onBackToUpgrade={vi.fn()} />
      </NavigationProvider>,
    );
    await screen.findByText(/now has 300\.0 MiB free/);
    expect(screen.queryByRole("button", { name: "Review orphans" })).not.toBeInTheDocument();

    rerender(
      <NavigationProvider value={{ onViewOrphans }}>
        <CacheView upgradeNeed={{ ...need, holds_cache: true }} onBackToUpgrade={vi.fn()} />
      </NavigationProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review orphans" }));
    expect(onViewOrphans).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Back to upgrade" })).toBeInTheDocument();
  });

  describe("keep setting that frees the need", () => {
    const cacheNeed = (deficit: number) => ({ deficit, mount: "/", holds_cache: true });

    it("names a sufficient keep, and its link sets the keep and focuses Clean without cleaning", async () => {
      mockGetCacheInfo.mockResolvedValue(withFree(300 * MIB));
      render(
        <AnnouncerProvider>
          <CacheView upgradeNeed={cacheNeed(100 * MIB)} onBackToUpgrade={vi.fn()} />
        </AnnouncerProvider>,
      );
      expect(await screen.findByText(/Keeping 1 version frees 141\.1 MiB, enough for the upgrade\./)).toBeInTheDocument();
      expect(screen.queryByText(/Clean old package versions/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Keep 1 version" }));
      expect(screen.getByRole("button", { name: "Clean cache" })).toHaveFocus();
      expect(mockCleanCache).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("button", { name: "Keep 1 version" })).not.toBeInTheDocument());
      expect(screen.getByText(/Keeping 1 version frees 141\.1 MiB/)).toBeInTheDocument();

      await openConfirm();
      expect(screen.getByRole("slider", { name: "Versions to keep" })).toHaveAttribute("aria-valuenow", "1");
      expect(mockCleanCache).not.toHaveBeenCalled();
    });

    it("says when even keeping 1 version is not enough and offers no preset for 0", async () => {
      mockGetCacheInfo.mockResolvedValue(withFree(300 * MIB));
      render(<CacheView upgradeNeed={cacheNeed(200 * MIB)} onBackToUpgrade={vi.fn()} />);
      expect(await screen.findByText(/Even keeping 1 version frees only 141\.1 MiB\./)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Keep \d+ versions?$/ })).not.toBeInTheDocument();
    });

    it("offers nothing when the short filesystem does not hold the cache", async () => {
      mockGetCacheInfo.mockResolvedValue(withFree(300 * MIB));
      render(<CacheView upgradeNeed={{ ...cacheNeed(100 * MIB), holds_cache: false }} onBackToUpgrade={vi.fn()} />);
      expect(await screen.findByText(/Clean old package versions to free the rest\./)).toBeInTheDocument();
      expect(screen.queryByText(/Keeping \d+ versions? frees/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Keep \d+ versions?$/ })).not.toBeInTheDocument();
    });

    it("offers nothing once enough space is free", async () => {
      mockGetCacheInfo.mockResolvedValue(withFree(300 * MIB));
      render(<CacheView upgradeNeed={cacheNeed(100 * MIB)} onBackToUpgrade={vi.fn()} />);
      await screen.findByText(/Keeping 1 version frees/);
      await (await cleanOnce(withFree(500 * MIB)))();
      fireEvent.click(screen.getByRole("button", { name: "Back to cache" }));
      await screen.findByLabelText("Filter cached packages");
      expect(screen.getByRole("heading", { name: /Enough space is free now$/ })).toBeInTheDocument();
      expect(screen.queryByText(/Keeping \d+ versions? frees/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Keep \d+ versions?$/ })).not.toBeInTheDocument();
    });
  });

  it("shows nothing about an upgrade without a need", async () => {
    render(<CacheView />);
    await screen.findByLabelText("Filter cached packages");
    expect(screen.queryByRole("button", { name: "Back to upgrade" })).not.toBeInTheDocument();
  });
});

describe("CacheView row actions", () => {
  const info: api.CacheInfo = {
    ...mockCacheInfo, total_size: 6 * 1024, package_count: 6, total: 3, unique_packages: 3,
    groups: [
      { name: "foo", latest_version: "2.0-1", installed_version: "2.0-1", downgrade_version: "1.10-1", file_count: 3, total_size: 3072 },
      { name: "glibc", latest_version: "2.39-1", installed_version: "2.39-1", downgrade_version: null, file_count: 1, total_size: 1024 },
      { name: "tree", latest_version: "2.1-1", installed_version: null, downgrade_version: null, file_count: 2, total_size: 2048 },
    ],
  };
  const installed = (name: string) => info.groups.find(g => g.name === name)?.installed_version ?? null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCacheInfo.mockResolvedValue(info);
    mockGetPackageInfo.mockImplementation(async (name: string) => ({
      ...mockPackageDetails, name, version: installed(name) ?? "", repository: "core",
    }));
    mockGetSyncPackageInfo.mockRejectedValue(new api.BackendError("Package not found", "not_found"));
    vi.mocked(api.listDowngrades).mockImplementation(async (name = "") => {
      const packages = name === "foo" ? [{ name, version: "1.10-1", filename: "foo-1.10-1-x86_64.pkg.tar.zst", size: 1024, installed_version: "2.0-1", is_older: true }] : [];
      return { packages, total: packages.length };
    });
    vi.mocked(api.listArchiveVersions).mockResolvedValue({ packages: [], total: 0 });
    vi.mocked(api.previewDowngrade).mockImplementation(async (name, version) => ({
      success: true,
      add: [{ name, version, repo: null, download_size: 0, installed_size: 1, old_version: installed(name) ?? undefined, reason: "target" }],
      remove: [],
      conflicts: [],
      replacements: [],
      providers: [],
      import_keys: [],
      warnings: [],
      blocked_by: [],
      total_download_size: 0,
      net_installed_size: 0,
    }));
  });

  afterEach(() => {
    cleanup();
  });

  const openMenu = async (name: string) => {
    fireEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu.querySelector("[data-pending]")).toBeNull());
    return menu;
  };

  it("marks the installed build with text", async () => {
    render(<CacheView />);
    const row = (await screen.findByRole("button", { name: "foo" })).closest("tr")!;
    expect(within(row).getByText("2.0-1 installed")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "View cached files for foo" })).toBeInTheDocument();
    const treeRow = screen.getByRole("button", { name: "tree" }).closest("tr")!;
    expect(within(treeRow).queryByText(/installed/)).not.toBeInTheDocument();
  });

  it("offers the newest older cached build by vercmp, without opening details", async () => {
    render(<DowngradeProvider><CacheView /></DowngradeProvider>);
    const menu = await openMenu("foo");
    const item = within(menu).getByRole("menuitem", { name: "Downgrade foo to 1.10-1" });
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Close package details" })).not.toBeInTheDocument();
    sweepA11y();
  });

  it("does not open details on Enter or Space in the actions cell", async () => {
    render(<CacheView />);
    const toggle = await screen.findByRole("button", { name: "Actions for tree" });
    const cell = toggle.closest("td")!;
    fireEvent.keyDown(cell, { key: "Enter" });
    fireEvent.keyDown(cell, { key: " " });
    fireEvent.click(cell);
    expect(screen.queryByRole("button", { name: "Close package details" })).not.toBeInTheDocument();
    expect(mockGetPackageInfo).not.toHaveBeenCalled();
  });

  it("keeps the downgrade slot in place, disabled, when no older build is cached", async () => {
    render(<DowngradeProvider><CacheView /></DowngradeProvider>);
    const fooItems = within(await openMenu("foo")).getAllByRole("menuitem");
    const fooIndex = fooItems.findIndex((el) => el.textContent?.startsWith("Downgrade foo to"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    const glibcItems = within(await openMenu("glibc")).getAllByRole("menuitem");
    const slot = glibcItems.findIndex((el) => el.textContent?.startsWith("Downgrade glibc to"));
    expect(slot).toBe(fooIndex);
    expect(glibcItems[slot]).toHaveAttribute("aria-disabled", "true");
    expect(glibcItems.length).toBe(fooItems.length);
  });

  it("opens the downgrade preview with the cached version preselected", async () => {
    render(<DowngradeProvider><CacheView /></DowngradeProvider>);
    const menu = await openMenu("foo");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Downgrade foo to 1.10-1" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: "Downgrade foo to 1.10-1" })).toBeInTheDocument();
    expect(api.previewDowngrade).toHaveBeenCalledWith("foo", "1.10-1");
  });
});

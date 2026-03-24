import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePackageDetails } from "./usePackageDetails";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
  };
});

const mockGetPackageInfo = vi.mocked(api.getPackageInfo);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);

const localDetails: api.PackageDetails = {
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
  required_by: [],
  optional_for: [],
  installed_size: 142000000,
  packager: "heftig",
  architecture: "x86_64",
  build_date: 1704067200,
  install_date: 1704067200,
  reason: "explicit",
  validation: ["pgp"],
  repository: "core",
  update_stats: null,
};

const syncDetails: api.SyncPackageDetails = {
  name: "linux",
  version: "6.7.1-arch1-1",
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
};

describe("usePackageDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with null state", () => {
    const { result } = renderHook(() => usePackageDetails());
    expect(result.current.selectedPackage).toBeNull();
    expect(result.current.detailsLoading).toBe(false);
    expect(result.current.detailsError).toBeNull();
  });

  it("fetches local package details by default", async () => {
    mockGetPackageInfo.mockResolvedValue(localDetails);

    const { result } = renderHook(() => usePackageDetails());

    await act(async () => {
      await result.current.fetchDetails("linux");
    });

    expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    expect(result.current.selectedPackage).toEqual(localDetails);
    expect(result.current.detailsLoading).toBe(false);
  });

  it("fetches sync package details with sync strategy", async () => {
    mockGetSyncPackageInfo.mockResolvedValue(syncDetails);

    const { result } = renderHook(() => usePackageDetails());

    await act(async () => {
      await result.current.fetchDetails("linux", { strategy: "sync", repo: "core" });
    });

    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux", "core");
    expect(result.current.selectedPackage).toEqual(syncDetails);
  });

  it("falls back to sync on local-then-sync when local fails", async () => {
    mockGetPackageInfo.mockRejectedValue(new Error("not found"));
    mockGetSyncPackageInfo.mockResolvedValue(syncDetails);

    const { result } = renderHook(() => usePackageDetails());

    await act(async () => {
      await result.current.fetchDetails("linux", { strategy: "local-then-sync" });
    });

    expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux");
    expect(result.current.selectedPackage).toEqual(syncDetails);
  });

  it("sets error when both local and sync fail", async () => {
    mockGetPackageInfo.mockRejectedValue(new Error("not found"));
    mockGetSyncPackageInfo.mockRejectedValue(new Error("not found"));
    const onError = vi.fn();

    const { result } = renderHook(() => usePackageDetails(onError));

    await act(async () => {
      await result.current.fetchDetails("linux", { strategy: "local-then-sync" });
    });

    expect(result.current.detailsError).toContain("not found");
    expect(onError).toHaveBeenCalled();
  });

  it("sets error on fetch failure", async () => {
    mockGetPackageInfo.mockRejectedValue(new Error("Network error"));
    const onError = vi.fn();

    const { result } = renderHook(() => usePackageDetails(onError));

    await act(async () => {
      await result.current.fetchDetails("linux");
    });

    expect(result.current.detailsError).toBe("Network error");
    expect(onError).toHaveBeenCalledWith("Network error");
    expect(result.current.selectedPackage).toBeNull();
  });

  it("clearDetails resets state", async () => {
    mockGetPackageInfo.mockResolvedValue(localDetails);

    const { result } = renderHook(() => usePackageDetails());

    await act(async () => {
      await result.current.fetchDetails("linux");
    });
    expect(result.current.selectedPackage).not.toBeNull();

    act(() => { result.current.clearDetails(); });
    expect(result.current.selectedPackage).toBeNull();
    expect(result.current.detailsError).toBeNull();
  });

  it("shows loading state during fetch", async () => {
    let resolve: (v: api.PackageDetails) => void;
    mockGetPackageInfo.mockReturnValue(
      new Promise((r) => { resolve = r; })
    );

    const { result } = renderHook(() => usePackageDetails());

    let fetchPromise: Promise<void>;
    act(() => {
      fetchPromise = result.current.fetchDetails("linux");
    });

    await waitFor(() => {
      expect(result.current.detailsLoading).toBe(true);
    });

    await act(async () => {
      resolve!(localDetails);
      await fetchPromise!;
    });

    expect(result.current.detailsLoading).toBe(false);
  });
});

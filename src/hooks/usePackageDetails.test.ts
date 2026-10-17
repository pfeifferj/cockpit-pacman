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

  it("falls back to sync when the package is absent locally", async () => {
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("not found", "not_found"));
    mockGetSyncPackageInfo.mockResolvedValue(syncDetails);

    const { result } = renderHook(() => usePackageDetails());

    await act(async () => {
      await result.current.fetchDetails("linux", { strategy: "local-then-sync" });
    });

    expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux", undefined);
    expect(result.current.selectedPackage).toEqual(syncDetails);
  });

  it("passes repo to local-then-sync fallback", async () => {
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("not found", "not_found"));
    mockGetSyncPackageInfo.mockResolvedValue(syncDetails);

    const { result } = renderHook(() => usePackageDetails());

    await act(async () => {
      await result.current.fetchDetails("linux", { strategy: "local-then-sync", repo: "core-testing" });
    });

    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux", "core-testing");
    expect(result.current.selectedPackage).toEqual(syncDetails);
  });

  it("reports a missing package when neither database contains it", async () => {
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("Not installed", "not_found"));
    mockGetSyncPackageInfo.mockRejectedValue(new api.BackendError("Not in sync databases", "not_found", "No enabled repository contains linux"));
    const onError = vi.fn();

    const { result } = renderHook(() => usePackageDetails(onError));

    await act(async () => {
      await result.current.fetchDetails("linux", { strategy: "local-then-sync" });
    });

    expect(result.current.detailsError).toBe("Not in sync databases");
    expect(result.current.detailsErrorCode).toBe("not_found");
    expect(result.current.detailsErrorContext).toBe("No enabled repository contains linux");
    expect(onError).toHaveBeenCalledWith("Not in sync databases", "not_found", "No enabled repository contains linux");
  });

  it("sets error on fetch failure", async () => {
    mockGetPackageInfo.mockRejectedValue(new Error("Network error"));
    const onError = vi.fn();

    const { result } = renderHook(() => usePackageDetails(onError));

    await act(async () => {
      await result.current.fetchDetails("linux");
    });

    expect(result.current.detailsError).toBe("Network error");
    expect(onError).toHaveBeenCalledWith("Network error", undefined, undefined);
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

  it("retains structured errors in state and the callback and clears them on retry", async () => {
    mockGetPackageInfo.mockRejectedValueOnce(new api.BackendError("Cannot read package", "permission_denied", "The local database cannot be opened"));
    mockGetPackageInfo.mockResolvedValue(localDetails);
    const onError = vi.fn();
    const { result } = renderHook(() => usePackageDetails(onError));
    await act(async () => { await result.current.fetchDetails("linux"); });
    expect(result.current.detailsErrorCode).toBe("permission_denied");
    expect(result.current.detailsErrorContext).toBe("The local database cannot be opened");
    expect(onError).toHaveBeenCalledWith("Cannot read package", "permission_denied", "The local database cannot be opened");
    await act(async () => { await result.current.fetchDetails("linux"); });
    expect(result.current.detailsError).toBeNull();
    expect(result.current.detailsErrorCode).toBeUndefined();
    expect(result.current.detailsErrorContext).toBeUndefined();
  });

  it("preserves the sync failure after a missing local package", async () => {
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("Not installed", "not_found"));
    mockGetSyncPackageInfo.mockRejectedValue(new api.BackendError("Cannot read sync package", "permission_denied", "The sync directory is not readable"));
    const { result } = renderHook(() => usePackageDetails());
    await act(async () => { await result.current.fetchDetails("linux", { strategy: "local-then-sync" }); });
    expect(result.current.detailsError).toBe("Cannot read sync package");
    expect(result.current.detailsErrorContext).toBe("The sync directory is not readable");
    expect(result.current.detailsErrorCode).toBe("permission_denied");
    act(() => { result.current.clearDetails(); });
    expect(result.current.detailsErrorContext).toBeUndefined();
    expect(result.current.detailsErrorCode).toBeUndefined();
  });

  it.each([
    new api.BackendError("Cannot read local package", "internal_error", "The local entry is damaged"),
    new api.BackendError("Database file not found", "permission_denied", "Cannot open the local database directory"),
    new Error("not found"),
  ])("does not hide a local lookup failure behind a sync lookup: %s", async (error) => {
    mockGetPackageInfo.mockRejectedValue(error);
    mockGetSyncPackageInfo.mockResolvedValue(syncDetails);
    const onError = vi.fn();
    const { result } = renderHook(() => usePackageDetails(onError));

    await act(async () => { await result.current.fetchDetails("linux", { strategy: "local-then-sync" }); });

    expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
    expect(result.current.selectedPackage).toBeNull();
    expect(result.current.detailsError).toBe(error.message);
    const code = error instanceof api.BackendError ? error.code : undefined;
    const context = error instanceof api.BackendError ? error.details : undefined;
    expect(result.current.detailsErrorCode).toBe(code);
    expect(result.current.detailsErrorContext).toBe(context);
    expect(onError).toHaveBeenCalledWith(error.message, code, context);
  });

  it.each(["resolve", "reject"] as const)("drops a cleared request that later %s", async (outcome) => {
    let resolve!: (details: api.PackageDetails) => void;
    let reject!: (error: Error) => void;
    mockGetPackageInfo.mockReturnValue(new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    }));
    const onError = vi.fn();
    const { result } = renderHook(() => usePackageDetails(onError));
    let fetching!: Promise<void>;
    act(() => { fetching = result.current.fetchDetails("linux", { strategy: "local-then-sync" }); });
    expect(result.current.detailsLoading).toBe(true);

    act(() => { result.current.clearDetails(); });
    expect(result.current.detailsLoading).toBe(false);

    await act(async () => {
      if (outcome === "resolve") resolve(localDetails);
      else reject(new api.BackendError("not found", "not_found"));
      await fetching;
    });

    expect(result.current.selectedPackage).toBeNull();
    expect(result.current.detailsError).toBeNull();
    expect(result.current.detailsLoading).toBe(false);
    expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
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
  it("keeps the previous package on screen while the next one loads", async () => {
    mockGetPackageInfo.mockResolvedValueOnce(localDetails);
    const { result } = renderHook(() => usePackageDetails());
    await act(async () => { await result.current.fetchDetails("linux"); });

    let resolve!: (v: api.PackageDetails) => void;
    mockGetPackageInfo.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    let fetching!: Promise<void>;
    act(() => { fetching = result.current.fetchDetails("glibc"); });
    expect(result.current.detailsLoading).toBe(true);
    expect(result.current.selectedPackage?.name).toBe("linux");

    await act(async () => {
      resolve({ ...localDetails, name: "glibc" });
      await fetching;
    });
    expect(result.current.selectedPackage?.name).toBe("glibc");
  });

  it("refreshDetails replaces the shown package without a loading state", async () => {
    mockGetPackageInfo.mockResolvedValueOnce(localDetails);
    const { result } = renderHook(() => usePackageDetails());
    await act(async () => { await result.current.fetchDetails("linux"); });

    let resolve!: (v: api.PackageDetails) => void;
    mockGetPackageInfo.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.refreshDetails(); });
    expect(result.current.detailsLoading).toBe(false);
    expect(result.current.selectedPackage?.version).toBe(localDetails.version);

    await act(async () => {
      resolve({ ...localDetails, version: "6.8.0-arch1-1" });
      await refreshing;
    });
    expect(result.current.selectedPackage?.version).toBe("6.8.0-arch1-1");
    expect(mockGetPackageInfo).toHaveBeenLastCalledWith("linux");
  });

  it("refreshDetails reports a package removed meanwhile", async () => {
    mockGetPackageInfo.mockResolvedValueOnce(localDetails);
    const { result } = renderHook(() => usePackageDetails());
    await act(async () => { await result.current.fetchDetails("linux"); });

    mockGetPackageInfo.mockRejectedValueOnce(new api.BackendError("Package 'linux' not found", "not_found"));
    await act(async () => { await result.current.refreshDetails(); });

    expect(result.current.selectedPackage).toBeNull();
    expect(result.current.detailsRemoved).toBe(true);
    expect(result.current.detailsError).toBe("linux was removed outside this page");
  });

  it("refreshDetails keeps the shown package when the read fails for another reason", async () => {
    mockGetPackageInfo.mockResolvedValueOnce(localDetails);
    const { result } = renderHook(() => usePackageDetails());
    await act(async () => { await result.current.fetchDetails("linux"); });

    mockGetPackageInfo.mockRejectedValueOnce(new api.BackendError("Cannot read package", "permission_denied", "Cannot open the local database"));
    await act(async () => { await result.current.refreshDetails(); });

    expect(result.current.selectedPackage).toEqual(localDetails);
    expect(result.current.detailsRemoved).toBe(false);
    expect(result.current.detailsError).toBe("Cannot read package");
    expect(result.current.detailsErrorCode).toBe("permission_denied");
    expect(result.current.detailsErrorContext).toBe("Cannot open the local database");

    mockGetPackageInfo.mockResolvedValueOnce(localDetails);
    await act(async () => { await result.current.refreshDetails(); });
    expect(result.current.detailsError).toBeNull();
    expect(result.current.detailsErrorCode).toBeUndefined();
    expect(result.current.detailsErrorContext).toBeUndefined();
  });

  it("refreshDetails does nothing when no package is shown", async () => {
    const { result } = renderHook(() => usePackageDetails());
    await act(async () => { await result.current.refreshDetails(); });
    expect(mockGetPackageInfo).not.toHaveBeenCalled();
  });
});

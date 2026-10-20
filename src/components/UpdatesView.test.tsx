import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { UpdatesView } from "./UpdatesView";
import { SignoffsView, SIGNOFF_TILE_FILTER } from "./SignoffsView";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { NavigationProvider, type CacheContext } from "../contexts/NavigationContext";
import { TabActiveContext } from "../hooks/useRefreshOnActivate";
import * as api from "../api";
import { mockPermission, mockSpawn, mockTransportControl } from "../test/setup";
import { sweepA11y } from "../test/a11ySweep";
import {
  mockUpdatesResponse,
  mockPreflightResponse,
  mockPreflightWithConflicts,
  mockPreflightWithKeys,
  mockSyncPackageDetails,
  mockPackageDetails,
  mockNewsResponse,
  mockNewsResponseEmpty,
  mockServicesStatus,
  mockServicesStatusMixed,
  mockServicesStatusWithServices,
  createMockStreamingProcess,
} from "../test/mocks";

const SYNC_TIMES = {
  last_sync_at: mockUpdatesResponse.last_sync_at,
  oldest_database_at: mockUpdatesResponse.oldest_database_at,
};

const systemChange = vi.hoisted(() => {
  const listeners = new Set<{ listener: (kind: "system" | "sync") => void; kinds: ("system" | "sync")[] }>();
  return {
    listeners,
    subscribe: (listener: (kind: "system" | "sync") => void, kinds: ("system" | "sync")[] = ["system", "sync"]) => {
      const entry = { listener, kinds };
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
  };
});

function emitSystemChange(kind: "system" | "sync" = "system") {
  for (const { listener, kinds } of [...systemChange.listeners]) {
    if (kinds.includes(kind)) listener(kind);
  }
}

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    onSystemChanged: systemChange.subscribe,
    checkUpdates: vi.fn(),
    preflightUpgrade: vi.fn(),
    runUpgrade: vi.fn(),
    syncDatabase: vi.fn(),
    getSyncPackageInfo: vi.fn(),
    getPackageInfo: vi.fn(),
    listIgnoredPackages: vi.fn(),
    getRebootStatus: vi.fn(),
    getServicesStatus: vi.fn(),
    restartServices: vi.fn(),
    listOrphans: vi.fn(),
    getCacheInfo: vi.fn(),
    getSettings: vi.fn(),
    previewCacheCleanup: vi.fn(),
    getKeyringStatus: vi.fn(),
    fetchNews: vi.fn(),
    checkSecurity: vi.fn(),
    setSecurityAdvisories: vi.fn(),
    getNewsReadState: vi.fn(),
    markNewsRead: vi.fn(),
    markNewsUnread: vi.fn(),
    servicesDismissal: { get: vi.fn(), mark: vi.fn(), restore: vi.fn() },
    rebootDismissal: { get: vi.fn(), mark: vi.fn(), restore: vi.fn() },
    scheduledDismissal: { get: vi.fn(), mark: vi.fn(), restore: vi.fn() },
    pacnewDismissal: { get: vi.fn(), mark: vi.fn(), restore: vi.fn() },
    getPacnewStatus: vi.fn(),
    getScheduledRuns: vi.fn(),
    getScheduleConfig: vi.fn(),
    setScheduleConfig: vi.fn(),
    checkLock: vi.fn(),
    removeStaleLock: vi.fn(),
    addIgnoredPackage: vi.fn(),
    removeIgnoredPackage: vi.fn(),
    rebootSystem: vi.fn(),
    getSignoffList: vi.fn(),
    previewRemoveOrphans: vi.fn(),
    removeOrphans: vi.fn(actual.removeOrphans),
    cleanCache: vi.fn(actual.cleanCache),
  };
});

const mockCheckUpdates = vi.mocked(api.checkUpdates);
const mockPreflightUpgrade = vi.mocked(api.preflightUpgrade);
const mockRunUpgrade = vi.mocked(api.runUpgrade);
const mockSyncDatabase = vi.mocked(api.syncDatabase);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);
const mockGetPackageInfo = vi.mocked(api.getPackageInfo);
const mockListIgnoredPackages = vi.mocked(api.listIgnoredPackages);
const mockGetRebootStatus = vi.mocked(api.getRebootStatus);
const mockGetServicesStatus = vi.mocked(api.getServicesStatus);
const mockRestartServices = vi.mocked(api.restartServices);
const mockListOrphans = vi.mocked(api.listOrphans);
const mockGetCacheInfo = vi.mocked(api.getCacheInfo);
const mockGetKeyringStatus = vi.mocked(api.getKeyringStatus);
const mockFetchNews = vi.mocked(api.fetchNews);
const mockCheckSecurity = vi.mocked(api.checkSecurity);
const mockCheckLock = vi.mocked(api.checkLock);
const mockRemoveStaleLock = vi.mocked(api.removeStaleLock);
const mockAddIgnoredPackage = vi.mocked(api.addIgnoredPackage);
const mockRemoveIgnoredPackage = vi.mocked(api.removeIgnoredPackage);
const mockGetNewsReadState = vi.mocked(api.getNewsReadState);
const mockMarkNewsRead = vi.mocked(api.markNewsRead);
const mockMarkNewsUnread = vi.mocked(api.markNewsUnread);
const mockRestoreReboot = vi.mocked(api.rebootDismissal.restore);
const mockRestorePacnew = vi.mocked(api.pacnewDismissal.restore);
const mockGetServicesDismissal = vi.mocked(api.servicesDismissal.get);
const mockMarkServicesDismissed = vi.mocked(api.servicesDismissal.mark);
const mockGetRebootDismissal = vi.mocked(api.rebootDismissal.get);
const mockMarkRebootDismissed = vi.mocked(api.rebootDismissal.mark);
const mockGetScheduledRuns = vi.mocked(api.getScheduledRuns);
const mockGetScheduleConfig = vi.mocked(api.getScheduleConfig);
const mockGetScheduledDismissal = vi.mocked(api.scheduledDismissal.get);
const mockMarkScheduledDismissed = vi.mocked(api.scheduledDismissal.mark);
const mockGetPacnewStatus = vi.mocked(api.getPacnewStatus);
const mockGetPacnewDismissal = vi.mocked(api.pacnewDismissal.get);
const mockMarkPacnewDismissed = vi.mocked(api.pacnewDismissal.mark);
const mockRebootSystem = vi.mocked(api.rebootSystem);
const mockGetSignoffList = vi.mocked(api.getSignoffList);

const visibilityListeners = new Set<() => void>();

function setHidden(hidden: boolean, notify = true) {
  Object.defineProperty(cockpit, "hidden", { value: hidden, configurable: true, writable: true });
  if (notify) for (const l of [...visibilityListeners]) l();
}

function trackVisibilityListeners() {
  const add = cockpit.addEventListener;
  const remove = cockpit.removeEventListener;
  vi.spyOn(cockpit, "addEventListener").mockImplementation((event, handler) => {
    if (event === "visibilitychange") visibilityListeners.add(handler);
    else add(event, handler);
  });
  vi.spyOn(cockpit, "removeEventListener").mockImplementation((event, handler) => {
    if (event === "visibilitychange") visibilityListeners.delete(handler);
    else remove(event, handler);
  });
}

type PermissionListener = () => void;

let permissionListeners: PermissionListener[] = [];
let permissionAllowed: boolean | null = true;

function setPermission(allowed: boolean | null) {
  permissionAllowed = allowed;
  permissionListeners = [];
  mockPermission.mockImplementation(() => {
    const handle = {
      get allowed() { return permissionAllowed; },
      addEventListener: vi.fn((_event: string, listener: PermissionListener) => { permissionListeners.push(listener); }),
      removeEventListener: vi.fn((_event: string, listener: PermissionListener) => {
        permissionListeners = permissionListeners.filter((l) => l !== listener);
      }),
      close: vi.fn(),
    };
    return handle as unknown as ReturnType<typeof mockPermission>;
  });
}

function changePermission(allowed: boolean | null) {
  permissionAllowed = allowed;
  for (const listener of [...permissionListeners]) listener();
}

describe("UpdatesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const value of Object.values(api)) {
      if (vi.isMockFunction(value)) value.mockReset();
    }
    window.localStorage.clear();
    mockCheckUpdates.mockResolvedValue(mockUpdatesResponse);
    mockPreflightUpgrade.mockResolvedValue(mockPreflightResponse);
    mockGetSyncPackageInfo.mockResolvedValue(mockSyncPackageDetails);
    mockGetPackageInfo.mockResolvedValue(mockPackageDetails);
    mockListIgnoredPackages.mockResolvedValue({ packages: [], total: 0 });
    mockGetRebootStatus.mockResolvedValue({
      requires_reboot: false,
      reason: "none",
      running_kernel: null,
      installed_kernel: null,
      kernel_package: null,
      updated_packages: [],
    });
    mockGetServicesStatus.mockResolvedValue(mockServicesStatus);
    mockRestartServices.mockResolvedValue(undefined);
    mockListOrphans.mockResolvedValue({ orphans: [], total_size: 0 });
    vi.mocked(api.previewCacheCleanup).mockResolvedValue({ files: 0, bytes: 0 });
    mockGetCacheInfo.mockResolvedValue({
      total_size: 1024 * 1024 * 1024,
      package_count: 100,
      groups: [], total: 0, unique_packages: 0, multi_version_packages: 0,
      path: "/var/cache/pacman/pkg",
    });
    mockGetKeyringStatus.mockResolvedValue({
      keys: [],
      total: 10,
      master_key_initialized: true,
      status: "ready",
      warnings: [],
    });
    mockFetchNews.mockResolvedValue(mockNewsResponseEmpty);
    mockCheckSecurity.mockResolvedValue({ advisories: [] });
    vi.mocked(api.getSettings).mockResolvedValue({ security_advisories: true });
    mockCheckLock.mockResolvedValue({ locked: true, stale: true, lock_path: "/var/lib/pacman/db.lck", holder_unknown: false });
    mockRemoveStaleLock.mockResolvedValue({ removed: true });
    mockAddIgnoredPackage.mockResolvedValue({ success: true, package: "linux", message: "Package ignored" });
    mockRemoveIgnoredPackage.mockResolvedValue({ success: true, package: "linux", message: "Package removed" });
    mockGetNewsReadState.mockResolvedValue({ dismissed: [] });
    mockMarkNewsRead.mockResolvedValue(undefined);
    mockMarkNewsUnread.mockResolvedValue(undefined);
    mockRestoreReboot.mockResolvedValue(undefined);
    mockRestorePacnew.mockResolvedValue(undefined);
    mockGetServicesDismissal.mockResolvedValue({ signature: null });
    mockMarkServicesDismissed.mockResolvedValue(undefined);
    mockGetRebootDismissal.mockResolvedValue({ signature: null });
    mockMarkRebootDismissed.mockResolvedValue(undefined);
    mockGetScheduledRuns.mockResolvedValue({ runs: [], total: 0 });
    mockGetScheduledDismissal.mockResolvedValue({ signature: null });
    mockMarkScheduledDismissed.mockResolvedValue(undefined);
    mockGetPacnewStatus.mockResolvedValue({ has_pacnew: false, files: [] });
    mockGetPacnewDismissal.mockResolvedValue({ signature: null });
    mockMarkPacnewDismissed.mockResolvedValue(undefined);
    mockRunUpgrade.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    mockSyncDatabase.mockImplementation((callbacks) => {
      setTimeout(() => callbacks.onComplete(), 0);
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
  });

  afterEach(() => {
    cleanup();
    setPermission(true);
  });

  describe("Initial Load", () => {
    it("shows loading spinner while checking for updates", async () => {
      mockCheckUpdates.mockImplementation(() => new Promise(() => {}));
      render(<UpdatesView />);
      expect(await screen.findByText("Querying package databases…")).toBeInTheDocument();
    });

    it("calls checkUpdates on initial load", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(mockCheckUpdates).toHaveBeenCalled();
      });
    });

    it("displays available updates after loading", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      expect(screen.getByText(/6\.7\.0-arch1-1.*6\.7\.1-arch1-1/)).toBeInTheDocument();
    });

    it("names each row checkbox after its package and describes a held row", async () => {
      const glibc = { ...mockUpdatesResponse.updates[0], name: "glibc" };
      const held = { ...mockUpdatesResponse.updates[0], name: "held", ignored: true };
      mockCheckUpdates.mockResolvedValue({ updates: [mockUpdatesResponse.updates[0], glibc, held], warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await screen.findByRole("button", { name: "glibc" });

      expect(screen.getAllByRole("checkbox", { name: "Select glibc" })).toHaveLength(1);
      expect(screen.getAllByRole("checkbox", { name: "Select linux" })).toHaveLength(1);
      const heldBox = screen.getByRole("checkbox", { name: "Select held" });
      expect(heldBox).toBeDisabled();
      expect(heldBox).toHaveAccessibleDescription("Ignored during upgrades");
      expect(screen.getByRole("checkbox", { name: "Select all 2 updates" })).toBeInTheDocument();
      const rows = screen.getAllByRole("checkbox").filter((b) => b.closest("tbody"));
      expect(new Set(rows.map((b) => b.getAttribute("name"))).size).toBe(rows.length);
      expect(screen.queryAllByRole("checkbox", { name: /^Select row \d+$/ })).toHaveLength(0);

      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select glibc" }));
      });
      expect(screen.getByRole("checkbox", { name: "Select glibc" })).not.toBeChecked();
      expect(screen.queryByRole("region", { name: /^glibc/ })).not.toBeInTheDocument();
      sweepA11y();
    });

    it("passes the a11y sweep on the update list", async () => {
      render(<UpdatesView />);
      await screen.findByRole("button", { name: /Apply 1 update/ });
      sweepA11y();
    });

    it("shows up to date message when no updates available", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      });
    });
  });

  describe("Pagination", () => {
    const makeUpdates = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `pgpkg${String(i).padStart(4, "0")}`,
        current_version: "1.0.0-1",
        new_version: "1.0.1-1",
        download_size: 1000,
        current_size: 2000,
        new_size: 2000,
        repository: "core",
        ignored: false,
      }));

    it.each([
      [1, "1 update available"],
      [1000, "1,000 updates available"],
    ])("publishes a grouped count in the page status for %i updates", async (n, title) => {
      mockCheckUpdates.mockResolvedValue({ updates: makeUpdates(n), warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await waitFor(() => expect(mockTransportControl).toHaveBeenCalledWith("notify", {
        page_status: { type: "info", title, details: { pficon: "enhancement" } },
      }));
    });

    it("renders only the first page (50) and pages to the rest", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: makeUpdates(60), warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await waitFor(() => expect(screen.getByText("pgpkg0000")).toBeInTheDocument());

      expect(screen.queryByText("pgpkg0055")).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Go to next page"));
      });

      await waitFor(() => expect(screen.getByText("pgpkg0055")).toBeInTheDocument());
      expect(screen.queryByText("pgpkg0000")).not.toBeInTheDocument();
    });

    it("select-all selects the full set, not just the visible page", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: makeUpdates(60), warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      // Selection auto-initializes to all 60 even though only 50 rows render.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Apply 60 updates/ })).toBeInTheDocument()
      );

      const selectAll = screen.getByLabelText(/^Select all \d+ updates?$/);
      await act(async () => { fireEvent.click(selectAll); });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Apply 0 updates/ })).toBeInTheDocument()
      );

      await act(async () => { fireEvent.click(selectAll); });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Apply 60 updates/ })).toBeInTheDocument()
      );
    });

    it("resets to page 1 when the filter changes", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: makeUpdates(60), warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await waitFor(() => expect(screen.getByText("pgpkg0000")).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Go to next page"));
      });
      await waitFor(() => expect(screen.getByText("pgpkg0055")).toBeInTheDocument());

      const search = screen.getByLabelText("Filter updates");
      await act(async () => {
        fireEvent.change(search, { target: { value: "pgpkg000" } });
      });

      // Back on page 1 of the filtered set (pgpkg0000..0009).
      await waitFor(() => expect(screen.getByText("pgpkg0000")).toBeInTheDocument());
      expect(screen.queryByText("pgpkg0055")).not.toBeInTheDocument();
    });
  });

  describe("Overview Health page_status", () => {
    const notifyCalls = () =>
      mockTransportControl.mock.calls.filter(([command]) => command === "notify");

    it("publishes 'up to date' when checkUpdates returns no updates", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await waitFor(() => {
        expect(
          notifyCalls().some(([, payload]) => {
            const status = (payload as { page_status?: { title?: string } }).page_status;
            return status?.title?.startsWith("No updates when last checked");
          }),
        ).toBe(true);
      });
    });

    it("publishes update count when updates are available", async () => {
      mockCheckUpdates.mockResolvedValue({
        updates: [
          mockUpdatesResponse.updates[0],
          { ...mockUpdatesResponse.updates[0], name: "glibc" },
          { ...mockUpdatesResponse.updates[0], name: "curl" },
        ],
        warnings: [],
        ...SYNC_TIMES,
      });
      render(<UpdatesView />);
      await waitFor(() => {
        expect(
          notifyCalls().some(([, payload]) => {
            const status = (payload as { page_status?: { type?: string; title?: string } }).page_status;
            return status?.type === "info" && status?.title === "3 updates available";
          }),
        ).toBe(true);
      });
    });

    it("publishes error status when checkUpdates throws", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("backend offline"));
      render(<UpdatesView />);
      await waitFor(() => {
        expect(
          notifyCalls().some(([, payload]) => {
            const status = (payload as { page_status?: { type?: string; title?: string } }).page_status;
            return (
              status?.type === "error" &&
              status?.title === "Failed to check for package updates"
            );
          }),
        ).toBe(true);
      });
    });

    it("error payload never leaks exception message", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("secret internal detail"));
      render(<UpdatesView />);
      await waitFor(() => {
        expect(notifyCalls().length).toBeGreaterThan(0);
      });
      for (const [, payload] of notifyCalls()) {
        const status = (payload as { page_status?: { title?: string } }).page_status;
        if (status?.title) {
          expect(status.title).not.toContain("secret internal detail");
        }
      }
    });
  });

  describe("Refresh Button", () => {
    it("triggers database sync when clicking refresh", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const refreshButton = screen.getByRole("button", { name: /Refresh/i });
      await act(async () => {
        fireEvent.click(refreshButton);
      });

      expect(mockSyncDatabase).toHaveBeenCalled();
    });
  });

  describe("Package Selection", () => {
    it("all packages are selected by default", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
    });

    it("deselecting a package shows partial upgrade warning", async () => {
      const multiUpdateResponse = {
        updates: [
          ...mockUpdatesResponse.updates,
          {
            name: "glibc",
            current_version: "2.38-1",
            new_version: "2.39-1",
            download_size: 50000000,
            current_size: 45000000,
            new_size: 48000000,
            ignored: false,
            repository: "core",
          },
        ],
        warnings: [],
        ...SYNC_TIMES,
      };
      mockCheckUpdates.mockResolvedValue(multiUpdateResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select linux" }));
      });

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /Partial upgrade/ })).toBeInTheDocument();
      });
    });

    it("select all checkbox toggles all packages", async () => {
      const multiUpdateResponse = {
        updates: [
          ...mockUpdatesResponse.updates,
          {
            name: "glibc",
            current_version: "2.38-1",
            new_version: "2.39-1",
            download_size: 50000000,
            current_size: 45000000,
            new_size: 48000000,
            ignored: false,
            repository: "core",
          },
        ],
        warnings: [],
        ...SYNC_TIMES,
      };
      mockCheckUpdates.mockResolvedValue(multiUpdateResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/2 of 2 update/)).toBeInTheDocument();
      });

      const selectAllCheckbox = screen.getByLabelText(/^Select all \d+ updates?$/);
      await act(async () => {
        fireEvent.click(selectAllCheckbox);
      });

      await waitFor(() => {
        expect(screen.getByText(/0 of 2 update/)).toBeInTheDocument();
      });
    });
  });

  describe("Apply Updates Flow", () => {
    it("runs preflight check before applying updates", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      expect(mockPreflightUpgrade).toHaveBeenCalled();
    });

    it("starts upgrade directly when no conflicts", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({ type: "complete", success: true });
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(mockRunUpgrade).toHaveBeenCalled();
      });
    });

    it("shows confirmation modal when conflicts exist", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithConflicts);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: /^Upgrade \d+ packages?\?$/ })).toBeInTheDocument();
      });
      expect(screen.getByText(/mesa conflicts with mesa-amber/)).toBeInTheDocument();
    });

    it("shows key import warning in confirmation modal", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithKeys);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: /^Upgrade \d+ packages?\?$/ })).toBeInTheDocument();
      });
      expect(screen.getByText("Test Packager <test@arch.org> (ABCD1234)")).toBeInTheDocument();
      const commit = screen.getByRole("button", { name: "Upgrade 1 package" });
      expect(commit).toHaveAttribute("aria-disabled", "true");
      expect(screen.queryByRole("checkbox", { name: "Import key for Test Packager <test@arch.org>" })).not.toBeInTheDocument();
      fireEvent.click(commit);
      expect(mockRunUpgrade).not.toHaveBeenCalled();
    });

    it("copies one line per selected update from the confirmation modal", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
      mockCheckUpdates.mockResolvedValue({
        updates: [
          mockUpdatesResponse.updates[0],
          { ...mockUpdatesResponse.updates[0], name: "glibc", current_version: "2.38-1", new_version: "2.39-1" },
        ],
        warnings: [],
        ...SYNC_TIMES,
      });
      mockPreflightUpgrade.mockResolvedValue({ ...mockPreflightWithKeys, packages_to_upgrade: 2 });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Apply 2 updates/i })).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 2 updates/i }));
      });
      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: /^Upgrade \d+ packages?\?$/ })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy transaction" }));
      });

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0].split("\n")).toEqual([
        "linux 6.7.0-arch1-1 -> 6.7.1-arch1-1",
        "glibc 2.38-1 -> 2.39-1",
      ]);
    });

    it("requires the acknowledgement again after the modal is dismissed and reopened", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithConflicts);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const open = async () => {
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
        });
        await waitFor(() => {
          expect(screen.getByRole("dialog", { name: /^Upgrade \d+ packages?\?$/ })).toBeInTheDocument();
        });
      };

      await open();
      const acknowledge = () =>
        screen.getByRole("checkbox", { name: "Resolve the conflict of mesa with mesa-amber" }) as HTMLInputElement;
      await act(async () => {
        fireEvent.click(acknowledge());
      });
      expect(screen.getByRole("button", { name: /^Upgrade \d+ packages?( and remove \d+)?$/ })).not.toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
      });
      await open();

      expect(acknowledge().checked).toBe(false);
      expect(screen.getByRole("button", { name: /^Upgrade \d+ packages?( and remove \d+)?$/ })).toHaveAttribute("aria-disabled", "true");
    });

    it("proceeds with upgrade after confirming modal", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithConflicts);
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: /^Upgrade \d+ packages?\?$/ })).toBeInTheDocument();
      });

      // The proceed button should be disabled until acknowledgment checkbox is checked
      const proceedButton = screen.getByRole("button", { name: /^Upgrade \d+ packages?( and remove \d+)?$/ });
      expect(proceedButton).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Resolve the conflict of mesa with mesa-amber" }));
      });

      expect(proceedButton).not.toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        fireEvent.click(proceedButton);
      });

      expect(mockRunUpgrade).toHaveBeenCalled();
    });
  });

  describe("Upgrade Progress", () => {
    it("disables Apply and Refresh while another tab's transaction runs", async () => {
      const clean = createMockStreamingProcess();
      mockSpawn.mockReturnValueOnce(clean);
      act(() => {
        api.cleanCache({ onComplete: vi.fn(), onError: vi.fn() }, 1);
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const apply = screen.getByRole("button", { name: /Apply 1 update/i });
      expect(apply).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        fireEvent.click(apply);
        apply.focus();
      });
      expect(mockPreflightUpgrade).not.toHaveBeenCalled();
      expect(await screen.findByRole("tooltip")).toHaveTextContent("A cache clean is running.");

      act(() => {
        clean._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
        clean._complete();
      });
      expect(screen.getByRole("button", { name: /Apply 1 update/i })).not.toHaveAttribute("aria-disabled");
    });

    it("keeps focus on Apply while the registry and permission flip", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
      const apply = screen.getByRole("button", { name: /Apply 1 update/i });
      act(() => apply.focus());

      const clean = createMockStreamingProcess();
      mockSpawn.mockReturnValueOnce(clean);
      act(() => {
        api.cleanCache({ onComplete: vi.fn(), onError: vi.fn() }, 1);
      });
      expect(apply).toHaveAttribute("aria-disabled", "true");
      expect(apply).toHaveAccessibleDescription("A cache clean is running.");
      expect(document.activeElement).toBe(apply);

      act(() => {
        clean._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
        clean._complete();
      });
      expect(apply).not.toHaveAttribute("aria-disabled");
      expect(document.activeElement).toBe(apply);

      act(() => changePermission(null));
      expect(apply).toHaveAccessibleDescription("Checking administrative access…");
      expect(document.activeElement).toBe(apply);
      await act(async () => changePermission(true));
      expect(apply).not.toHaveAttribute("aria-disabled");
      expect(screen.getByRole("button", { name: /Apply 1 update/i })).toBe(apply);
      expect(document.activeElement).toBe(apply);
    });

    it.each([
      ["with updates", mockUpdatesResponse, /1 of 1 update/],
      ["up to date", { updates: [], warnings: [], ...SYNC_TIMES }, /No updates when last checked/],
    ])("gates Manage Schedule while permission is checked (%s)", async (_label, response, ready) => {
      setPermission(true);
      mockCheckUpdates.mockResolvedValue(response as typeof mockUpdatesResponse);
      render(<UpdatesView />);
      expect(await screen.findByText(ready)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Manage Schedule" })).not.toHaveAttribute("aria-disabled");

      act(() => changePermission(null));
      const pending = screen.getByRole("button", { name: "Manage Schedule" });
      expect(pending).toHaveAttribute("aria-disabled", "true");
      expect(pending).toHaveAccessibleDescription("Checking administrative access…");
      fireEvent.click(pending);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("names the missing selection on Apply", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
      await act(async () => { fireEvent.click(screen.getByLabelText(/^Select all \d+ updates?$/)); });
      const apply = screen.getByRole("button", { name: /Apply 0 updates/ });
      expect(apply).toHaveAttribute("aria-disabled", "true");
      expect(apply).toHaveAccessibleDescription("Select at least one update");
      await act(async () => {
        fireEvent.click(apply);
        apply.focus();
      });
      expect(mockPreflightUpgrade).not.toHaveBeenCalled();
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Select at least one update");
    });

    it("warns before leaving while its upgrade is applying", async () => {
      mockRunUpgrade.mockImplementation(() => ({ cancel: vi.fn(), forceStop: vi.fn() }));
      const addListener = vi.spyOn(window, "addEventListener");

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });

      expect(addListener.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
      addListener.mockRestore();
    });

    it("shows progress during download phase", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({
            type: "download",
            filename: "linux-6.7.1-arch1-1.pkg.tar.zst",
            event: "progress",
            downloaded: 50000000,
            total: 150000000,
          });
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText("Downloading packages")).toBeInTheDocument();
      });
    });

    it("shows progress during install phase", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({
            type: "progress",
            operation: "upgrade_start",
            package: "linux",
            percent: 50,
            current: 1,
            total: 1,
          });
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText("Upgrading packages")).toBeInTheDocument();
      });
    });
    it("keeps aria-valuenow non-decreasing across phases", async () => {
      let upgradeCallbacks: api.UpgradeCallbacks | undefined;
      mockRunUpgrade.mockImplementation((callbacks) => {
        upgradeCallbacks = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      await waitFor(() => expect(upgradeCallbacks).toBeDefined());

      const file = "linux-6.7.1-arch1-1-x86_64.pkg.tar.zst";
      const events: api.StreamEvent[] = [
        { type: "download", filename: file, event: "progress", downloaded: 75000000, total: 150000000 },
        { type: "download", filename: file, event: "completed", total: 150000000 },
        { type: "progress", operation: "integrity_start", package: "", percent: 100, current: 1, total: 1 },
        { type: "event", event: "transaction_start" },
        { type: "progress", operation: "upgrade_start", package: "linux", percent: 0, current: 1, total: 1 },
        { type: "progress", operation: "upgrade_start", package: "linux", percent: 100, current: 1, total: 1 },
        { type: "event", event: "transaction_done" },
        { type: "event", event: "hook_run_start", package: "mkinitcpio", current: 1, total: 2 },
        { type: "event", event: "hook_run_done", package: "mkinitcpio", current: 1, total: 2 },
      ];
      const seen: number[] = [];
      for (const event of events) {
        act(() => upgradeCallbacks?.onEvent?.(event));
        const bar = screen.getByRole("progressbar", { name: "Upgrade progress" });
        seen.push(Number(bar.getAttribute("aria-valuenow") ?? 0));
      }
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
      }
      expect(seen[0]).toBe(20);
      expect(seen[seen.length - 1]).toBe(97);
      expect(screen.getByRole("progressbar", { name: "Upgrade progress" }))
        .toHaveAttribute("aria-valuetext", "97 percent, Running post-transaction hooks, Running hook 1 of 2");
    });
  });

  describe("Cancel upgrade", () => {
    it("shows cancel confirmation modal", async () => {
      mockRunUpgrade.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });

      const cancelButton = screen.getByRole("button", { name: "Cancel" });
      await act(async () => {
        fireEvent.click(cancelButton);
      });

      expect(screen.getByText("Cancel upgrade?")).toBeInTheDocument();
      sweepA11y({ dialogs: [/Cancel upgrade\?$/] });
    });

    it("calls cancel function when confirmed", async () => {
      const cancelFn = vi.fn();
      mockRunUpgrade.mockReturnValue({ cancel: cancelFn, forceStop: cancelFn });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });

      const cancelButton = screen.getByRole("button", { name: "Cancel" });
      await act(async () => {
        fireEvent.click(cancelButton);
      });

      const confirmCancelButton = screen.getByRole("button", { name: /Cancel Upgrade/i });
      await act(async () => {
        fireEvent.click(confirmCancelButton);
      });

      expect(cancelFn).toHaveBeenCalled();
    });

    it("stays in applying with a cancelling banner until the backend confirms", async () => {
      const cancelFn = vi.fn();
      const forceStopFn = vi.fn();
      mockRunUpgrade.mockReturnValue({ cancel: cancelFn, forceStop: forceStopFn });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Cancel Upgrade/i }));
      });

      expect(cancelFn).toHaveBeenCalled();
      expect(screen.getByText("Applying updates")).toBeInTheDocument();
      expect(screen.getByText(/Cancellation requested:/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Force stop" })).not.toBeInTheDocument();
      expect(forceStopFn).not.toHaveBeenCalled();
    });

    it("shows the stopped outcome and refetches when the cancelled upgrade aborts", async () => {
      let upgradeCallbacks: api.UpgradeCallbacks | undefined;
      mockRunUpgrade.mockImplementation((callbacks) => {
        upgradeCallbacks = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
      const checksBeforeCancel = mockCheckUpdates.mock.calls.length;

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Cancel Upgrade/i }));
      });

      await act(async () => {
        upgradeCallbacks?.onError("BACKEND_TERMINAL_DETAIL", "cancelled");
      });

      await waitFor(() => {
        expect(screen.getByText(/BACKEND_TERMINAL_DETAIL/)).toBeInTheDocument();
      });
      expect(mockCheckUpdates.mock.calls.length).toBeGreaterThan(checksBeforeCancel);
      expect(screen.queryByText(/Failed to/)).not.toBeInTheDocument();
    });

    it("does not claim a package count after a cancel", async () => {
      let upgradeCallbacks: api.UpgradeCallbacks | undefined;
      mockRunUpgrade.mockImplementation((callbacks) => {
        upgradeCallbacks = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });

      await act(async () => {
        upgradeCallbacks?.onEvent?.({
          type: "progress", operation: "upgrade_start", package: "linux",
          percent: 100, current: 1, total: 1,
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Request cancellation" }));
      });
      await act(async () => {
        upgradeCallbacks?.onError("Operation interrupted", "cancelled");
      });

      await waitFor(() => {
        expect(screen.getByText(/Upgrade cancelled/)).toBeInTheDocument();
      });
      expect(screen.queryByText(/were updated before stopping/)).not.toBeInTheDocument();
    });

    it("shows the finished outcome when the upgrade completes despite the cancel", async () => {
      let upgradeCallbacks: api.UpgradeCallbacks | undefined;
      mockRunUpgrade.mockImplementation((callbacks) => {
        upgradeCallbacks = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      await waitFor(() => {
        expect(screen.getByText("Applying updates")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Cancel Upgrade/i }));
      });

      await act(async () => {
        upgradeCallbacks?.onComplete();
      });

      await waitFor(() => {
        expect(screen.getByText("System updated")).toBeInTheDocument();
      });
      expect(screen.getByText("Upgrade finished before the cancel took effect")).toBeInTheDocument();
    });
  });

  describe("Error States", () => {
    it("displays general error message", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Network error"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText(/Network error/)).toBeInTheDocument();
      });
    });

    it("displays lock error with stale lock recovery", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Unable to lock database"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText("Database is locked")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/stale lock file/)).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /Remove stale lock/ })).toBeInTheDocument();
    });

    it("displays lock error for transaction init failure", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Failed to initialize transaction: unable to lock database"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText("Database is locked")).toBeInTheDocument();
      });
    });

    it("shows active process when lock is not stale", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Unable to lock database"));
      mockCheckLock.mockResolvedValue({
        locked: true,
        stale: false,
        lock_path: "/var/lib/pacman/db.lck",
        holder_unknown: false,
        blocking_process: "pacman (pid 1234)",
      });
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText("Database is locked")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/pacman \(pid 1234\)/)).toBeInTheDocument();
      });
    });

    it("hides Resume while waiting on a live holder and names it once waiting stops", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Unable to lock database"));
      mockCheckLock.mockResolvedValue({
        locked: true,
        stale: false,
        lock_path: "/var/lib/pacman/db.lck",
        holder_unknown: false,
        blocking_process: "pacman (pid 1234)",
      });
      render(<UpdatesView />);

      const stop = await screen.findByRole("button", { name: "Stop waiting" });
      expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(stop);
      });

      expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
      expect(screen.getByText(/then\s+select Resume\./)).toBeInTheDocument();
    });

    it("does not offer removal when the holder could not be determined", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Unable to lock database"));
      mockCheckLock.mockResolvedValue({
        locked: true,
        stale: false,
        lock_path: "/var/lib/pacman/db.lck",
        holder_unknown: true,
      });
      render(<UpdatesView />);

      expect(
        await screen.findByText(/Could not determine whether the database lock/)
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Remove stale lock/ })).not.toBeInTheDocument();
    });

    it("does not offer removal when the lock check itself failed", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Unable to lock database"));
      mockCheckLock.mockRejectedValue(new Error("Not permitted"));
      render(<UpdatesView />);

      expect(
        await screen.findByText(/Could not determine whether the database lock/)
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Remove stale lock/ })).not.toBeInTheDocument();
    });

    it("auto-retries when lock is already cleared", async () => {
      mockCheckUpdates.mockRejectedValueOnce(new Error("Unable to lock database"));
      mockCheckUpdates.mockResolvedValueOnce(mockUpdatesResponse);
      mockCheckLock.mockResolvedValue({
        locked: false,
        stale: false,
        lock_path: "/var/lib/pacman/db.lck",
        holder_unknown: false,
      });
      render(<UpdatesView />);

      await waitFor(() => {
        expect(mockCheckUpdates).toHaveBeenCalledTimes(2);
      });
    });

    it("re-reads the list and confirms before resuming after a stale lock is removed", async () => {
      mockPreflightUpgrade.mockRejectedValueOnce(new Error("Unable to lock database"));

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      const removeButton = await screen.findByRole("button", { name: /Remove stale lock/ });
      await act(async () => {
        fireEvent.click(removeButton);
      });

      await waitFor(() => {
        expect(mockPreflightUpgrade).toHaveBeenCalledTimes(2);
      });
      expect(mockCheckUpdates).toHaveBeenCalledTimes(2);
      const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package?" });
      expect(mockRunUpgrade).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade 1 package" }));
      });
      expect(screen.getByText("Applying updates")).toBeInTheDocument();
    });

    it("says a transaction was interrupted once the retry it triggered settles", async () => {
      mockPreflightUpgrade.mockRejectedValueOnce(new Error("Unable to lock database"));
      let upgradeCallbacks: Parameters<typeof api.runUpgrade>[0] | undefined;
      mockRunUpgrade.mockImplementation((callbacks) => {
        upgradeCallbacks = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });

      const removeButton = await screen.findByRole("button", { name: /Remove stale lock/ });
      await act(async () => {
        fireEvent.click(removeButton);
      });
      const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package?" });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade 1 package" }));
      });

      expect(screen.getByText("Applying updates")).toBeInTheDocument();
      expect(screen.queryByText("Cleared a leftover database lock")).not.toBeInTheDocument();

      await act(async () => {
        upgradeCallbacks?.onComplete();
      });

      expect(
        await screen.findByText("Cleared a leftover database lock")
      ).toBeInTheDocument();
    });

    it("does not claim a lock was cleared when none was", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      expect(screen.queryByText("Cleared a leftover database lock")).not.toBeInTheDocument();
    });

    it("re-runs preflight before restarting an upgrade interrupted by a lock", async () => {
      mockRunUpgrade.mockImplementationOnce((callbacks) => {
        setTimeout(() => callbacks.onError("Failed to initialize transaction: unable to lock database"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      const removeButton = await screen.findByRole("button", { name: /Remove stale lock/ });
      await act(async () => {
        fireEvent.click(removeButton);
      });

      const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package?" });
      expect(mockPreflightUpgrade).toHaveBeenCalledTimes(2);
      expect(mockRunUpgrade).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade 1 package" }));
      });
      expect(mockRunUpgrade).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Applying updates")).toBeInTheDocument();
    });

    it("renders the confirm modal when the resumed preflight needs confirmation", async () => {
      // First upgrade attempt locks; the resumed preflight returns issues, so a
      // confirmation is required. The modal only renders outside the error state,
      // so this fails if the resume doesn't leave "error".
      mockRunUpgrade.mockImplementationOnce((callbacks) => {
        setTimeout(() => callbacks.onError("Failed to initialize transaction: unable to lock database"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      mockPreflightUpgrade.mockResolvedValueOnce(mockPreflightResponse);
      mockPreflightUpgrade.mockResolvedValueOnce(mockPreflightWithKeys);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });

      const removeButton = await screen.findByRole("button", { name: /Remove stale lock/ });
      await act(async () => {
        fireEvent.click(removeButton);
      });

      // The resumed preflight has key imports -> the confirmation dialog appears,
      // which only happens if we left the error state on resume.
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByText("Database is locked")).not.toBeInTheDocument();
    });

    it("re-runs the database sync after removing a stale lock", async () => {
      mockSyncDatabase.mockImplementationOnce((callbacks) => {
        setTimeout(() => callbacks.onError?.("unable to lock database"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: /Refresh/ }));

      const removeButton = await screen.findByRole("button", { name: /Remove stale lock/ });
      await act(async () => {
        fireEvent.click(removeButton);
      });

      await waitFor(() => {
        expect(mockSyncDatabase).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });
    });

    it("resumes the operation the lock removal belonged to, not the latest error", async () => {
      mockPreflightUpgrade.mockRejectedValueOnce(new Error("Unable to lock database"));
      let resolveRemove: ((value: { removed: boolean }) => void) | undefined;
      mockRemoveStaleLock.mockImplementation(
        () => new Promise((resolve) => { resolveRemove = resolve; })
      );

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });

      const removeButton = await screen.findByRole("button", { name: /Remove stale lock/ });
      await act(async () => {
        fireEvent.click(removeButton);
      });

      // While the removal is still in flight, a sync failure starts a new
      // error episode with a different origin.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
      });
      mockSyncDatabase.mockImplementationOnce((callbacks) => {
        setTimeout(() => callbacks.onError?.("unable to lock database"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
      });
      await screen.findByText("Database is locked");

      await act(async () => {
        resolveRemove?.({ removed: true });
      });

      await waitFor(() => {
        expect(mockPreflightUpgrade).toHaveBeenCalledTimes(2);
      });
      expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
    });

    it("stops auto-resuming when the failure is not a lock", async () => {
      mockCheckLock.mockResolvedValue({
        locked: false,
        stale: false,
        lock_path: "/var/lib/pacman/db.lck",
        holder_unknown: false,
      });
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onError("Failed to initialize transaction: invalid or corrupted database"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package?" }, { timeout: 3000 });
      expect(mockRunUpgrade).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade 1 package" }));
      });

      await waitFor(() => {
        expect(screen.getByText(/invalid or corrupted database/)).toBeInTheDocument();
      }, { timeout: 3000 });
      expect(mockRunUpgrade).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("heading", { name: "Upgrade failed" })).toBeInTheDocument();
      expect(screen.queryByText("Database is locked")).not.toBeInTheDocument();
    });

    it("resumes via the footer retry button during a lock error", async () => {
      mockPreflightUpgrade.mockRejectedValueOnce(new Error("Unable to lock database"));

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await screen.findByRole("button", { name: /Remove stale lock/ });
      const retryButton = screen.getByRole("button", { name: "Resume" });
      await act(async () => {
        fireEvent.click(retryButton);
      });

      await waitFor(() => {
        expect(mockPreflightUpgrade).toHaveBeenCalledTimes(2);
      });
      expect(mockCheckUpdates).toHaveBeenCalledTimes(2);
      expect(await screen.findByRole("dialog", { name: "Upgrade 1 package?" })).toBeInTheDocument();
    });

    it("shows the failure and does not resume when lock removal is refused", async () => {
      mockPreflightUpgrade.mockRejectedValue(new Error("Unable to lock database"));
      mockRemoveStaleLock.mockResolvedValue({ removed: false, error: "Database in use by pacman (pid 42)" });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      const removeButton = await screen.findByRole("button", { name: /Remove stale lock/ });
      await act(async () => {
        fireEvent.click(removeButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Database in use by pacman \(pid 42\)/)).toBeInTheDocument();
      });
      expect(mockPreflightUpgrade).toHaveBeenCalledTimes(1);
    });

    it("shows retry button on error", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Network error"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Retry check" })).toBeInTheDocument();
      });
    });

    it("retries loading when clicking retry button", async () => {
      mockCheckUpdates.mockRejectedValueOnce(new Error("Network error"));
      mockCheckUpdates.mockResolvedValueOnce(mockUpdatesResponse);

      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText(/Network error/)).toBeInTheDocument();
      });

      const retryButton = screen.getByRole("button", { name: "Retry check" });
      await act(async () => {
        fireEvent.click(retryButton);
      });

      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
    });

    it("shows status page link for network errors", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("failed to retrieve some files"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText("Can't reach Arch Linux services")).toBeInTheDocument();
      });
      expect(screen.getByText("Arch Linux status page")).toBeInTheDocument();
      expect(screen.getByText(/Check the host's network connection/)).toBeInTheDocument();
    });

    it("does not show status page link for non-network errors", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("corrupted database"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText(/corrupted database/)).toBeInTheDocument();
      });
      expect(screen.queryByText("Arch Linux status page")).not.toBeInTheDocument();
    });

    it("displays preflight error", async () => {
      mockPreflightUpgrade.mockResolvedValue({
        success: false,
        error: "Failed to calculate dependencies",
        packages_to_upgrade: 0,
        total_download_size: 0,
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to calculate dependencies/)).toBeInTheDocument();
      });
    });
  });

  describe("Success State", () => {
    it("shows success message after upgrade completes", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({ type: "complete", success: true });
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("System updated")).toBeInTheDocument();
      });
      expect(screen.getByText("Upgraded 1 package.")).toBeInTheDocument();
    });

    it("shows check again button after success", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("System updated")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    });
  });

  describe("Warnings Display", () => {
    it("displays warnings from checkUpdates response", async () => {
      mockCheckUpdates.mockResolvedValue({
        updates: mockUpdatesResponse.updates,
        warnings: ["Package foo has been replaced by bar"],
        ...SYNC_TIMES,
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      expect(screen.getByText(/Package foo has been replaced by bar/)).toBeInTheDocument();
    });
  });

  describe("Batch Upgrades", () => {
    const batchUpdatesResponse = {
      updates: [
        {
          name: "linux",
          current_version: "6.7.0-arch1-1",
          new_version: "6.7.1-arch1-1",
          download_size: 150000000,
          current_size: 142000000,
          new_size: 145000000,
          ignored: false,
          repository: "core",
        },
        {
          name: "glibc",
          current_version: "2.38-1",
          new_version: "2.39-1",
          download_size: 50000000,
          current_size: 45000000,
          new_size: 48000000,
          ignored: false,
          repository: "core",
        },
        {
          name: "systemd",
          current_version: "254-1",
          new_version: "255-1",
          download_size: 30000000,
          current_size: 28000000,
          new_size: 32000000,
          ignored: false,
          repository: "core",
        },
      ],
      warnings: [],
      ...SYNC_TIMES,
    };

    it("displays multiple packages in upgrade list", async () => {
      mockCheckUpdates.mockResolvedValue(batchUpdatesResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      expect(screen.getByText("glibc")).toBeInTheDocument();
      expect(screen.getByText("systemd")).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText(/3 of 3 update/)).toBeInTheDocument();
      });
    });

    it("tracks progress through multiple packages", async () => {
      mockCheckUpdates.mockResolvedValue(batchUpdatesResponse);
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({
            type: "progress",
            operation: "upgrade_start",
            package: "glibc",
            percent: 50,
            current: 2,
            total: 3,
          });
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = await waitFor(() => {
        return screen.getByRole("button", { name: /Apply 3 updates/i });
      });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Upgrading packages")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/glibc/)).toBeInTheDocument();
      });
    });
  });

  describe("Mid-upgrade Failures", () => {
    it("handles download failure gracefully", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({
            type: "download",
            filename: "linux-6.7.1-arch1-1.pkg.tar.zst",
            event: "progress",
            downloaded: 10000000,
            total: 150000000,
          });
          callbacks.onError("Failed to download linux-6.7.1-arch1-1.pkg.tar.zst: Connection timed out");
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to download/)).toBeInTheDocument();
      });
    });

    it("handles install failure during transaction", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({
            type: "progress",
            operation: "upgrade_start",
            package: "linux",
            percent: 50,
            current: 1,
            total: 1,
          });
          callbacks.onError("Failed to commit transaction: conflicting files");
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to commit transaction/)).toBeInTheDocument();
      });
    });

    it("handles hook failure", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({
            type: "event",
            event: "running post-transaction hooks",
            package: "linux",
          });
          callbacks.onError("Hook failed: mkinitcpio returned non-zero exit code");
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Hook failed/)).toBeInTheDocument();
      });
    });
  });

  describe("Timeout Handling", () => {
    it("handles backend timeout error", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onError("Operation timed out after 300s");
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/timed out/)).toBeInTheDocument();
      });
    });

    it("allows retry after timeout", async () => {
      let callCount = 0;
      mockRunUpgrade.mockImplementation((callbacks) => {
        callCount++;
        setTimeout(() => {
          if (callCount === 1) {
            callbacks.onError("Operation timed out after 300s");
          } else {
            callbacks.onComplete();
          }
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/timed out/)).toBeInTheDocument();
      });

      const retryButton = screen.getByRole("button", { name: "Retry upgrade" });
      await act(async () => {
        fireEvent.click(retryButton);
      });

      await waitFor(() => {
        expect(screen.getByText("System updated")).toBeInTheDocument();
      });
      expect(mockPreflightUpgrade).toHaveBeenCalledTimes(2);
      expect(mockRunUpgrade).toHaveBeenCalledTimes(2);
    });
  });

  describe("Sorting and Filtering", () => {
    const sortTestResponse = {
      updates: [
        {
          name: "aaa-package",
          current_version: "1.0-1",
          new_version: "1.1-1",
          download_size: 1000,
          current_size: 2000,
          new_size: 2500,
          ignored: false,
          repository: "extra",
        },
        {
          name: "zzz-package",
          current_version: "2.0-1",
          new_version: "2.1-1",
          download_size: 5000,
          current_size: 3000,
          new_size: 3500,
          ignored: false,
          repository: "core",
        },
      ],
      warnings: [],
      ...SYNC_TIMES,
    };

    it("filters updates by search term", async () => {
      mockCheckUpdates.mockResolvedValue(sortTestResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("aaa-package")).toBeInTheDocument();
      });
      expect(screen.getByText("zzz-package")).toBeInTheDocument();

      const searchInput = screen.getByPlaceholderText("Filter updates…");
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: "zzz" } });
      });

      await waitFor(() => {
        expect(screen.queryByText("aaa-package")).not.toBeInTheDocument();
      });
      expect(screen.getByText("zzz-package")).toBeInTheDocument();
    });

    it("filters updates by repository", async () => {
      mockCheckUpdates.mockResolvedValue(sortTestResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("aaa-package")).toBeInTheDocument();
      });

      const repoToggle = screen.getByRole("button", { name: /Filter by repository/i });
      await act(async () => {
        fireEvent.click(repoToggle);
      });

      const coreOption = screen.getByRole("option", { name: "core" });
      await act(async () => {
        fireEvent.click(coreOption);
      });

      await waitFor(() => {
        expect(screen.queryByText("aaa-package")).not.toBeInTheDocument();
      });
      expect(screen.getByText("zzz-package")).toBeInTheDocument();
    });
  });

  describe("Signoff tile", () => {
    const signoffGroup = (pkgbase: string, overrides: Partial<api.SignoffGroupWithLocal> = {}): api.SignoffGroupWithLocal => ({
      pkgbase, pkgnames: [pkgbase], version: "1.0-1", arch: "x86_64", repo: "core-testing", packager: "p",
      last_update: "2024-01-01T00:00:00Z", known_bad: false, approved: false, required: 2, enabled: true,
      signoffs: [], local_version: "1.0-1", version_match: "match", ...overrides,
    });
    const mine = [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: false }];
    const fixture: api.SignoffListResponse = {
      signoff_groups: [
        signoffGroup("counted"),
        signoffGroup("mismatch", { version_match: "mismatch", local_version: "0.9-1" }),
        signoffGroup("signed-by-me", { signoffs: mine }),
        signoffGroup("not-installed", { version_match: "not_installed", local_version: null }),
        signoffGroup("approved", { approved: true }),
        signoffGroup("bad", { known_bad: true }),
      ],
      total: 6,
    };
    const credentials = { username: "alice", password: "p" };
    const CountHost: React.FC = () => {
      const [count, setCount] = React.useState<number | null>(null);
      return <UpdatesView signoffCredentials={credentials} toSignOff={count} onToSignOffCount={setCount} />;
    };

    it("counts the rows the Signoffs tab shows for the filter it routes to", async () => {
      mockGetSignoffList.mockResolvedValue(fixture);
      const onViewSignoffs = vi.fn();
      render(
        <NavigationProvider value={{ onViewSignoffs }}>
          <CountHost />
        </NavigationProvider>,
      );

      const tile = await screen.findByRole("button", { name: "2 packages to sign off, view package signoffs" });
      fireEvent.click(tile);
      expect(onViewSignoffs).toHaveBeenCalledWith(SIGNOFF_TILE_FILTER);
      cleanup();

      render(<SignoffsView credentials={credentials} routeOptions={{ filter: SIGNOFF_TILE_FILTER }} />);
      await screen.findByRole("button", { name: "counted" });
      const rows = within(screen.getByLabelText("Signoff packages")).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(2);
    });
    it("shows the count it is given after a sign-off elsewhere", async () => {
      mockGetSignoffList.mockResolvedValue(fixture);
      const onToSignOffCount = vi.fn();
      const view = (toSignOff: number | null) => (
        <NavigationProvider value={{ onViewSignoffs: vi.fn() }}>
          <UpdatesView signoffCredentials={credentials} toSignOff={toSignOff} onToSignOffCount={onToSignOffCount} />
        </NavigationProvider>
      );
      const { rerender } = render(view(null));
      await waitFor(() => expect(onToSignOffCount).toHaveBeenCalledWith(2));
      rerender(view(1));

      expect(await screen.findByRole("button", { name: "1 package to sign off, view package signoffs" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /2 packages to sign off/ })).not.toBeInTheDocument();
      expect(mockGetSignoffList).toHaveBeenCalledTimes(1);
    });

    it("drops a signoff load that resolves after unmount", async () => {
      let resolve!: (res: api.SignoffListResponse) => void;
      mockGetSignoffList.mockReturnValue(new Promise((r) => { resolve = r; }));
      const onToSignOffCount = vi.fn();
      const { unmount } = render(
        <UpdatesView signoffCredentials={credentials} toSignOff={null} onToSignOffCount={onToSignOffCount} />,
      );
      await waitFor(() => expect(mockGetSignoffList).toHaveBeenCalled());
      unmount();
      await act(async () => resolve(fixture));

      expect(onToSignOffCount).not.toHaveBeenCalled();
    });
  });

  describe("Security tile filter", () => {
    const advisory = {
      package: "zzz-package",
      severity: "High",
      advisory_type: "security",
      avg_name: "AVG-1",
      cve_ids: ["CVE-1"],
      fixed_version: "1.1-1",
      fix_available: true,
      affected_version: "1.0-1",
      installed_version: "1.0-1",
      status: "Vulnerable",
    };

    const twoPackages = {
      updates: [
        { name: "aaa-package", current_version: "1.0-1", new_version: "1.1-1", download_size: 1000, current_size: 2000, new_size: 2500, ignored: false, repository: "extra" },
        { name: "zzz-package", current_version: "2.0-1", new_version: "2.1-1", download_size: 5000, current_size: 3000, new_size: 3500, ignored: false, repository: "core" },
      ],
      warnings: [],
      ...SYNC_TIMES,
    };

    const makeUpdates = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `pgpkg${String(i).padStart(4, "0")}`,
        current_version: "1.0.0-1",
        new_version: "1.0.1-1",
        download_size: 1000,
        current_size: 2000,
        new_size: 2000,
        repository: "core",
        ignored: false,
      }));

    it("filters the list to security updates when the tile is clicked", async () => {
      mockCheckUpdates.mockResolvedValue(twoPackages);
      mockCheckSecurity.mockResolvedValue({ advisories: [advisory] });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("aaa-package")).toBeInTheDocument();
      });

      const tile = await screen.findByRole("button", { name: "Filter to security updates" });
      await act(async () => {
        fireEvent.click(tile);
      });

      await waitFor(() => {
        expect(screen.queryByText("aaa-package")).not.toBeInTheDocument();
      });
      expect(screen.getByText("zzz-package")).toBeInTheDocument();
    });

    it("flips the tile to Show all while active and restores the list on a second click", async () => {
      mockCheckUpdates.mockResolvedValue(twoPackages);
      mockCheckSecurity.mockResolvedValue({ advisories: [advisory] });

      render(<UpdatesView />);
      const tile = await screen.findByRole("button", { name: "Filter to security updates" });
      await act(async () => {
        fireEvent.click(tile);
      });

      const activeTile = await screen.findByRole("button", { name: "Show all updates" });
      expect(within(activeTile).getByText("Show all")).toBeInTheDocument();
      expect(activeTile).toHaveAttribute("aria-pressed", "true");

      await act(async () => {
        fireEvent.click(activeTile);
      });

      await waitFor(() => {
        expect(screen.getByText("aaa-package")).toBeInTheDocument();
      });
      expect(screen.getByText("zzz-package")).toBeInTheDocument();
    });

    it("resets to page 1 when the security filter is toggled", async () => {
      const updates = makeUpdates(60);
      mockCheckUpdates.mockResolvedValue({ updates, warnings: [], ...SYNC_TIMES });
      mockCheckSecurity.mockResolvedValue({
        advisories: [{ ...advisory, package: updates[0].name }],
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(updates[0].name)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Go to next page"));
      });
      await waitFor(() => {
        expect(screen.queryByText(updates[0].name)).not.toBeInTheDocument();
      });

      const tile = await screen.findByRole("button", { name: "Filter to security updates" });
      await act(async () => {
        fireEvent.click(tile);
      });

      await waitFor(() => {
        expect(screen.getByText(updates[0].name)).toBeInTheDocument();
      });
    });

    it("is not interactive when there are no security updates", async () => {
      mockCheckUpdates.mockResolvedValue(twoPackages);
      mockCheckSecurity.mockResolvedValue({ advisories: [] });
    vi.mocked(api.getSettings).mockResolvedValue({ security_advisories: true });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("aaa-package")).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("button", { name: "Filter to security updates" })
      ).not.toBeInTheDocument();
    });

    it("does not count a tracker fix that configured repositories cannot supply", async () => {
      const onUpdateStatus = vi.fn();
      mockCheckUpdates.mockResolvedValue(twoPackages);
      mockCheckSecurity.mockResolvedValue({ advisories: [{ ...advisory, fix_available: false }] });
      render(<UpdatesView onUpdateStatus={onUpdateStatus} />);

      expect(await screen.findByText("Fix not offered")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Filter to security updates" })).not.toBeInTheDocument();
      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith({ count: 2, security: 0, failed: false }));
    });

    it("rechecks fix availability on quiet refresh and ignores an older advisory response", async () => {
      const onUpdateStatus = vi.fn();
      const available = { ...advisory, fixed_version: "3.0-1" };
      const withVersion = (version: string) => ({
        ...twoPackages,
        updates: twoPackages.updates.map(update => update.name === available.package
          ? { ...update, current_version: "1.0-1", new_version: version }
          : update),
      });
      mockCheckUpdates.mockResolvedValue(withVersion("3.0-1"));
      mockCheckSecurity.mockResolvedValue({ advisories: [available] });
      render(<UpdatesView onUpdateStatus={onUpdateStatus} />);
      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith({ count: 2, security: 1, failed: false }));
      const initialChecks = mockCheckSecurity.mock.calls.length;

      let finishOlder!: (response: api.SecurityResponse) => void;
      mockCheckSecurity.mockReturnValueOnce(new Promise(resolve => { finishOlder = resolve; }));
      mockCheckUpdates.mockResolvedValue(withVersion("3.1-1"));
      await act(async () => emitSystemChange());
      await waitFor(() => expect(mockCheckSecurity).toHaveBeenCalledTimes(initialChecks + 1));

      mockCheckSecurity.mockResolvedValue({ advisories: [{ ...available, fix_available: false }] });
      mockCheckUpdates.mockResolvedValue(withVersion("2.0-1"));
      await act(async () => emitSystemChange("sync"));
      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith({ count: 2, security: 0, failed: false }));
      expect(screen.getByText("Fix not offered")).toBeInTheDocument();

      await act(async () => finishOlder({ advisories: [available] }));
      expect(onUpdateStatus).toHaveBeenLastCalledWith({ count: 2, security: 0, failed: false });
      expect(screen.getByText("Fix not offered")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Filter to security updates" })).not.toBeInTheDocument();
      expect(mockCheckSecurity).toHaveBeenLastCalledWith(false);
      expect(mockSyncDatabase).not.toHaveBeenCalled();
    });

    it.each([true, false])("refreshes advisories after installed packages change without changing offered updates (active: %s)", async active => {
      mockCheckUpdates.mockResolvedValue(twoPackages);
      mockCheckSecurity.mockResolvedValue({ advisories: [{ ...advisory, package: "unoffered-vulnerable", fixed_version: null, fix_available: false }] });
      render(<TabActiveContext.Provider value={active}><UpdatesView /></TabActiveContext.Provider>);
      await waitFor(() => expect(mockCheckSecurity).toHaveBeenCalled());
      const checks = mockCheckSecurity.mock.calls.length;
      const reads = mockCheckUpdates.mock.calls.length;
      mockCheckSecurity.mockResolvedValue({ advisories: [] });
      await act(async () => emitSystemChange());
      await waitFor(() => expect(mockCheckUpdates).toHaveBeenCalledTimes(reads + 1));
      await waitFor(() => expect(mockCheckSecurity).toHaveBeenCalledTimes(checks + 1));
    });

    it("keeps advisories when a sync refresh offers the same versions", async () => {
      mockCheckUpdates.mockResolvedValue(twoPackages);
      mockCheckSecurity.mockResolvedValue({ advisories: [advisory] });
      render(<UpdatesView />);
      await waitFor(() => expect(mockCheckSecurity).toHaveBeenCalled());
      const checks = mockCheckSecurity.mock.calls.length;
      const reads = mockCheckUpdates.mock.calls.length;
      await act(async () => emitSystemChange("sync"));
      await waitFor(() => expect(mockCheckUpdates).toHaveBeenCalledTimes(reads + 1));
      expect(mockCheckSecurity).toHaveBeenCalledTimes(checks);
    });
  });

  describe("Advisory popover", () => {
    const advisory = {
      package: "zzz-package",
      severity: "High",
      advisory_type: "security",
      avg_name: "AVG-1",
      cve_ids: ["CVE-1"],
      fixed_version: "1.1-1",
      fix_available: true,
      affected_version: "1.0-1",
      installed_version: "1.0-1",
      status: "Vulnerable",
    };

    const onePackage = {
      updates: [
        { name: "zzz-package", current_version: "2.0-1", new_version: "2.1-1", download_size: 5000, current_size: 3000, new_size: 3500, ignored: false, repository: "core" },
      ],
      warnings: [],
      ...SYNC_TIMES,
    };

    it("does not open the package modal when an advisory link in the popover is clicked", async () => {
      mockCheckUpdates.mockResolvedValue(onePackage);
      mockCheckSecurity.mockResolvedValue({ advisories: [advisory] });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("zzz-package")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("High"));
      });

      const link = await screen.findByRole("link", { name: "AVG-1" });
      await act(async () => {
        fireEvent.click(link);
      });

      // The row's onRowClick (which opens the details modal via getPackageInfo)
      // must not fire when a link inside the portaled popover is clicked.
      expect(mockGetPackageInfo).not.toHaveBeenCalled();
    });

    const unresolved = {
      package: "zzz-package",
      severity: "High",
      advisory_type: "security",
      avg_name: "AVG-1879",
      cve_ids: ["CVE-2021-43976"],
      fixed_version: null,
      fix_available: false,
      affected_version: "5.15.8.arch1-1",
      installed_version: "7.1.8.arch1-3",
      status: "Vulnerable",
    };

    it("leaves an advisory with no recorded fix out of the security count", async () => {
      mockCheckUpdates.mockResolvedValue(onePackage);
      mockCheckSecurity.mockResolvedValue({ advisories: [unresolved] });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("zzz-package")).toBeInTheDocument();
      });

      expect(screen.getByText("No fix")).toBeInTheDocument();
      expect(screen.queryByText("High")).not.toBeInTheDocument();
    });

    it("shows both versions and the caveat for an advisory with no recorded fix", async () => {
      mockCheckUpdates.mockResolvedValue(onePackage);
      mockCheckSecurity.mockResolvedValue({ advisories: [unresolved] });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("zzz-package")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("No fix"));
      });

      expect(await screen.findByText("No fix recorded")).toBeInTheDocument();
      expect(
        screen.getByText(/filed against 5\.15\.8\.arch1-1, installed 7\.1\.8\.arch1-3/)
      ).toBeInTheDocument();
      expect(screen.getByText(/tracker lists no fixed version/)).toBeInTheDocument();
    });

    it("renders nothing about security when the feature is disabled", async () => {
      mockCheckUpdates.mockResolvedValue(onePackage);
      mockCheckSecurity.mockResolvedValue({ advisories: [], disabled: true });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("zzz-package")).toBeInTheDocument();
      });

      expect(screen.queryByText("No fix")).not.toBeInTheDocument();
      expect(screen.queryByText("High")).not.toBeInTheDocument();
    });

    it("hides the security tile when the feature is disabled", async () => {
      mockCheckUpdates.mockResolvedValue(onePackage);
      mockCheckSecurity.mockResolvedValue({ advisories: [], disabled: true });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("zzz-package")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.queryByText("Security")).not.toBeInTheDocument();
      });
    });

    it("writes the setting and reloads when the toggle is unchecked", async () => {
      mockCheckUpdates.mockResolvedValue(onePackage);
      mockCheckSecurity.mockResolvedValue({ advisories: [], disabled: false });
      const mockSetAdvisories = vi.mocked(api.setSecurityAdvisories);
      mockSetAdvisories.mockResolvedValue({ success: true, message: "Settings saved" });

      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: "Overview settings" }));
      const toggle = await screen.findByRole("checkbox", { name: /Check security advisories/ });
      expect(toggle).toBeChecked();

      mockCheckSecurity.mockResolvedValue({ advisories: [], disabled: true });
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(mockSetAdvisories).toHaveBeenCalledWith(false);
      });
      await waitFor(() => {
        expect(toggle).not.toBeChecked();
      });
      await waitFor(() => {
        expect(mockCheckSecurity.mock.calls.length).toBeGreaterThan(1);
      });
    });

    it("offers the toggle read-only to a session without administrative access", async () => {
      setPermission(false);
      mockCheckUpdates.mockResolvedValue(onePackage);
      mockCheckSecurity.mockResolvedValue({ advisories: [], disabled: false });

      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: "Overview settings" }));
      const toggle = await screen.findByRole("checkbox", { name: /Check security advisories/ });
      expect(toggle).toBeDisabled();
    });

    it("reverts the toggle when the setting cannot be written", async () => {
      mockCheckUpdates.mockResolvedValue(onePackage);
      mockCheckSecurity.mockResolvedValue({ advisories: [], disabled: false });
      const mockSetAdvisories = vi.mocked(api.setSecurityAdvisories);
      mockSetAdvisories.mockRejectedValue(new Error("write failed"));

      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: "Overview settings" }));
      const toggle = await screen.findByRole("checkbox", { name: /Check security advisories/ });
      expect(toggle).toBeChecked();

      fireEvent.click(toggle);

      await waitFor(() => {
        expect(mockSetAdvisories).toHaveBeenCalledWith(false);
      });
      await waitFor(() => {
        expect(toggle).toBeChecked();
      });
    });
  });

  describe("Error details", () => {
    it("shows the backend's context chain when a sync fails", async () => {
      mockSyncDatabase.mockImplementation((callbacks) => {
        setTimeout(
          () =>
            callbacks.onError(
              "Failed to prepare transaction",
              "transaction_failed",
              "caused by: conflicting files in /usr/bin"
            ),
          0
        );
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: /Refresh/ }));

      await waitFor(() => {
        expect(screen.getByText(/conflicting files in \/usr\/bin/)).toBeInTheDocument();
      });
    });

    it("shows nothing extra when the failure carries no chain", async () => {
      mockSyncDatabase.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onError("Failed to prepare transaction", "transaction_failed"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: /Refresh/ }));

      await waitFor(() => {
        expect(screen.getAllByText(/Failed to prepare transaction/).length).toBeGreaterThan(0);
      });
      expect(screen.queryByText(/caused by/)).not.toBeInTheDocument();
    });
  });

  describe("News Feed", () => {
    it("displays news items when returned", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockResolvedValue(mockNewsResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      });
      expect(screen.getByText("grub 2:2.12-3 requires manual intervention")).toBeInTheDocument();
      expect(screen.getByText("OpenSSL 3.4 update")).toBeInTheDocument();
    });

    it("shows nothing when empty response", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockResolvedValue(mockNewsResponseEmpty);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      });
      expect(screen.queryByText("Read more on archlinux.org")).not.toBeInTheDocument();
    });

    it("shows warning alert when fetch fails", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockRejectedValue(new Error("Network error"));

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      });
      expect(screen.queryByText("Read more on archlinux.org")).not.toBeInTheDocument();
      expect(screen.getByText("Unable to fetch Arch Linux news")).toBeInTheDocument();
      expect(screen.getByText(/Check the host's network connection/)).toBeInTheDocument();
    });

    it("shows the cached-news banner when news is served stale", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockResolvedValue({ ...mockNewsResponse, stale: true });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("Showing cached news")).toBeInTheDocument();
      });
      expect(screen.queryByText("Unable to fetch Arch Linux news")).not.toBeInTheDocument();
    });

    it("shows the cached-advisories banner when security data is served stale", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockCheckSecurity.mockResolvedValue({ advisories: [], stale: true });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("Showing cached security advisories")).toBeInTheDocument();
      });
    });

    it("shows the security-unavailable banner when the check fails with no cache", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockCheckSecurity.mockRejectedValue(new Error("could not resolve host"));

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("Security status unavailable")).toBeInTheDocument();
      });
      expect(screen.getByText(/not a clean bill of health/)).toBeInTheDocument();
    });

    it("dismissing news error alert removes it", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockRejectedValue(new Error("Network error"));

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("Unable to fetch Arch Linux news")).toBeInTheDocument();
      });

      const closeButton = screen.getByRole("button", { name: /Unable to fetch Arch Linux news/ });
      await act(async () => {
        fireEvent.click(closeButton);
      });

      expect(screen.queryByText("Unable to fetch Arch Linux news")).not.toBeInTheDocument();
    });

    it("shows news error alert alongside updates in available state", async () => {
      mockFetchNews.mockRejectedValue(new Error("Network error"));

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      expect(screen.getByText("Unable to fetch Arch Linux news")).toBeInTheDocument();
    });

    it("dismiss hides the specific item", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockResolvedValue(mockNewsResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("grub 2:2.12-3 requires manual intervention")).toBeInTheDocument();
      });

      const closeButtons = screen.getAllByRole("button").filter(
        (btn) => btn.getAttribute("aria-label")?.includes("grub")
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(closeButtons[0]);
      });

      expect(screen.queryByText("grub 2:2.12-3 requires manual intervention")).not.toBeInTheDocument();
      expect(screen.getByText("OpenSSL 3.4 update")).toBeInTheDocument();
    });

    it("news visible alongside updates in available state", async () => {
      mockFetchNews.mockResolvedValue(mockNewsResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      expect(screen.getByText("grub 2:2.12-3 requires manual intervention")).toBeInTheDocument();
    });
  });

  describe("Reboot Indicator", () => {
    it("shows kernel update alert when reboot needed", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "kernel_update",
        running_kernel: "6.18.4-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: [],
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      });
      expect(screen.getByText(/System reboot recommended/)).toBeInTheDocument();
      expect(screen.getByText(/Running kernel.*6\.18\.4-arch1-1.*differs from installed kernel.*6\.18\.5\.arch1-1/)).toBeInTheDocument();
    });

    it("shows critical packages alert when reboot needed", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "critical_packages",
        running_kernel: "6.18.5-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: ["systemd", "linux-firmware"],
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      });
      expect(screen.getByText(/System reboot recommended/)).toBeInTheDocument();
      expect(screen.getByText(/systemd, linux-firmware/)).toBeInTheDocument();
    });

    it("does not show alert when no reboot needed", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: false,
        reason: "none",
        running_kernel: "6.18.5-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: [],
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      });
      expect(screen.queryByText(/System reboot recommended/)).not.toBeInTheDocument();
    });

    it("close button calls markRebootDismissed with kernel signature for kernel_update", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "kernel_update",
        running_kernel: "6.18.4-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: [],
      });

      render(<UpdatesView />);
      await screen.findByText(/System reboot recommended/);
      const closeButtons = screen.getAllByRole("button").filter(
        (btn) => btn.getAttribute("aria-label")?.includes("System reboot"),
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(closeButtons[0]);
      });
      await waitFor(() => {
        expect(mockMarkRebootDismissed).toHaveBeenCalledWith("kernel:6.18.5.arch1-1");
      });
      expect(screen.queryByText(/System reboot recommended/)).not.toBeInTheDocument();
    });

    it("dismissing shows a toast whose Undo restores the prior signature", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "kernel_update",
        running_kernel: "6.18.4-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: [],
      });
      mockGetRebootDismissal.mockResolvedValue({ signature: "kernel:6.18.4-arch1-1" });

      render(<UpdatesView />);
      await screen.findByText(/System reboot recommended/);
      const close = screen.getAllByRole("button").find(
        (btn) => btn.getAttribute("aria-label")?.includes("System reboot"),
      )!;
      await act(async () => {
        fireEvent.click(close);
      });

      expect(screen.getByText("Reboot notice dismissed")).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });

      expect(mockRestoreReboot).toHaveBeenCalledWith("kernel:6.18.4-arch1-1", "kernel:6.18.5.arch1-1");
      expect(await screen.findByText(/System reboot recommended/)).toBeInTheDocument();
    });

    it("an older toast cannot undo a later dismissal of the same notice", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "kernel_update",
        running_kernel: "6.18.4-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: [],
      });
      render(<UpdatesView />);
      const closeNotice = async () => {
        const title = await screen.findByText("System reboot recommended");
        const alert = title.closest(".pf-v6-c-alert")!;
        await act(async () => {
          fireEvent.click(within(alert as HTMLElement).getByRole("button", { name: /close/i }));
        });
      };
      await closeNotice();
      fireEvent.click(await screen.findByRole("button", { name: "1 dismissed notice" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Show again: System reboot recommended" }));
      });
      expect(mockRestoreReboot).toHaveBeenCalledTimes(1);
      await closeNotice();
      expect(mockMarkRebootDismissed).toHaveBeenCalledTimes(2);
      expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(2);

      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Undo" })[0]);
      });
      expect(mockRestoreReboot).toHaveBeenCalledTimes(1);
      expect(screen.getByText("System reboot recommended").closest(".pf-v6-c-alert")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(mockRestoreReboot).toHaveBeenCalledTimes(2);
      expect(await screen.findByText("System reboot recommended")).toBeInTheDocument();
    });

    it("close button calls markRebootDismissed with sorted critical signature", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "critical_packages",
        running_kernel: "6.18.5-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: ["systemd", "linux-firmware"],
      });

      render(<UpdatesView />);
      await screen.findByText(/System reboot recommended/);
      const closeButtons = screen.getAllByRole("button").filter(
        (btn) => btn.getAttribute("aria-label")?.includes("System reboot"),
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(closeButtons[0]);
      });
      await waitFor(() => {
        expect(mockMarkRebootDismissed).toHaveBeenCalledWith("critical:linux-firmware,systemd");
      });
    });

    it("hides reboot alert on mount when stored signature matches", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "kernel_update",
        running_kernel: "6.18.4-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: [],
      });
      mockGetRebootDismissal.mockResolvedValue({ signature: "kernel:6.18.5.arch1-1" });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(mockGetRebootDismissal).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(mockGetRebootStatus).toHaveBeenCalled();
      });
      expect(screen.queryByText(/System reboot recommended/)).not.toBeInTheDocument();
    });

    it("shows reboot alert when stored signature is for an older kernel", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "kernel_update",
        running_kernel: "6.18.4-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: [],
      });
      mockGetRebootDismissal.mockResolvedValue({ signature: "kernel:6.18.4.arch1-1" });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/System reboot recommended/)).toBeInTheDocument();
      });
    });
  });

  describe("Ignored Packages", () => {
    beforeEach(() => {
      mockCheckUpdates.mockResolvedValue({
        updates: [
          {
            name: "linux",
            current_version: "6.7.0-arch1-1",
            new_version: "6.7.1-arch1-1",
            download_size: 150000000,
            current_size: 142000000,
            new_size: 145000000,
            repository: "core",
            ignored: true,
          },
          {
            name: "firefox",
            current_version: "120.0-1",
            new_version: "121.0-1",
            download_size: 50000000,
            current_size: 200000000,
            new_size: 201000000,
            repository: "extra",
            ignored: false,
          },
        ],
        warnings: [],
        ...SYNC_TIMES,
      });
      mockListIgnoredPackages.mockResolvedValue({ packages: ["linux"], total: 1 });
    });

    const getRowCheckbox = (pkgName: string) => {
      const cell = screen.getByText(pkgName).closest("tr");
      if (!cell) throw new Error(`row for ${pkgName} not found`);
      return cell.querySelector('input[type="checkbox"]') as HTMLInputElement;
    };

    it("disables checkbox for config-ignored packages by default", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(getRowCheckbox("linux").disabled).toBe(true);
      });
      expect(getRowCheckbox("firefox").disabled).toBe(false);
    });

    it("excludes ignored packages from initial selection", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(getRowCheckbox("linux").checked).toBe(false);
      });
      expect(getRowCheckbox("firefox").checked).toBe(true);
    });

    it("clicking the ignored pill opens the Manage Ignored modal", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      const pill = await screen.findByText("ignored");

      fireEvent.click(pill);

      const dialog = await screen.findByRole("dialog", { name: "Ignored packages" });
      expect(within(dialog).getByRole("textbox", { name: "Filter ignored packages" })).toHaveValue("linux");
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Unignore linux" })).toHaveFocus());
    });

    it("Select All does not select ignored packages", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(getRowCheckbox("firefox").checked).toBe(true);
      });

      fireEvent.click(getRowCheckbox("firefox"));
      await waitFor(() => {
        expect(getRowCheckbox("firefox").checked).toBe(false);
      });

      const selectAll = document.getElementById("select-all-updates") as HTMLInputElement;
      fireEvent.click(selectAll);

      await waitFor(() => {
        expect(getRowCheckbox("firefox").checked).toBe(true);
      });
      expect(getRowCheckbox("linux").checked).toBe(false);
      expect(getRowCheckbox("linux").disabled).toBe(true);
    });
  });

  describe("Services restart alert", () => {
    const originalHostname = window.location.hostname;

    const setHostname = (host: string) => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...window.location, hostname: host },
      });
    };

    afterEach(() => {
      setHostname(originalHostname);
    });

    it("says so when the scan could not inspect every process", async () => {
      mockGetServicesStatus.mockResolvedValue({
        restart_required: false,
        services: [],
        scan_incomplete: true,
      });
      render(<UpdatesView />);

      expect(
        await screen.findByText("Service check was incomplete")
      ).toBeInTheDocument();
    });

    it("stays quiet when the scan was complete and found nothing", async () => {
      mockGetServicesStatus.mockResolvedValue({
        restart_required: false,
        services: [],
        scan_incomplete: false,
      });
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      expect(screen.queryByText("Service check was incomplete")).not.toBeInTheDocument();
    });

    it("renders the alert with both sections and tags blocked rows", async () => {
      setHostname("fronker.example");
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusMixed);
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("Running services need to be restarted")).toBeInTheDocument();
      });
      expect(screen.getByText("Safe to restart from Cockpit:")).toBeInTheDocument();
      expect(screen.getByText("Cockpit can't restart these safely:")).toBeInTheDocument();
      expect(
        screen.getAllByText("Restarting this would disconnect your Cockpit session.").length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        screen.getByText("Restarting this would log out the desktop session."),
      ).toBeInTheDocument();
    });

    it("local cockpit promotes cockpit_transport rows to safe", async () => {
      setHostname("localhost");
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusMixed);
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Restart 2 services" })).toBeInTheDocument();
      });
      expect(
        screen.queryByText(
          (_, el) => el?.tagName === "STRONG" && el.textContent === "wpa_supplicant.service",
        ),
      ).toBeInTheDocument();
    });

    it("Restart button passes only unblocked unit names", async () => {
      setHostname("fronker.example");
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusMixed);
      render(<UpdatesView />);
      const btn = await screen.findByRole("button", { name: "Restart 1 service" });
      fireEvent.click(btn);
      await waitFor(() => {
        expect(mockRestartServices).toHaveBeenCalledWith(["nginx.service"]);
      });
    });

    it("does not render the alert when no services need restart", async () => {
      mockGetServicesStatus.mockResolvedValue(mockServicesStatus);
      render(<UpdatesView />);
      await waitFor(() => {
        expect(mockCheckUpdates).toHaveBeenCalled();
      });
      expect(
        screen.queryByText("Running services need to be restarted"),
      ).not.toBeInTheDocument();
    });

    it("hides the alert on mount when the stored signature matches the current services", async () => {
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusMixed);
      mockGetServicesDismissal.mockResolvedValue({
        signature: "gdm.service,nginx.service,polkit.service,wpa_supplicant.service",
      });
      render(<UpdatesView />);
      await waitFor(() => {
        expect(mockGetServicesDismissal).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(mockGetServicesStatus).toHaveBeenCalled();
      });
      expect(
        screen.queryByText("Running services need to be restarted"),
      ).not.toBeInTheDocument();
    });

    it("shows the alert when the stored signature differs from the current services", async () => {
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusMixed);
      mockGetServicesDismissal.mockResolvedValue({ signature: "old.service" });
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("Running services need to be restarted")).toBeInTheDocument();
      });
    });

    it("close button calls markServicesDismissed with the sorted service signature", async () => {
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusMixed);
      render(<UpdatesView />);
      await screen.findByText("Running services need to be restarted");
      const closeButtons = screen.getAllByRole("button").filter(
        (btn) => btn.getAttribute("aria-label")?.includes("Running services"),
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(closeButtons[0]);
      });
      await waitFor(() => {
        expect(mockMarkServicesDismissed).toHaveBeenCalledWith(
          "gdm.service,nginx.service,polkit.service,wpa_supplicant.service",
        );
      });
      expect(
        screen.queryByText("Running services need to be restarted"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Row ignore kebab", () => {
    it("offers the shared row verbs by keyboard without opening details", async () => {
      render(
        <NavigationProvider value={{ onViewDependencies: vi.fn(), onViewHistory: vi.fn() }}>
          <UpdatesView />
        </NavigationProvider>,
      );
      const toggle = await screen.findByRole("button", { name: "Actions for linux" });
      fireEvent.keyDown(toggle, { key: "Enter" });
      fireEvent.click(toggle);
      const menu = await screen.findByRole("menu");
      const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
      expect(labels.slice(0, 4)).toEqual([
        "View linux details",
        "View linux dependencies",
        "View linux history",
        "Ignore linux",
      ]);
      expect(labels[labels.length - 1]).toBe("Remove linux");
      expect(within(menu).getByRole("menuitem", { name: "Reinstall linux" })).toHaveAttribute("aria-disabled", "true");
      expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Close package details" })).not.toBeInTheDocument();
    });

    it('clicking "Ignore linux" in the row kebab calls addIgnoredPackage and reloads updates', async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const linuxRow = screen.getByText("linux").closest("tr");
      const kebabToggle = within(linuxRow!).getByRole("button", { name: /actions/i });
      await act(async () => {
        fireEvent.click(kebabToggle);
      });

      const ignoreItem = screen.getByRole("menuitem", { name: "Ignore linux" });
      await act(async () => {
        fireEvent.click(ignoreItem);
      });

      await waitFor(() => {
        expect(mockAddIgnoredPackage).toHaveBeenCalledWith("linux");
      });
      await waitFor(() => {
        expect(mockCheckUpdates).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("News dismissal", () => {
    it("dismissing a news item calls markNewsRead with its link and removes it from view", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockResolvedValue(mockNewsResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("grub 2:2.12-3 requires manual intervention")).toBeInTheDocument();
      });

      const closeButtons = screen.getAllByRole("button").filter(
        (btn) => btn.getAttribute("aria-label")?.includes("grub")
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(closeButtons[0]);
      });

      expect(mockMarkNewsRead).toHaveBeenCalledWith("https://archlinux.org/news/grub-2212-3/");
      expect(screen.queryByText("grub 2:2.12-3 requires manual intervention")).not.toBeInTheDocument();
    });

    it("a failed dismissal shows a danger toast and brings the item back", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockResolvedValue(mockNewsResponse);
      mockMarkNewsRead.mockRejectedValue(new Error("persistence unavailable"));

      render(<UpdatesView />);
      await screen.findByText("grub 2:2.12-3 requires manual intervention");

      const closeButtons = screen.getAllByRole("button").filter(
        (btn) => btn.getAttribute("aria-label")?.includes("grub")
      );
      await act(async () => {
        fireEvent.click(closeButtons[0]);
      });

      expect(await screen.findByText("Could not save the dismissal")).toBeInTheDocument();
      expect(screen.getByText("grub 2:2.12-3 requires manual intervention")).toBeInTheDocument();
    });

    it("Dismiss all hides every item and its Undo restores them all", async () => {
      const third = {
        title: "Third item",
        link: "https://archlinux.org/news/third/",
        published: "2026-01-10T00:00:00+00:00",
        summary: "Third.",
      };
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockResolvedValue({ items: [...mockNewsResponse.items, third] });

      render(<UpdatesView />);
      await screen.findByText("Third item");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Dismiss all (3)" }));
      });

      expect(mockMarkNewsRead).toHaveBeenCalledTimes(3);
      expect(screen.queryByText("Third item")).not.toBeInTheDocument();
      expect(screen.getByText("3 news items dismissed")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });

      expect(mockMarkNewsUnread).toHaveBeenCalledTimes(3);
      expect(mockMarkNewsUnread).toHaveBeenCalledWith(third.link);
      expect(screen.getByText("Third item")).toBeInTheDocument();
    });

    it("offers no Dismiss all for a single item", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockFetchNews.mockResolvedValue({ items: [mockNewsResponse.items[0]] });

      render(<UpdatesView />);
      await screen.findByText("grub 2:2.12-3 requires manual intervention");
      expect(screen.queryByRole("button", { name: /Dismiss all/ })).not.toBeInTheDocument();
    });
  });

  describe("Dismissed notices", () => {
    it("lists dismissed notices that still apply and Show again restores them", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
      mockGetRebootStatus.mockResolvedValue({
        requires_reboot: true,
        reason: "kernel_update",
        running_kernel: "6.18.4-arch1-1",
        installed_kernel: "6.18.5.arch1-1",
        kernel_package: "linux",
        updated_packages: [],
      });
      mockGetRebootDismissal.mockResolvedValue({ signature: "kernel:6.18.5.arch1-1" });
      mockFetchNews.mockResolvedValue({ items: [mockNewsResponse.items[0]] });
      mockGetNewsReadState.mockResolvedValue({ dismissed: [mockNewsResponse.items[0].link] });

      render(<UpdatesView />);
      const toggle = await screen.findByRole("button", { name: "2 dismissed notices" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(/System reboot recommended/)).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getAllByText("Dismissed")).toHaveLength(2);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Show again: System reboot recommended" }));
      });
      expect(mockRestoreReboot).toHaveBeenCalledWith(null, expect.any(String));
      expect(await screen.findByRole("heading", { name: /System reboot recommended/ })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: `Show again: ${mockNewsResponse.items[0].title}` }));
      });
      expect(mockMarkNewsUnread).toHaveBeenCalledWith(mockNewsResponse.items[0].link);
      expect(screen.queryByRole("button", { name: /dismissed notice/ })).not.toBeInTheDocument();
    });
  });

  describe("Services restart flow", () => {
    const nonRebootUpdate = {
      updates: [{
        name: "openresty",
        current_version: "1.21.4-1",
        new_version: "1.25.3-1",
        download_size: 5000000,
        current_size: 10000000,
        new_size: 12000000,
        ignored: false,
        repository: "extra",
      }],
      warnings: [],
      ...SYNC_TIMES,
    };

    it("Restart button in success view calls restartServices with all unblocked units", async () => {
      mockCheckUpdates.mockResolvedValue(nonRebootUpdate);
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusWithServices);
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({ type: "complete", success: true });
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      const applyButton = await screen.findByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("System updated")).toBeInTheDocument();
      });
      const restartBtn = await screen.findByRole("button", { name: "Restart 2 services" });
      await act(async () => {
        fireEvent.click(restartBtn);
      });

      await waitFor(() => {
        expect(mockRestartServices).toHaveBeenCalledWith(["nginx.service", "sshd.service"]);
      });
    });

    it("does not call restartServices after upgrade when checkbox is unchecked", async () => {
      mockCheckUpdates.mockResolvedValue(nonRebootUpdate);
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusWithServices);
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({ type: "complete", success: true });
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      const applyButton = await screen.findByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("System updated")).toBeInTheDocument();
      });

      expect(mockRestartServices).not.toHaveBeenCalled();
    });

    it("when the restart fails in success view, the step stays and a toast names the units with Try again", async () => {
      mockCheckUpdates.mockResolvedValue(nonRebootUpdate);
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusWithServices);
      mockRestartServices.mockRejectedValue(new Error("systemd unreachable"));
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({ type: "complete", success: true });
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      const applyButton = await screen.findByRole("button", { name: /Apply 1 update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("System updated")).toBeInTheDocument();
      });
      const restartBtn = await screen.findByRole("button", { name: "Restart 2 services" });
      await act(async () => {
        fireEvent.click(restartBtn);
      });

      await waitFor(() => {
        expect(mockRestartServices).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getByText("Running services need to be restarted.")).toBeInTheDocument();
      });
      expect(await screen.findByText("Could not restart nginx.service, sshd.service")).toBeInTheDocument();
      expect(screen.getByText("systemd unreachable")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      expect(mockRestartServices).toHaveBeenCalledTimes(2);
      expect(mockRestartServices).toHaveBeenLastCalledWith(["nginx.service", "sshd.service"]);
    });
  });

  describe("Scheduled run alerts", () => {
    const run = (status: string, error: string | null, details: string[]) => ({
      timestamp: "2026-06-14T03:00:00+0000",
      mode: "upgrade",
      success: status !== "failed",
      status,
      packages_checked: 3,
      packages_upgraded: 0,
      error,
      details,
      duration_secs: null,
      removed_stale_lock: false,
    });

    it("shows a danger alert when the last scheduled run failed", async () => {
      mockGetScheduledRuns.mockResolvedValue({
        runs: [run("failed", "Failed to commit upgrade: disk full", [])],
        total: 1,
      });
      render(<UpdatesView />);
      expect(await screen.findByText("Last scheduled upgrade failed")).toBeInTheDocument();
      expect(screen.getByText(/disk full/)).toBeInTheDocument();
    });

    it("shows a warning alert when the last scheduled run was deferred", async () => {
      mockGetScheduledRuns.mockResolvedValue({
        runs: [run("skipped", null, ["Skipped: manual intervention required (conflicts detected)"])],
        total: 1,
      });
      render(<UpdatesView />);
      expect(await screen.findByText("Scheduled upgrade was deferred")).toBeInTheDocument();
      expect(screen.getByText(/manual intervention required/)).toBeInTheDocument();
    });

    it("shows no alert when the last scheduled run succeeded", async () => {
      mockGetScheduledRuns.mockResolvedValue({
        runs: [run("ok", null, [])],
        total: 1,
      });
      render(<UpdatesView />);
      await waitFor(() => expect(mockGetScheduledRuns).toHaveBeenCalled());
      expect(screen.queryByText("Last scheduled upgrade failed")).not.toBeInTheDocument();
      expect(screen.queryByText("Scheduled upgrade was deferred")).not.toBeInTheDocument();
    });

    it("dismissing the alert persists the run timestamp and hides it", async () => {
      mockGetScheduledRuns.mockResolvedValue({
        runs: [run("failed", "boom", [])],
        total: 1,
      });
      render(<UpdatesView />);
      await screen.findByText("Last scheduled upgrade failed");
      const closeButtons = screen.getAllByRole("button").filter(
        (btn) => btn.getAttribute("aria-label")?.includes("Last scheduled upgrade failed"),
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(closeButtons[0]);
      });
      expect(mockMarkScheduledDismissed).toHaveBeenCalledWith("2026-06-14T03:00:00+0000");
      await waitFor(() =>
        expect(screen.queryByText("Last scheduled upgrade failed")).not.toBeInTheDocument(),
      );
    });
  });

  describe("Keyring status alerts", () => {
    it("warns when the keyring is uninitialized", async () => {
      mockGetKeyringStatus.mockResolvedValue({
        keys: [],
        total: 0,
        master_key_initialized: false,
        status: "uninitialized",
        warnings: [],
      });
      render(<UpdatesView />);

      expect(await screen.findByText("Keyring not initialized")).toBeInTheDocument();
    });

    it("stays quiet when the keyring state is undetermined", async () => {
      mockGetKeyringStatus.mockResolvedValue({
        keys: [],
        total: 0,
        master_key_initialized: false,
        status: "undetermined",
        warnings: ["Failed to check keyring status: permission denied (requires root)"],
      });
      render(<UpdatesView />);

      expect(
        await screen.findByText("Failed to check keyring status: permission denied (requires root)"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Keyring not initialized")).not.toBeInTheDocument();
    });
  });

  describe("Pacnew alerts", () => {
    it("offers an administrative review when an incomplete scan finds no pending files", async () => {
      mockGetPacnewStatus.mockResolvedValue({ has_pacnew: false, files: [], warnings: ["Could not inspect a protected directory"] });
      await act(async () => { render(<UpdatesView />); });
      expect(screen.getByText("Configuration files could not be fully checked")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Review configuration files" })).toBeInTheDocument();
    });

    it("lists files without an owning package and counts those past the first five", async () => {
      const files = Array.from({ length: 7 }, (_, index) => ({ path: `/etc/file${index}.pacsave`, package: null, kind: "pacsave", mtime: 1 }));
      mockGetPacnewStatus.mockResolvedValue({ has_pacnew: true, files });
      await act(async () => { render(<UpdatesView />); });
      expect(screen.getByText("/etc/file0.pacsave").closest("li")).toHaveTextContent(/^\/etc\/file0\.pacsave$/);
      expect(screen.queryByText("/etc/file5.pacsave")).not.toBeInTheDocument();
      expect(screen.getByText("And 2 more.")).toBeInTheDocument();
    });

    it.each([false, true])("resurfaces changed scan warnings with pending files: %s", async (hasFiles) => {
      const incomplete = (warning: string) => ({
        has_pacnew: hasFiles,
        files: hasFiles ? [{ path: "/etc/pacman.conf.pacnew", package: "pacman", kind: "pacnew", mtime: 1 }] : [],
        warnings: [warning],
      });
      const title = hasFiles ? "Configuration files need review" : "Configuration files could not be fully checked";
      mockGetPacnewStatus.mockResolvedValue(incomplete("first"));
      render(<UpdatesView />);
      expect(await screen.findByText(title)).toBeInTheDocument();
      const close = screen.getAllByRole("button").filter((btn) => btn.getAttribute("aria-label")?.includes(title));
      await act(async () => { fireEvent.click(close[0]); });
      await waitFor(() => expect(mockMarkPacnewDismissed).toHaveBeenCalled());
      const dismissedSignature = mockMarkPacnewDismissed.mock.calls[0][0];
      expect(dismissedSignature).not.toMatch(/\p{Cc}/u);

      cleanup();
      mockGetPacnewDismissal.mockResolvedValue({ signature: dismissedSignature });
      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: "1 dismissed notice" }));
      expect(screen.getByRole("button", { name: `Show again: ${title}` })).toBeInTheDocument();

      cleanup();
      mockGetPacnewStatus.mockResolvedValue(incomplete("second"));
      render(<UpdatesView />);
      expect(await screen.findByText(title)).toBeInTheDocument();
    });

    const pacnewStatus = (mtime: number) => ({
      has_pacnew: true,
      files: [{ path: "/etc/pacman.conf", package: "pacman", kind: "pacnew", mtime }],
    });

    it("resurfaces a dismissed alert when the same file changes again", async () => {
      mockGetPacnewStatus.mockResolvedValue(pacnewStatus(1700000000));
      render(<UpdatesView />);
      expect(await screen.findByText("Configuration files need review")).toBeInTheDocument();

      const closeButtons = screen.getAllByRole("button").filter(
        (btn) => btn.getAttribute("aria-label")?.includes("Configuration files need review"),
      );
      expect(closeButtons.length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.click(closeButtons[0]);
      });

      await waitFor(() => {
        expect(mockMarkPacnewDismissed).toHaveBeenCalled();
      });
      expect(screen.queryByText("Configuration files need review")).not.toBeInTheDocument();
      const dismissedSignature = mockMarkPacnewDismissed.mock.calls[0][0];

      cleanup();
      mockGetPacnewDismissal.mockResolvedValue({ signature: dismissedSignature });
      mockGetPacnewStatus.mockResolvedValue(pacnewStatus(1700009999));
      render(<UpdatesView />);

      expect(await screen.findByText("Configuration files need review")).toBeInTheDocument();
    });
  });

  describe("Package database age", () => {
    const now = () => Math.floor(Date.now() / 1000);
    const checkedAt = () => now() - 2 * 3600;
    const builtAt = () => now() - 3 * 86400;
    const upToDate = (last: number | null, oldest: number | null) =>
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], last_sync_at: last, oldest_database_at: oldest });
    const pageStatusTitles = () =>
      mockTransportControl.mock.calls
        .filter(([command]) => command === "notify")
        .map(([, payload]) => (payload as { page_status?: { title?: string } | null }).page_status?.title);
    const polite = () => document.querySelector<HTMLElement>('.pf-v6-screen-reader[role="status"][aria-atomic="true"]')!;

    it("names the last check, not the database build time, when the log records a sync", async () => {
      upToDate(checkedAt(), builtAt());
      render(<UpdatesView />);

      expect(await screen.findByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      expect(screen.getByText(/^Checked for updates/).querySelector("time")).toHaveTextContent("2 hours ago");
      expect(screen.getByText(/^No newer packages found when last checked/).querySelector("time")).toHaveTextContent("2 hours ago");
      expect(screen.queryByText(/^Package databases from/)).not.toBeInTheDocument();
      expect(screen.queryByText("3 days ago")).not.toBeInTheDocument();
      expect(screen.queryByText(/synced/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Turn on administrative access/)).not.toBeInTheDocument();
      sweepA11y();
    });

    it("falls back to the database build time when no sync is recorded", async () => {
      upToDate(null, builtAt());
      render(<UpdatesView />);

      expect(await screen.findByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      expect(screen.getByText(/^Package databases from/).querySelector("time")).toHaveTextContent("3 days ago");
      expect(screen.getByText(/^No newer packages in package databases from/).querySelector("time")).toHaveTextContent("3 days ago");
      expect(screen.queryByText(/^Checked for updates/)).not.toBeInTheDocument();
    });

    it("an unprivileged up-to-date state names the check age and never claims the system is current", async () => {
      setPermission(false);
      upToDate(checkedAt(), builtAt());
      render(<AnnouncerProvider><UpdatesView /></AnnouncerProvider>);

      const title = "No updates when last checked 2 hours ago";
      expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
      expect(screen.queryByText(/System is up to date/)).not.toBeInTheDocument();
      expect(screen.getByText(/Turn on administrative access to check the mirrors for newer packages/)).toBeInTheDocument();
      expect(screen.getByText(/^Showing updates as of the last check/).querySelector("time")).toHaveAttribute("tabindex", "0");
      expect(screen.getByText(/Turn on administrative access to check for new updates\. Use the Limited access button in Cockpit's top bar\./)).toBeInTheDocument();
      expect(mockSyncDatabase).not.toHaveBeenCalled();

      await waitFor(() => expect(polite()).toHaveTextContent(title));
      expect(pageStatusTitles()).toContain(title);
      expect(pageStatusTitles()).not.toContain("System is up to date");
      sweepA11y();
    });

    it("the unprivileged up-to-date title ages with the page", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        setPermission(false);
        upToDate(checkedAt(), builtAt());
        render(<UpdatesView />);

        const heading = await screen.findByRole("heading", { name: "No updates when last checked 2 hours ago" });
        expect(heading.querySelector("time")).toHaveAttribute("tabindex", "0");
        vi.setSystemTime(Date.now() + 3600_000);
        await act(async () => {
          vi.advanceTimersByTime(60_000);
        });
        expect(heading).toHaveTextContent("No updates when last checked 3 hours ago");
      } finally {
        vi.useRealTimers();
      }
    });

    it("an unprivileged session without a recorded sync announces the database age", async () => {
      setPermission(false);
      upToDate(null, builtAt());
      render(<AnnouncerProvider><UpdatesView /></AnnouncerProvider>);

      const title = "No updates in package databases from 3 days ago";
      expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
      expect(screen.getByText(/^Showing updates in package databases from/)).toBeInTheDocument();
      await waitFor(() => expect(polite()).toHaveTextContent(title));
      expect(pageStatusTitles()).toContain(title);
    });

    it("the update list shows the check age beside Refresh", async () => {
      mockCheckUpdates.mockResolvedValue({ ...mockUpdatesResponse, last_sync_at: checkedAt(), oldest_database_at: builtAt() });
      render(<UpdatesView />);

      await screen.findByText(/1 of 1 update/);
      const toolbar = screen.getByRole("button", { name: /Refresh/ }).closest(".pf-v6-c-toolbar__content")!;
      expect(within(toolbar as HTMLElement).getByText(/^Checked for updates/).querySelector("time")).toHaveTextContent("2 hours ago");
    });

    it("a never-synced database shows a warning and no success title", async () => {
      upToDate(checkedAt(), null);
      render(<UpdatesView />);

      expect(await screen.findByRole("heading", { name: "Some package databases have never been synced" })).toBeInTheDocument();
      expect(screen.queryByText("System is up to date")).not.toBeInTheDocument();
      expect(screen.queryByText(/^Checked for updates/)).not.toBeInTheDocument();
      expect(screen.getAllByText(/Some package databases have never been synced/).length).toBe(2);
      await waitFor(() => expect(mockTransportControl).toHaveBeenCalledWith("notify", {
        page_status: { type: "warning", title: "Some package databases have never been synced" },
      }));
      expect(pageStatusTitles()).not.toContain("System is up to date");
    });
  });

  describe("Truthful landing", () => {
    const glibc = {
      name: "glibc",
      current_version: "2.38-1",
      new_version: "2.39-1",
      download_size: 50000000,
      current_size: 45000000,
      new_size: 48000000,
      ignored: false,
      repository: "core",
    };
    const pageStatusTitles = () =>
      mockTransportControl.mock.calls
        .filter(([command]) => command === "notify")
        .map(([, payload]) => (payload as { page_status?: { title?: string } | null }).page_status?.title);
    const failSyncWith = (message: string) => {
      mockSyncDatabase.mockImplementationOnce((callbacks) => {
        setTimeout(() => callbacks.onError?.(message), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
    };
    const applyOnce = async () => {
      await waitFor(() => expect(screen.getByRole("button", { name: /Apply \d+ update/ })).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply \d+ update/ }));
      });
    };

    it("dismissing a failed first sync shows Updates not checked, never up to date", async () => {
      failSyncWith("error: failed to update core (invalid or corrupted database)");
      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: /Refresh/ }));
      expect(await screen.findByRole("heading", { name: "Sync failed" })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      });

      expect(screen.getByRole("heading", { name: "Updates not checked" })).toBeInTheDocument();
      expect(pageStatusTitles()).not.toContain("System is up to date");
      expect(pageStatusTitles()).toContain("Could not check for package updates");
    });

    it("dismissing a failed check restores the last good list", async () => {
      render(<UpdatesView />);
      await screen.findByText(/1 of 1 update/);

      mockCheckUpdates.mockRejectedValueOnce(new Error("corrupted database"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
      });
      await screen.findByRole("heading", { name: "Error checking for updates" });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      });
      expect(screen.getByText("linux")).toBeInTheDocument();
      expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
    });

    it("network Retry re-syncs and security checks only get booleans", async () => {
      mockCheckUpdates.mockRejectedValueOnce(new Error("failed to retrieve some files"));
      render(<UpdatesView />);
      const retry = await screen.findByRole("button", { name: "Retry sync" });
      expect(mockSyncDatabase).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(retry);
      });

      await screen.findByText(/1 of 1 update/);
      expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
      expect(mockCheckSecurity.mock.calls.length).toBeGreaterThan(0);
      for (const args of mockCheckSecurity.mock.calls) {
        expect(typeof args[0] === "boolean" || args[0] === undefined).toBe(true);
      }
    });

    it("keeps the selection across Refresh and selects updates that are new", async () => {
      mockCheckUpdates.mockResolvedValueOnce({ updates: [...mockUpdatesResponse.updates, glibc], warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await screen.findByText(/2 of 2 update/);

      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select glibc" }));
      });
      await screen.findByText(/1 of 2 update/);

      mockCheckUpdates.mockResolvedValueOnce({
        updates: [...mockUpdatesResponse.updates, glibc, { ...glibc, name: "curl" }],
        warnings: [],
        ...SYNC_TIMES,
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
      });

      await screen.findByText(/2 of 3 update/);
      expect(screen.getByRole("checkbox", { name: "Select glibc" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Select curl" })).toBeChecked();
      expect(screen.getByRole("button", { name: /Apply 2 updates/ })).not.toHaveAttribute("aria-disabled");
    });

    it("keeps the log and names the failure when an upgrade fails", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onData?.("(1/1) upgrading linux\n");
          callbacks.onError("Failed to commit transaction: conflicting files");
        }, 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<UpdatesView />);
      await applyOnce();

      expect(await screen.findByRole("heading", { name: "Upgrade failed" })).toBeInTheDocument();
      expect(await screen.findByRole("log")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry upgrade" })).toBeInTheDocument();
    });

    it("publishes Packages upgraded and reports skipped updates", async () => {
      let finishReload: (() => void) | undefined;
      mockCheckUpdates.mockResolvedValueOnce({ updates: [...mockUpdatesResponse.updates, glibc], warnings: [], ...SYNC_TIMES });
      mockCheckUpdates.mockImplementationOnce(() => new Promise((resolve) => {
        finishReload = () => resolve({ updates: [glibc], warnings: [], ...SYNC_TIMES });
      }));
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onComplete(), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<UpdatesView />);
      await screen.findByText(/2 of 2 update/);
      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select glibc" }));
      });
      await applyOnce();
      const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package?" });
      expect(within(dialog).getByText(/Skipping glibc\./)).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade 1 package" }));
      });

      expect(await screen.findByText("System updated")).toBeInTheDocument();
      expect(screen.getByText(/Upgraded 1 package\. 1 update was skipped\./)).toBeInTheDocument();
      expect(pageStatusTitles()).toContain("Upgrading packages…");
      expect(pageStatusTitles()).toContain("Packages upgraded");
      await act(async () => {
        finishReload?.();
      });
      await waitFor(() => {
        expect(pageStatusTitles()).toContain("Packages upgraded; 1 update still available");
      });
      expect(screen.getByText("System updated")).toBeInTheDocument();
    });

    it("keeps reads unprivileged when administrative access is enabled; sync requires Refresh", async () => {
      setPermission(false);
      render(<UpdatesView />);

      await screen.findByText(/1 of 1 update/);
      expect(mockSyncDatabase).not.toHaveBeenCalled();
      expect(screen.getByText(/^Showing updates as of the last check/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Apply 1 update/ })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: /Refresh/ })).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        changePermission(true);
      });

      expect(mockSyncDatabase).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
      await waitFor(() => expect(mockSyncDatabase).toHaveBeenCalledTimes(1));
      await waitFor(() => {
        expect(screen.queryByText(/^Showing updates as of the last check/)).not.toBeInTheDocument();
      });
      expect(mockSyncDatabase).toHaveBeenCalledTimes(1);
    });

    it("a failed ignore shows a danger toast", async () => {
      mockAddIgnoredPackage.mockRejectedValueOnce(new Error("cannot write pacman.conf"));
      render(<UpdatesView />);
      await screen.findByText(/1 of 1 update/);

      await act(async () => {
        fireEvent.click(within(screen.getByText("linux").closest("tr")!).getByRole("button", { name: /actions/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Ignore linux" }));
      });

      expect(await screen.findByText("Could not ignore linux")).toBeInTheDocument();
      expect(mockCheckUpdates).toHaveBeenCalledTimes(1);
    });

    it("a successful ignore offers Undo, which removes the package from the ignore list", async () => {
      render(<UpdatesView />);
      await screen.findByText(/1 of 1 update/);

      await act(async () => {
        fireEvent.click(within(screen.getByText("linux").closest("tr")!).getByRole("button", { name: /actions/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Ignore linux" }));
      });

      expect(await screen.findByText("linux is now ignored during upgrades")).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });

      await waitFor(() => expect(mockRemoveIgnoredPackage).toHaveBeenCalledWith("linux"));
      await waitFor(() => expect(mockCheckUpdates).toHaveBeenCalledTimes(3));
    });
  });

  describe("Security subset apply", () => {
    const makeUpdates = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `pkg${String(i).padStart(2, "0")}`,
        current_version: "1.0-1",
        new_version: "1.1-1",
        download_size: 1000,
        current_size: 2000,
        new_size: 2000,
        repository: "core",
        ignored: false,
      }));
    const advisoryFor = (pkg: string) => ({
      package: pkg,
      severity: "High",
      advisory_type: "security",
      avg_name: `AVG-${pkg}`,
      cve_ids: [],
      fixed_version: "1.1-1",
      fix_available: true,
      affected_version: "1.0-1",
      installed_version: "1.0-1",
      status: "Vulnerable",
    });
    const security = ["pkg02", "pkg05", "pkg09"];

    const renderFiltered = async () => {
      mockCheckUpdates.mockResolvedValue({ updates: makeUpdates(14), warnings: [], ...SYNC_TIMES });
      mockCheckSecurity.mockResolvedValue({ advisories: security.map(advisoryFor) });
      render(<UpdatesView />);
      await screen.findByText(/14 of 14 updates selected/);
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Filter to security updates" }));
      });
    };

    it("names the selected rows the filter hides and never changes the selection", async () => {
      await renderFiltered();

      expect(screen.getByRole("button", { name: /^Apply 14 updates \(11 not shown\)$/ })).toBeInTheDocument();
      expect(screen.getByText(/14 of 14 updates selected/)).toBeInTheDocument();
    });

    it("Select only these keeps just the visible security rows and Apply acts on them", async () => {
      await renderFiltered();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Select only these (3)" }));
      });

      const apply = screen.getByRole("button", { name: /^Apply 3 updates$/ });
      for (const name of security) {
        expect(screen.getByRole("checkbox", { name: `Select ${name}` })).toBeChecked();
      }

      await act(async () => {
        fireEvent.click(apply);
      });
      await waitFor(() => expect(mockPreflightUpgrade).toHaveBeenCalled());
      const ignored = mockPreflightUpgrade.mock.calls[0][0] as string[];
      expect(ignored).toHaveLength(11);
      expect(ignored.some((n) => security.includes(n))).toBe(false);
    });

    it("offers no subset action while the filter is off", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: makeUpdates(4), warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await screen.findByText(/4 of 4 updates selected/);

      expect(screen.queryByRole("button", { name: /Select only these/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Apply 4 updates$/ })).toBeInTheDocument();
    });
  });

  describe("Net size column", () => {
    it("has a focusable help trigger that does not sort, and signed cells", async () => {
      mockCheckUpdates.mockResolvedValue({
        updates: [
          { ...mockUpdatesResponse.updates[0], name: "grows", current_size: 1024, new_size: 3072 },
          { ...mockUpdatesResponse.updates[0], name: "shrinks", current_size: 4096, new_size: 1024 },
        ],
        warnings: [],
        ...SYNC_TIMES,
      });
      render(<UpdatesView />);
      await screen.findByText("grows");

      const help = screen.getByRole("button", { name: "More information about Net size" });
      const header = help.closest("th")!;
      const before = header.getAttribute("aria-sort");
      await act(async () => {
        fireEvent.click(help);
      });
      expect(header.getAttribute("aria-sort")).toBe(before);

      expect(within(screen.getByText("grows").closest("tr")!).getByText("+2.0 KiB")).toBeInTheDocument();
      expect(within(screen.getByText("shrinks").closest("tr")!).getByText("−3.0 KiB")).toBeInTheDocument();
    });
  });

  describe("Scheduled run line", () => {
    const run = (overrides: Partial<api.ScheduledRunEntry>): api.ScheduledRunEntry => ({
      timestamp: "2026-06-14T03:00:00+0000",
      mode: "upgrade",
      success: true,
      status: "ok",
      packages_checked: 12,
      packages_upgraded: 12,
      error: null,
      details: [],
      duration_secs: 40,
      removed_stale_lock: false,
      ...overrides,
    });

    beforeEach(() => {
      mockGetScheduleConfig.mockResolvedValue({
        enabled: true,
        mode: "upgrade",
        schedule: "weekly",
        max_packages: 0,
        timer_active: true,
        timer_next_run: null,
        timer_calendar: null,
      });
    });

    it("says what the last run did and opens the history from the line", async () => {
      mockGetScheduledRuns.mockResolvedValue({ runs: [run({})], total: 1 });
      render(<UpdatesView />);

      expect(await screen.findByText("Last scheduled run: upgraded 12 packages")).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "View run history" }));
      });

      const table = await screen.findByRole("grid", { name: "Scheduled run history" });
      expect(table).toBeVisible();
      await waitFor(() => expect(screen.getByText("Last 1 scheduled run")).toHaveFocus());
    });

    it("describes a check-only run", async () => {
      mockGetScheduledRuns.mockResolvedValue({
        runs: [run({ mode: "check", packages_checked: 3, packages_upgraded: 0 })],
        total: 1,
      });
      render(<UpdatesView />);

      expect(await screen.findByText("Last scheduled run: checked, 3 updates available")).toBeInTheDocument();
    });

    it("links the failure alert to the history instead of the line", async () => {
      mockGetScheduledRuns.mockResolvedValue({
        runs: [run({ status: "failed", success: false, error: "disk full", packages_upgraded: 0 })],
        total: 1,
      });
      render(<UpdatesView />);

      await screen.findByText("Last scheduled upgrade failed");
      expect(screen.queryByText(/^Last scheduled run:/)).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "View run history" }));
      });
      expect(await screen.findByRole("grid", { name: "Scheduled run history" })).toBeVisible();
    });

    it("shows nothing when there has never been a scheduled run", async () => {
      render(<UpdatesView />);
      await screen.findByText(/1 of 1 update/);

      expect(screen.queryByText(/^Last scheduled run:/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "View run history" })).not.toBeInTheDocument();
    });
  });

  describe("Signature failures", () => {
    const pgp = "failed to commit transaction (invalid or corrupted package (PGP signature))";

    it("routes an upgrade signature failure to the Keyring, keeping Retry", async () => {
      const onViewKeyring = vi.fn();
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onError(pgp, "signature_error"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<NavigationProvider value={{ onViewKeyring }}><UpdatesView /></NavigationProvider>);
      await waitFor(() => expect(screen.getByRole("button", { name: /Apply 1 update/ })).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/ }));
      });

      expect(await screen.findByRole("heading", { name: "Package signature could not be verified" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry upgrade" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
      expect(onViewKeyring).toHaveBeenCalledTimes(1);
    });

    it("hands the Keyring a retry that starts from preflight", async () => {
      const onViewKeyring = vi.fn();
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onError(pgp, "signature_error"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<NavigationProvider value={{ onViewKeyring }}><UpdatesView /></NavigationProvider>);
      await waitFor(() => expect(screen.getByRole("button", { name: /Apply 1 update/ })).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/ }));
      });
      await screen.findByRole("heading", { name: "Package signature could not be verified" });
      fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));

      const context = onViewKeyring.mock.calls[0][0];
      expect(context).toMatchObject({ origin: "upgrade", count: 1 });
      const preflights = mockPreflightUpgrade.mock.calls.length;
      const checks = mockCheckUpdates.mock.calls.length;
      await act(async () => {
        context.retry();
      });
      expect(await screen.findByRole("dialog", { name: "Upgrade 1 package?" })).toBeInTheDocument();
      expect(mockCheckUpdates).toHaveBeenCalledTimes(checks + 1);
      expect(mockPreflightUpgrade).toHaveBeenCalledTimes(preflights + 1);
      expect(mockRunUpgrade).toHaveBeenCalledTimes(1);
    });

    it("lands on the up-to-date state when the Keyring retry finds nothing pending", async () => {
      const onViewKeyring = vi.fn();
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onError(pgp, "signature_error"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<NavigationProvider value={{ onViewKeyring }}><UpdatesView /></NavigationProvider>);
      const apply = await screen.findByRole("button", { name: /Apply 1 update/ });
      await waitFor(() => expect(apply).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(apply);
      });
      await screen.findByRole("heading", { name: "Package signature could not be verified" });
      fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
      const preflights = mockPreflightUpgrade.mock.calls.length;
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });

      await act(async () => {
        onViewKeyring.mock.calls[0][0].retry();
      });

      expect(await screen.findByRole("heading", { name: /No updates (when last checked|in package databases from)/ })).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockPreflightUpgrade).toHaveBeenCalledTimes(preflights);
    });

    it("classifies a failed preflight response by its message", async () => {
      mockPreflightUpgrade.mockResolvedValue({ ...mockPreflightResponse, success: false, error: pgp });
      render(<NavigationProvider value={{ onViewKeyring: vi.fn() }}><UpdatesView /></NavigationProvider>);
      await waitFor(() => expect(screen.getByRole("button", { name: /Apply 1 update/ })).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/ }));
      });

      expect(await screen.findByRole("heading", { name: "Package signature could not be verified" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open Keyring" })).toBeInTheDocument();
    });

    it("keeps the generic failure for other transaction errors", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onError("conflicting files", "transaction_failed"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<NavigationProvider value={{ onViewKeyring: vi.fn() }}><UpdatesView /></NavigationProvider>);
      await waitFor(() => expect(screen.getByRole("button", { name: /Apply 1 update/ })).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/ }));
      });

      expect(await screen.findByRole("heading", { name: "Upgrade failed" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open Keyring" })).not.toBeInTheDocument();
    });

    it("offers Open Keyring on the uninitialized keyring alert", async () => {
      const onViewKeyring = vi.fn();
      mockGetKeyringStatus.mockResolvedValue({
        keys: [],
        total: 0,
        master_key_initialized: false,
        status: "uninitialized",
        warnings: [],
      });
      render(<NavigationProvider value={{ onViewKeyring }}><UpdatesView /></NavigationProvider>);

      await screen.findByText("Keyring not initialized");
      fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
      expect(onViewKeyring).toHaveBeenCalledTimes(1);
    });
  });

  describe("Announcements", () => {
    const region = (role: string) => {
      const el = document.querySelector<HTMLElement>(`.pf-v6-screen-reader[role="${role}"][aria-atomic="true"]`);
      expect(el).not.toBeNull();
      return el!;
    };
    const polite = () => region("status");
    const assertive = () => region("alert");

    it("announces the settled update count", async () => {
      mockCheckUpdates.mockResolvedValue({
        updates: [mockUpdatesResponse.updates[0], { ...mockUpdatesResponse.updates[0], name: "glibc" }],
        warnings: [],
        ...SYNC_TIMES,
      });
      render(<AnnouncerProvider><UpdatesView /></AnnouncerProvider>);

      await waitFor(() => expect(polite()).toHaveTextContent("2 updates available"));
    });

    it("never announces up to date for a dismissed failure", async () => {
      mockSyncDatabase.mockImplementationOnce((callbacks) => {
        setTimeout(() => callbacks.onError?.("error: failed to update core (invalid or corrupted database)"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<AnnouncerProvider><UpdatesView /></AnnouncerProvider>);
      fireEvent.click(await screen.findByRole("button", { name: /Refresh/ }));
      await screen.findByRole("heading", { name: "Sync failed" });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      });

      await screen.findByRole("heading", { name: "Updates not checked" });
      expect(polite()).not.toHaveTextContent(/up to date/i);
    });

    it("announces an upgrade failure assertively", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onError("conflicting files"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<AnnouncerProvider><UpdatesView /></AnnouncerProvider>);
      await waitFor(() => expect(screen.getByRole("button", { name: /Apply 1 update/ })).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/ }));
      });

      await waitFor(() => expect(assertive()).toHaveTextContent("Upgrade failed"));
    });

    it("announces a finished upgrade politely", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onComplete(), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<AnnouncerProvider><UpdatesView /></AnnouncerProvider>);
      await waitFor(() => expect(screen.getByRole("button", { name: /Apply 1 update/ })).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/ }));
      });

      await waitFor(() => expect(polite()).toHaveTextContent("Upgrade finished"));
    });
  });

  describe("Freshness, reboot and holds", () => {
    const rebootNeeded = {
      requires_reboot: true,
      reason: "kernel_update" as const,
      running_kernel: "6.7.0-arch1-1",
      installed_kernel: "6.7.1-arch1-1",
      kernel_package: "linux",
      updated_packages: [],
    };
    const update = (name: string, ignored: boolean) => ({
      name,
      current_version: "1.0-1",
      new_version: "1.1-1",
      download_size: 1000,
      current_size: 2000,
      new_size: 2500,
      repository: "extra",
      ignored,
    });

    afterEach(() => {
      vi.restoreAllMocks();
      visibilityListeners.clear();
      delete (cockpit as { hidden?: boolean }).hidden;
    });

    it("refreshes quietly when the tab is activated", async () => {
      const { rerender } = render(
        <TabActiveContext.Provider value={false}><UpdatesView /></TabActiveContext.Provider>,
      );
      await screen.findByText(/1 of 1 update/);
      const calls = mockCheckUpdates.mock.calls.length;

      rerender(<TabActiveContext.Provider value={true}><UpdatesView /></TabActiveContext.Provider>);

      expect(screen.queryByText("Querying package databases…")).not.toBeInTheDocument();
      await waitFor(() => expect(mockCheckUpdates).toHaveBeenCalledTimes(calls + 1));
      expect(screen.queryByText("Querying package databases…")).not.toBeInTheDocument();
      expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
    });

    it("keeps the ignored packages dialog open across an ignore change", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [update("linux", true), update("firefox", false)], warnings: [], ...SYNC_TIMES });
      mockListIgnoredPackages.mockResolvedValue({ packages: ["linux"], total: 1 });
      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: "Manage ignored (1)" }));
      const dialog = await screen.findByRole("dialog", { name: "Ignored packages" });
      sweepA11y({ dialogs: ["Ignored packages"] });
      const unignore = await within(dialog).findByRole("button", { name: "Unignore linux" });
      const calls = mockCheckUpdates.mock.calls.length;

      await act(async () => {
        fireEvent.click(unignore);
      });

      await waitFor(() => expect(mockCheckUpdates).toHaveBeenCalledTimes(calls + 1));
      expect(dialog).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBe(dialog);
    });

    it("asks before rebooting and only the confirm reboots", async () => {
      mockGetRebootStatus.mockResolvedValue(rebootNeeded);
      mockRebootSystem.mockResolvedValue(undefined);
      render(<UpdatesView />);

      fireEvent.click(await screen.findByRole("button", { name: "Reboot now" }));
      const dialog = await screen.findByRole("dialog", { name: /Reboot the system\?$/ });
      expect(dialog).toHaveTextContent("linux 6.7.1-arch1-1 is installed; 6.7.0-arch1-1 is running.");
      sweepA11y({ dialogs: [/Reboot the system\?$/] });
      expect(mockRebootSystem).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(mockRebootSystem).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Reboot now" }));
      const again = await screen.findByRole("dialog", { name: /Reboot the system\?$/ });
      await act(async () => {
        fireEvent.click(within(again).getByRole("button", { name: "Reboot now" }));
      });
      expect(mockRebootSystem).toHaveBeenCalledTimes(1);
    });

    it("shows a failed reboot", async () => {
      mockGetRebootStatus.mockResolvedValue(rebootNeeded);
      mockRebootSystem.mockRejectedValue(new Error("Access denied"));
      render(<UpdatesView />);

      fireEvent.click(await screen.findByRole("button", { name: "Reboot now" }));
      const dialog = await screen.findByRole("dialog", { name: /Reboot the system\?$/ });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Reboot now" }));
      });

      expect(await screen.findByText("Could not reboot the system")).toBeInTheDocument();
      expect(screen.getByText("Access denied")).toBeInTheDocument();
    });

    it("gates Reboot now and the restart while another transaction runs", async () => {
      mockGetRebootStatus.mockResolvedValue(rebootNeeded);
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusWithServices);
      const clean = createMockStreamingProcess();
      mockSpawn.mockReturnValueOnce(clean);
      act(() => {
        api.cleanCache({ onComplete: vi.fn(), onError: vi.fn() }, 1);
      });

      try {
        render(<UpdatesView />);
        fireEvent.click(await screen.findByRole("button", { name: "2 notices" }));
        const reboot = await screen.findByRole("button", { name: "Reboot now" });
        const restart = await screen.findByRole("button", { name: /^Restart \d+ services?$/ });
        expect(reboot).toHaveAttribute("aria-disabled", "true");
        expect(restart).toHaveAttribute("aria-disabled", "true");
        for (const action of [reboot, restart]) expect(action).toHaveClass("pf-m-link", "pf-m-inline");
        fireEvent.click(reboot);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        fireEvent.click(restart);
        expect(mockRestartServices).not.toHaveBeenCalled();
      } finally {
        act(() => {
          clean._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
        clean._complete();
        });
      }
      expect(screen.getByRole("button", { name: "Reboot now" })).not.toHaveAttribute("aria-disabled");
    });

    it("counts held rows as neither partial nor unselected", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [update("linux", true), update("firefox", false)], warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);
      await screen.findByText(/1 of 2 updates selected/);

      expect((screen.getByLabelText(/^Select all \d+ updates?$/) as HTMLInputElement).checked).toBe(true);
      expect(screen.queryByRole("heading", { name: /Partial upgrade/ })).not.toBeInTheDocument();
      expect(screen.getByText("1 package ignored")).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText(/^Select all \d+ updates?$/));
      await screen.findByText(/0 of 2 updates selected/);
      expect(screen.getByRole("heading", { name: /Partial upgrade/ })).toBeInTheDocument();
    });

    it("says so when every pending update is held", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [update("linux", true), update("firefox", true)], warnings: [], ...SYNC_TIMES });
      render(<UpdatesView />);

      expect(await screen.findByRole("heading", { name: "All available updates are ignored" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Partial upgrade/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Manage ignored packages" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("reports an opted-in reboot that fails after the upgrade", async () => {
      let callbacks: Parameters<typeof api.runUpgrade>[0] | undefined;
      mockRunUpgrade.mockImplementation((cb) => {
        callbacks = cb;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      mockRebootSystem.mockRejectedValue(new Error("Access denied"));
      render(<UpdatesView />);
      const apply = await screen.findByRole("button", { name: /Apply 1 update/ });
      await waitFor(() => expect(apply).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(apply);
      });
      fireEvent.click(await screen.findByLabelText("Reboot when complete"));

      await act(async () => {
        callbacks?.onComplete();
      });

      expect(mockRebootSystem).toHaveBeenCalledTimes(1);
      expect(screen.getByText("System updated")).toBeInTheDocument();
      expect(await screen.findByText("Could not reboot the system")).toBeInTheDocument();
    });

    it("starts with a skip link that lands on the header holding Apply", async () => {
      const { container } = render(<UpdatesView />);
      await screen.findByText(/1 of 1 update/);

      const first = container.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      expect(first).toHaveTextContent("Skip to updates");

      fireEvent.click(first!);
      const header = document.activeElement as HTMLElement;
      expect(header.id).toBe("updates-list-header");
      expect(within(header).getByRole("button", { name: /Apply 1 update/ })).toBeInTheDocument();
    });

    it("defers news and signoffs until shown and never syncs on visibility changes", async () => {
      trackVisibilityListeners();
      setHidden(true, false);
      mockGetSignoffList.mockResolvedValue({ signoff_groups: [] } as unknown as Awaited<ReturnType<typeof api.getSignoffList>>);
      render(<UpdatesView signoffCredentials={{ username: "u", password: "p" }} onToSignOffCount={vi.fn()} />);

      await screen.findByText(/1 of 1 update/);
      expect(mockCheckUpdates).toHaveBeenCalled();
      expect(mockSyncDatabase).not.toHaveBeenCalled();
      expect(mockFetchNews).not.toHaveBeenCalled();
      expect(mockGetSignoffList).not.toHaveBeenCalled();
      expect(mockCheckSecurity).not.toHaveBeenCalled();
      expect(mockGetServicesStatus).not.toHaveBeenCalled();

      act(() => setHidden(false));

      expect(mockSyncDatabase).not.toHaveBeenCalled();
      await waitFor(() => expect(mockFetchNews).toHaveBeenCalled());
      await waitFor(() => expect(mockGetSignoffList).toHaveBeenCalled());
      await waitFor(() => expect(mockCheckSecurity).toHaveBeenCalled());

      act(() => setHidden(true));
      act(() => setHidden(false));
      expect(mockSyncDatabase).not.toHaveBeenCalled();
    });

    it("keeps the progress view when administrative access is revoked mid-upgrade", async () => {
      setPermission(true);
      render(<UpdatesView />);
      const apply = await screen.findByRole("button", { name: /Apply 1 update/ });
      await waitFor(() => expect(apply).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(apply);
      });
      await screen.findByText("Applying updates");
      const calls = mockCheckUpdates.mock.calls.length;

      await act(async () => {
        changePermission(false);
      });

      expect(screen.getByText("Applying updates")).toBeInTheDocument();
      expect(mockCheckUpdates).toHaveBeenCalledTimes(calls);
    });

    describe("upgrade commit safety", () => {
      const glibc = { ...update("glibc", false), download_size: 1000 };
      const activate = async (rerender: ReturnType<typeof render>["rerender"]) => {
        rerender(<AnnouncerProvider><TabActiveContext.Provider value={true}><UpdatesView /></TabActiveContext.Provider></AnnouncerProvider>);
      };
      const renderInactive = () =>
        render(<AnnouncerProvider><TabActiveContext.Provider value={false}><UpdatesView /></TabActiveContext.Provider></AnnouncerProvider>);

      it("confirms a partial upgrade even when the preflight matches the selection", async () => {
        mockCheckUpdates.mockResolvedValue({ updates: [mockUpdatesResponse.updates[0], glibc], warnings: [], ...SYNC_TIMES });
        render(<UpdatesView />);
        await screen.findByText(/2 of 2 updates selected/);
        fireEvent.click(screen.getByRole("checkbox", { name: "Select glibc" }));
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/ }));
        });

        const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package?" });
        expect(within(dialog).getByText(/Skipping glibc\./)).toBeInTheDocument();
        expect(mockRunUpgrade).not.toHaveBeenCalled();
      });

      it("offers Select all on the Partial upgrade alert and moves focus to Apply", async () => {
        mockCheckUpdates.mockResolvedValue({ updates: [mockUpdatesResponse.updates[0], glibc], warnings: [], ...SYNC_TIMES });
        render(<UpdatesView />);
        await screen.findByText(/2 of 2 updates selected/);
        fireEvent.click(screen.getByRole("checkbox", { name: "Select glibc" }));

        fireEvent.click(screen.getByRole("button", { name: "Select all" }));

        expect(screen.getByText(/2 of 2 updates selected/)).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: /Partial upgrade/ })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(screen.getByRole("button", { name: /Apply 2 updates/ }));
      });

      it("marks rows a quiet refresh adds as New, announces them once, and confirms an Apply right after", async () => {
        const { rerender } = renderInactive();
        await screen.findByText(/1 of 1 update/);
        mockCheckUpdates.mockResolvedValue({ updates: [mockUpdatesResponse.updates[0], glibc], warnings: [], ...SYNC_TIMES });

        await activate(rerender);

        const row = (await screen.findByText("glibc")).closest("tr")!;
        expect(within(row).getByText("New")).toBeInTheDocument();
        expect(within(screen.getByText("linux").closest("tr")!).queryByText("New")).not.toBeInTheDocument();
        const polite = document.querySelector<HTMLElement>('.pf-v6-screen-reader[role="status"][aria-atomic="true"]')!;
        await waitFor(() => expect(polite).toHaveTextContent("1 new update"));

        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /Apply 2 updates/ }));
        });
        expect(await screen.findByRole("dialog", { name: "Upgrade 1 package?" })).toBeInTheDocument();
        expect(mockRunUpgrade).not.toHaveBeenCalled();
      });

      it("commits directly once the arrival is more than 2 s old", async () => {
        const { rerender } = renderInactive();
        await screen.findByText(/1 of 1 update/);
        mockCheckUpdates.mockResolvedValue({ updates: [mockUpdatesResponse.updates[0], glibc], warnings: [], ...SYNC_TIMES });
        await activate(rerender);
        await screen.findByText("glibc");

        const later = Date.now() + 2500;
        vi.spyOn(Date, "now").mockReturnValue(later);
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /Apply 2 updates/ }));
        });

        await waitFor(() => expect(mockRunUpgrade).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      it("shows when the list was last loaded after a quiet refresh fails", async () => {
        const { rerender } = renderInactive();
        await screen.findByText(/1 of 1 update/);
        expect(screen.queryByText(/Last loaded/)).not.toBeInTheDocument();
        mockCheckUpdates.mockRejectedValue(new Error("offline"));

        await activate(rerender);

        expect(await screen.findByText(/Could not reload the list\. Last loaded/)).toBeInTheDocument();
        expect(screen.queryByText(/Could not recheck|Last checked/)).not.toBeInTheDocument();
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      it("counts the success state from the committed preflight", async () => {
        mockPreflightUpgrade.mockResolvedValue({
          ...mockPreflightResponse,
          add: [
            { name: "linux", version: "6.7.1-arch1-1", repo: "core", download_size: 1, installed_size: 1, old_version: "6.7.0-arch1-1", reason: "target" },
            { name: "libnew", version: "1-1", repo: "core", download_size: 1, installed_size: 1, reason: "dependency" },
          ],
          remove: [],
          net_installed_size: 2,
        });
        mockRunUpgrade.mockImplementation((callbacks) => {
          setTimeout(() => callbacks.onComplete(), 0);
          return { cancel: vi.fn(), forceStop: vi.fn() };
        });
        render(<UpdatesView />);
        const apply = await screen.findByRole("button", { name: /Apply 1 update/ });
        await waitFor(() => expect(apply).not.toHaveAttribute("aria-disabled"));
        await act(async () => {
          fireEvent.click(apply);
        });
        const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package and install 1?" });
        expect(within(dialog).getByText(/libnew pulled in/)).toBeInTheDocument();
        await act(async () => {
          fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade 1 package and install 1" }));
        });

        expect(await screen.findByText("Upgraded 1 package and installed 1.")).toBeInTheDocument();
      });

      it("offers Unignore on a held row and keeps focus on that row's kebab", async () => {
        mockCheckUpdates.mockResolvedValue({ updates: [update("linux", true), update("firefox", false)], warnings: [], ...SYNC_TIMES });
        render(<UpdatesView />);
        await screen.findByText(/1 of 2 updates selected/);
        const toggle = screen.getByRole("button", { name: "Actions for linux" });
        fireEvent.click(toggle);
        mockCheckUpdates.mockResolvedValue({ updates: [update("linux", false), update("firefox", false)], warnings: [], ...SYNC_TIMES });

        await act(async () => {
          fireEvent.click(await screen.findByRole("menuitem", { name: "Unignore linux" }));
        });

        expect(mockRemoveIgnoredPackage).toHaveBeenCalledWith("linux");
        await screen.findByText(/2 of 2 updates selected/);
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for linux" }));
        expect(screen.getByText("linux is no longer ignored during upgrades")).toBeInTheDocument();
      });

      it("keeps focus on the row's kebab after Ignore", async () => {
        mockCheckUpdates.mockResolvedValue({ updates: [update("linux", false), update("firefox", false)], warnings: [], ...SYNC_TIMES });
        render(<UpdatesView />);
        await screen.findByText(/2 of 2 updates selected/);
        fireEvent.click(screen.getByRole("button", { name: "Actions for firefox" }));
        mockCheckUpdates.mockResolvedValue({ updates: [update("linux", false), update("firefox", true)], warnings: [], ...SYNC_TIMES });

        await act(async () => {
          fireEvent.click(await screen.findByRole("menuitem", { name: "Ignore firefox" }));
        });

        await screen.findByText(/1 of 2 updates selected/);
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for firefox" }));
      });

      it("renders the system overview before the update list", async () => {
        render(<UpdatesView />);
        const apply = await screen.findByRole("button", { name: /Apply 1 update/ });
        const overview = await screen.findByRole("region", { name: "System overview" });
        expect(overview.compareDocumentPosition(apply) & document.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByText(/^Download size .+ · Net size/)).toBeInTheDocument();
      });

      it("folds two or more notices into one collapsed section", async () => {
        mockGetRebootStatus.mockResolvedValue(rebootNeeded);
        mockGetPacnewStatus.mockResolvedValue({
          has_pacnew: true,
          files: [{ path: "/etc/pacman.conf.pacnew", package: "pacman", kind: "pacnew", mtime: 1 }],
        });
        render(<UpdatesView />);

        const toggle = await screen.findByRole("button", { name: "2 notices" });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("button", { name: "Reboot now" })).not.toBeInTheDocument();
        fireEvent.click(toggle);
        expect(screen.getByRole("button", { name: "Reboot now" })).toBeInTheDocument();
      });

      it("leaves a single notice unfolded", async () => {
        mockGetRebootStatus.mockResolvedValue(rebootNeeded);
        render(<UpdatesView />);
        expect(await screen.findByRole("button", { name: "Reboot now" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /notices$/ })).not.toBeInTheDocument();
      });
    });

    it("retries a failed news fetch", async () => {
      mockFetchNews.mockRejectedValueOnce(new Error("offline"));
      render(<UpdatesView />);
      expect(await screen.findByText("Unable to fetch Arch Linux news")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });

      await waitFor(() => expect(mockFetchNews).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText("Unable to fetch Arch Linux news")).not.toBeInTheDocument());
    });
  });

  describe("details drawer", () => {
    const updates = Array.from({ length: 60 }, (_, i) => ({
      name: `drpkg${String(i).padStart(4, "0")}`,
      current_version: "1.0.0-1",
      new_version: "1.0.1-1",
      download_size: 1000,
      current_size: 2000,
      new_size: 2000,
      repository: "core",
      ignored: false,
    }));
    const nameButton = (name: string) =>
      within(screen.getByRole("grid", { name: "Available updates" })).getByRole("button", { name });

    it("replaces the panel in place, keeps page and selection and returns focus to the invoking row", async () => {
      mockCheckUpdates.mockResolvedValue({ updates, warnings: [], ...SYNC_TIMES });
      mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
      render(<UpdatesView />);
      await screen.findByText("drpkg0000");
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Go to next page"));
      });
      await screen.findByText("drpkg0055");
      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select drpkg0057" }));
      });
      await screen.findByText(/59 of 60 updates selected/);
      const checks = mockCheckUpdates.mock.calls.length;

      fireEvent.click(nameButton("drpkg0055"));
      expect(await screen.findByRole("region", { name: /^drpkg0055/ })).toBeInTheDocument();
      nameButton("drpkg0056").focus();
      fireEvent.click(nameButton("drpkg0056"));
      const panel = await screen.findByRole("region", { name: /^drpkg0056/ });

      expect(screen.queryByRole("region", { name: /^drpkg0055/ })).not.toBeInTheDocument();
      expect(screen.queryAllByRole("dialog")).toHaveLength(0);
      expect(nameButton("drpkg0056").closest("tr")).toHaveAttribute("aria-current", "true");
      expect(nameButton("drpkg0055").closest("tr")).not.toHaveAttribute("aria-current");
      sweepA11y();

      const close = within(panel).getByRole("button", { name: "Close package details" });
      close.focus();
      fireEvent.click(close);
      await waitFor(() => expect(screen.queryByRole("region", { name: /^drpkg0056/ })).not.toBeInTheDocument());
      expect(document.activeElement).toBe(nameButton("drpkg0056"));
      expect(screen.getByText("drpkg0055")).toBeInTheDocument();
      expect(screen.getByText(/59 of 60 updates selected/)).toBeInTheDocument();
      expect(mockCheckUpdates.mock.calls.length).toBe(checks);
    });

    it("overlays the list at narrow widths", async () => {
      const original = window.matchMedia;
      window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;
      try {
        mockCheckUpdates.mockResolvedValue({ updates, warnings: [], ...SYNC_TIMES });
        mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
        const { container } = render(<UpdatesView />);
        await screen.findByText("drpkg0000");
        fireEvent.click(nameButton("drpkg0001"));
        await screen.findByRole("dialog", { name: /^drpkg0001/ });
        const drawer = container.querySelector(".pf-v6-c-drawer");
        expect(drawer).toHaveClass("pf-m-expanded");
        expect(drawer).not.toHaveClass("pf-m-inline");
        expect(drawer).not.toContainElement(screen.getByRole("button", { name: /^Apply \d+ updates?/ }));
      } finally {
        window.matchMedia = original;
      }
    });

    it("opens a routed package in the drawer, marks its row and writes the close back", async () => {
      mockGetPackageInfo.mockResolvedValue(mockPackageDetails);
      const onRouteChange = vi.fn();
      render(<UpdatesView routeOptions={{ pkg: "linux" }} onRouteChange={onRouteChange} />);
      const grid = await screen.findByRole("grid", { name: "Available updates" });
      const panel = await screen.findByRole("region", { name: /^linux/ });
      expect(screen.queryAllByRole("dialog")).toHaveLength(0);
      expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
      const row = within(grid).getByRole("button", { name: "linux" }).closest("tr")!;
      expect(row).toHaveAttribute("aria-current", "true");
      expect(row.style.outline).not.toBe("");

      fireEvent.click(within(panel).getByRole("button", { name: "Close package details" }));
      await waitFor(() => expect(onRouteChange).toHaveBeenCalledWith({}));
      expect(row).not.toHaveAttribute("aria-current");
    });

    it("keeps Apply and the list header outside the drawer", async () => {
      mockCheckUpdates.mockResolvedValue({ updates, warnings: [], ...SYNC_TIMES });
      mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
      const { container } = render(<UpdatesView />);
      await screen.findByText("drpkg0000");
      fireEvent.click(nameButton("drpkg0002"));
      await screen.findByRole("region", { name: /^drpkg0002/ });
      const drawer = container.querySelector(".pf-v6-c-drawer")!;
      expect(drawer).not.toContainElement(screen.getByRole("button", { name: /^Apply \d+ updates?/ }));
      expect(drawer).not.toContainElement(screen.getByText(/60 of 60 updates selected/));
      expect(drawer).toContainElement(screen.getByRole("grid", { name: "Available updates" }));
    });
  });

  describe("preview freshness", () => {
    const openConfirm = async () => {
      render(<UpdatesView />);
      await screen.findByText(/1 of 1 update/);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      return screen.findByRole("dialog", { name: /^Upgrade / });
    };
    const commit = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: /^Upgrade / });

    it("marks an open preview stale on a system change, blocks the commit and refreshes it in place", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithConflicts);
      const dialog = await openConfirm();
      const checks = mockCheckUpdates.mock.calls.length;

      act(() => emitSystemChange("system"));
      expect(within(dialog).getByRole("heading", { name: /The system changed since this preview/ })).toBeInTheDocument();
      expect(commit(dialog)).toHaveAttribute("aria-disabled", "true");
      expect(commit(dialog)).toHaveAccessibleDescription("The system changed since this preview");
      expect(mockCheckUpdates.mock.calls.length).toBe(checks);

      mockPreflightUpgrade.mockResolvedValue(mockPreflightResponse);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Refresh preview" }));
      });
      await waitFor(() => expect(within(dialog).queryByRole("heading", { name: /The system changed since this preview/ })).not.toBeInTheDocument());
      expect(mockPreflightUpgrade).toHaveBeenCalledTimes(2);
      expect(commit(dialog)).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("dialog", { name: /^Upgrade / })).toBe(dialog);
    });

    it("runs the Updates reload a system change queued once the preview closes", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithConflicts);
      const dialog = await openConfirm();
      const checks = mockCheckUpdates.mock.calls.length;

      act(() => emitSystemChange("system"));
      expect(mockCheckUpdates.mock.calls.length).toBe(checks);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      });
      await waitFor(() => expect(mockCheckUpdates.mock.calls.length).toBe(checks + 1));
    });

    it("opens the confirm stale when the system changed while the preflight ran", async () => {
      let resolve!: (r: api.PreflightResponse) => void;
      mockPreflightUpgrade.mockReturnValue(new Promise((r) => { resolve = r; }));
      render(<UpdatesView />);
      await screen.findByText(/1 of 1 update/);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      act(() => emitSystemChange("system"));
      await act(async () => resolve(mockPreflightResponse));

      const dialog = await screen.findByRole("dialog", { name: /^Upgrade / });
      expect(within(dialog).getByRole("heading", { name: /The system changed since this preview/ })).toBeInTheDocument();
      expect(commit(dialog)).toHaveAttribute("aria-disabled", "true");
      expect(mockRunUpgrade).not.toHaveBeenCalled();
    });

    it("offers Check again on a blocking disk-space warning and reruns the preflight in place", async () => {
      mockPreflightUpgrade.mockResolvedValue({
        ...mockPreflightResponse,
        warnings: [{
          id: "disk_space", severity: "danger", title: "Not enough free space on /", message: "Needs 2 GiB, 1 GiB free.",
          packages: [], blocking: true, disk: { mount: "/", deficit: 1024 ** 3, holds_cache: true },
        }],
      });
      const dialog = await openConfirm();
      expect(commit(dialog)).toHaveAttribute("aria-disabled", "true");

      mockPreflightUpgrade.mockResolvedValue(mockPreflightResponse);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Check again" }));
      });
      await waitFor(() => expect(commit(dialog)).not.toHaveAttribute("aria-disabled", "true"));
      expect(mockPreflightUpgrade).toHaveBeenCalledTimes(2);
      expect(within(dialog).queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    });
  });

  describe("toasts and signoff failures", () => {
    it("times a toast with Undo out after 8 s, and not while it holds focus", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
        mockGetRebootStatus.mockResolvedValue({
          requires_reboot: true, reason: "kernel_update", running_kernel: "6.18.4-arch1-1",
          installed_kernel: "6.18.5.arch1-1", kernel_package: "linux", updated_packages: [],
        });
        render(<UpdatesView />);
        await screen.findByText(/System reboot recommended/);
        const close = screen.getAllByRole("button").find((btn) => btn.getAttribute("aria-label")?.includes("System reboot"))!;
        await act(async () => {
          fireEvent.click(close);
        });
        expect(screen.getByText("Reboot notice dismissed")).toBeInTheDocument();
        act(() => screen.getByRole("button", { name: "Undo" }).focus());
        await act(async () => {
          vi.advanceTimersByTime(30_000);
        });
        expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();

        const outside = screen.getAllByRole("button").find((b) => !b.closest(".pf-v6-c-alert-group"))!;
        act(() => outside.focus());
        await act(async () => {
          vi.advanceTimersByTime(3_100);
        });
        await waitFor(() => expect(screen.queryByText("Reboot notice dismissed")).not.toBeInTheDocument());
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps an unfocused toast with Undo for 8 s", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });
        mockGetRebootStatus.mockResolvedValue({
          requires_reboot: true, reason: "kernel_update", running_kernel: "6.18.4-arch1-1",
          installed_kernel: "6.18.5.arch1-1", kernel_package: "linux", updated_packages: [],
        });
        render(<UpdatesView />);
        await screen.findByText(/System reboot recommended/);
        const close = screen.getAllByRole("button").find((btn) => btn.getAttribute("aria-label")?.includes("System reboot"))!;
        await act(async () => {
          fireEvent.click(close);
        });
        act(() => (document.activeElement as HTMLElement | null)?.blur());
        await act(async () => {
          vi.advanceTimersByTime(7_500);
        });
        expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
        await act(async () => {
          vi.advanceTimersByTime(1_000);
        });
        await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument());
      } finally {
        vi.useRealTimers();
      }
    });

    it("says the credentials were rejected instead of hiding the signoff count", async () => {
      mockGetSignoffList.mockRejectedValueOnce(new api.BackendError("authentication failed", "permission_denied"));
      const onViewSignoffs = vi.fn();
      render(
        <NavigationProvider value={{ onViewSignoffs }}>
          <UpdatesView signoffCredentials={{ username: "alice", password: "p" }} toSignOff={null} onToSignOffCount={vi.fn()} />
        </NavigationProvider>,
      );
      expect(await screen.findByText("ArchWeb rejected the stored credentials")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open Signoffs" }));
      expect(onViewSignoffs).toHaveBeenCalled();

      mockGetSignoffList.mockResolvedValueOnce({ signoff_groups: [], total: 0 });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      await waitFor(() => expect(screen.queryByText("ArchWeb rejected the stored credentials")).not.toBeInTheDocument());
      expect(mockGetSignoffList).toHaveBeenCalledTimes(2);
    });
  });

  describe("upgrade outcome and the way back from Cache", () => {
    const orphans = (n: number) => ({
      orphans: Array.from({ length: n }, (_, i) => ({
        name: `orphan${i}`, version: "1-1", description: null, installed_size: 1, install_date: null, repository: null,
      })),
      total_size: n,
    });

    const rowCheckbox = (name: string) =>
      screen.getByRole("checkbox", { name: `Select ${name}` });

    const finishUpgrade = async (ui: React.ReactElement = <UpdatesView />) => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onComplete(), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      const view = render(ui);
      const apply = await screen.findByRole("button", { name: /Apply 1 update/i });
      await waitFor(() => expect(apply).not.toHaveAttribute("aria-disabled"));
      await act(async () => {
        fireEvent.click(apply);
      });
      expect(await screen.findByText("System updated")).toBeInTheDocument();
      return view;
    };

    const kernelReboot = {
      requires_reboot: true,
      reason: "kernel_update",
      running_kernel: "6.7.0-arch1-1",
      installed_kernel: "6.7.1-arch1-1",
      kernel_package: "linux",
      updated_packages: [],
    };
    const stepRows = (steps: HTMLElement) =>
      within(steps).getAllByRole("listitem").filter((li) => li.parentElement === steps);
    const firstTabStop = () =>
      [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")]
        .find((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && !el.closest("[aria-hidden='true'], [hidden]"));

    it("puts the steps above Check again, with Reboot now as the only primary and the first Tab stop", async () => {
      mockGetRebootStatus.mockResolvedValue(kernelReboot);
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusWithServices);
      mockGetPacnewStatus.mockResolvedValue({
        has_pacnew: true,
        files: [{ path: "/etc/pacman.conf.pacnew", package: "pacman", kind: "pacnew", mtime: 1 }],
      });
      const { container } = await finishUpgrade();

      const steps = await screen.findByRole("list", { name: "Next steps" });
      await waitFor(() => expect(within(steps).getByText("System reboot recommended.")).toBeVisible());
      expect(await within(steps).findByText("Running services need to be restarted.")).toBeVisible();
      expect(await within(steps).findByText("Configuration files need review.")).toBeVisible();
      expect(stepRows(steps)).toHaveLength(4);
      expect(within(steps).getByRole("button", { name: "Restart 2 services" })).toBeInTheDocument();
      expect(within(steps).getByRole("button", { name: "Review configuration files" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /notices$/ })).not.toBeInTheDocument();

      const checkAgain = screen.getByRole("button", { name: "Check again" });
      expect(steps.compareDocumentPosition(checkAgain) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const reboot = within(steps).getByRole("button", { name: "Reboot now" });
      expect(firstTabStop()).toBe(reboot);
      const primaries = [...container.querySelectorAll("button.pf-m-primary")];
      expect(primaries.map((b) => b.textContent)).toEqual(["Reboot now"]);
      expect(checkAgain).not.toHaveClass("pf-m-primary");
      sweepA11y();

      fireEvent.click(reboot);
      expect(await screen.findByRole("dialog", { name: /Reboot the system\?$/ })).toBeInTheDocument();
      expect(mockRebootSystem).not.toHaveBeenCalled();
    });

    it("reports an incomplete configuration scan after an upgrade instead of a clear result", async () => {
      mockGetPacnewStatus.mockResolvedValue({ has_pacnew: false, files: [], warnings: ["Skipped a non-UTF-8 filename under /etc."] });
      await finishUpgrade();
      const steps = await screen.findByRole("list", { name: "Next steps" });
      expect(await within(steps).findByText("Configuration files could not be fully checked.")).toBeVisible();
      expect(within(steps).queryByText("No configuration files to merge.")).not.toBeInTheDocument();
      expect(within(steps).getByRole("button", { name: "Review configuration files" })).toBeInTheDocument();
    });

    it("keeps one fixed row per check, so services resolving first are not pushed down by reboot", async () => {
      let releaseReboot: (status: typeof kernelReboot) => void = () => {};
      const lateReboot = new Promise<typeof kernelReboot>((resolve) => { releaseReboot = resolve; });
      const notNeeded = { requires_reboot: false, reason: "none", running_kernel: null, installed_kernel: null, kernel_package: null, updated_packages: [] };
      mockGetRebootStatus.mockImplementation(() => (mockRunUpgrade.mock.calls.length > 0 ? lateReboot : Promise.resolve(notNeeded)));
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusWithServices);
      await finishUpgrade();

      const steps = await screen.findByRole("list", { name: "Next steps" });
      const restart = await within(steps).findByRole("button", { name: "Restart 2 services" });
      const rows = stepRows(steps);
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("Checking whether a reboot is needed…");
      expect(rows[1]).toContainElement(restart);

      await act(async () => {
        releaseReboot(kernelReboot);
      });
      await waitFor(() => expect(rows[0]).toHaveTextContent("System reboot recommended."));
      const after = stepRows(steps);
      expect(after).toHaveLength(4);
      expect(after[1]).toBe(rows[1]);
      expect(after[1]).toContainElement(restart);
    });

    it("names the orphans the upgrade left and leads to them", async () => {
      mockListOrphans.mockResolvedValueOnce(orphans(3)).mockResolvedValue(orphans(5));
      const onViewOrphans = vi.fn();
      await finishUpgrade(
        <NavigationProvider value={{ onViewOrphans }}>
          <UpdatesView />
        </NavigationProvider>,
      );

      const steps = await screen.findByRole("list", { name: "Next steps" });
      expect(await within(steps).findByText("The upgrade left 2 new orphan packages.")).toBeInTheDocument();
      fireEvent.click(within(steps).getByRole("button", { name: "Review orphans" }));
      expect(onViewOrphans).toHaveBeenCalledTimes(1);
    });

    describe("tidy up", () => {


      beforeEach(() => {
        vi.mocked(api.previewRemoveOrphans).mockResolvedValue({
          success: true,
          add: [],
          remove: [
            { name: "orphan3", version: "1-1", installed_size: 1, reason: "target" },
            { name: "orphan4", version: "1-1", installed_size: 1, reason: "target" },
          ],
          conflicts: [],
          replacements: [],
          providers: [],
          import_keys: [],
          warnings: [],
          blocked_by: [],
          total_download_size: 0,
          net_installed_size: -2,
        });
      });

      it("offers Tidy up for new orphans and opens the previewed confirm without changing anything", async () => {
        mockListOrphans.mockResolvedValueOnce(orphans(3)).mockResolvedValue(orphans(5));
        await finishUpgrade();

        const steps = await screen.findByRole("list", { name: "Next steps" });
        await within(steps).findByText("The upgrade left 2 new orphan packages.");
        const tidy = within(steps).getByRole("button", { name: "Tidy up" });
        expect(tidy).toHaveClass("pf-m-secondary");
        sweepA11y();

        await act(async () => {
          fireEvent.click(tidy);
        });
        const dialog = await screen.findByRole("dialog", { name: "Tidy up after the upgrade" });
        expect(api.previewRemoveOrphans).toHaveBeenCalledWith(["orphan3", "orphan4"], expect.any(AbortSignal));
        expect(await within(dialog).findByRole("checkbox", { name: "Remove 2 orphan packages" })).toBeChecked();
        expect(within(dialog).queryByRole("checkbox", { name: /cache file/ })).not.toBeInTheDocument();
        sweepA11y({ dialogs: ["Tidy up after the upgrade"] });
        expect(api.removeOrphans).not.toHaveBeenCalled();
        expect(api.cleanCache).not.toHaveBeenCalled();

        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(api.removeOrphans).not.toHaveBeenCalled();
      });

      it("offers Tidy up for cache files beyond three versions when the upgrade left no orphans", async () => {
        mockListOrphans.mockResolvedValue(orphans(2));
        vi.mocked(api.previewCacheCleanup).mockResolvedValue({ files: 2, bytes: 2 * 1024 * 1024 });
        mockGetCacheInfo.mockResolvedValue({
          total_size: 6 * 1024 * 1024,
          package_count: 6,
          groups: [], total: 0, unique_packages: 0, multi_version_packages: 0,
          path: "/var/cache/pacman/pkg",
            });
        await finishUpgrade();

        const steps = await screen.findByRole("list", { name: "Next steps" });
        const row = (await within(steps).findByText("Old package files can be deleted.")).closest("li")!;
        expect(row).toHaveTextContent("The package cache holds up to 2 old files (2.0 MiB) beyond the newest 3 versions of each package.");
        expect(within(row).queryByRole("button", { name: "Review orphans" })).not.toBeInTheDocument();

        await act(async () => {
          fireEvent.click(within(row).getByRole("button", { name: "Tidy up" }));
        });
        const dialog = await screen.findByRole("dialog", { name: "Tidy up after the upgrade" });
        expect(api.previewRemoveOrphans).not.toHaveBeenCalled();
        expect(within(dialog).getByRole("button", { name: "Delete up to 2 cache files" })).toBeInTheDocument();
        expect(api.cleanCache).not.toHaveBeenCalled();
      });

      it("offers no Tidy up when there are neither new orphans nor projected cache files", async () => {
        mockListOrphans.mockResolvedValue(orphans(2));
        mockGetCacheInfo.mockResolvedValue({
          total_size: 3 * 1024 * 1024,
          package_count: 3,
          groups: [], total: 0, unique_packages: 0, multi_version_packages: 0,
          path: "/var/cache/pacman/pkg",
            });
        await finishUpgrade();

        const steps = await screen.findByRole("list", { name: "Next steps" });
        expect(await within(steps).findByText("The upgrade left no new orphan packages.")).toBeInTheDocument();
        expect(within(steps).queryByRole("button", { name: "Tidy up" })).not.toBeInTheDocument();
      });
    });

    it("has no orphan row when the count before the run is unknown", async () => {
      mockListOrphans.mockRejectedValueOnce(new Error("busy")).mockResolvedValue(orphans(4));
      await finishUpgrade();
      await waitFor(() => expect(mockListOrphans).toHaveBeenCalledTimes(2));

      const steps = await screen.findByRole("list", { name: "Next steps" });
      await waitFor(() => expect(within(steps).queryByText(/Checking|Counting/)).not.toBeInTheDocument());
      expect(stepRows(steps)).toHaveLength(3);
      expect(within(steps).queryByText(/orphan/i)).not.toBeInTheDocument();
    });

    it("collapses the new orphan names past five", async () => {
      mockListOrphans.mockResolvedValueOnce(orphans(1)).mockResolvedValue(orphans(9));
      await finishUpgrade();

      const steps = await screen.findByRole("list", { name: "Next steps" });
      expect(await within(steps).findByText("The upgrade left 8 new orphan packages.")).toBeInTheDocument();
      const row = within(steps).getByText("The upgrade left 8 new orphan packages.").closest("li")!;
      expect(row).toHaveTextContent("orphan1, orphan2, orphan3, orphan4, orphan5, and 3 more.");
      expect(row).not.toHaveTextContent("orphan0");
      expect(row).not.toHaveTextContent("orphan6");

      const toggle = within(row).getByRole("button", { name: "3 more orphan packages" });
      expect(toggle.textContent).toBe("3 more");
      toggle.focus();
      fireEvent.click(toggle);
      expect(row).toHaveTextContent("orphan1, orphan2, orphan3, orphan4, orphan5, orphan6, orphan7, orphan8.");
      expect(within(row).queryByRole("button", { name: /more/ })).not.toBeInTheDocument();
      const full = within(row).getByText("orphan1, orphan2, orphan3, orphan4, orphan5, orphan6, orphan7, orphan8.");
      expect(full).toHaveFocus();
      expect(full).toHaveAttribute("tabindex", "-1");
    });

    describe("skipped updates", () => {
      const glibc = { ...mockUpdatesResponse.updates[0], name: "glibc" };
      const held = { ...mockUpdatesResponse.updates[0], name: "held", ignored: true };

      const finishPartial = async () => {
        mockCheckUpdates.mockResolvedValue({ updates: [mockUpdatesResponse.updates[0], glibc, held], warnings: [], ...SYNC_TIMES });
        mockRunUpgrade.mockImplementation((callbacks) => {
          mockCheckUpdates.mockResolvedValue({ updates: [glibc, held], warnings: [], ...SYNC_TIMES });
          setTimeout(() => callbacks.onComplete(), 0);
          return { cancel: vi.fn(), forceStop: vi.fn() };
        });
        render(<UpdatesView />);
        await screen.findByRole("button", { name: "glibc" });
        fireEvent.click(rowCheckbox("glibc"));
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
        });
        const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package?" });
        await act(async () => {
          fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade 1 package" }));
        });
        expect(await screen.findByText("System updated")).toBeInTheDocument();
        return screen.findByRole("list", { name: "Next steps" });
      };

      it("offers the skipped updates first and runs the preflight on exactly them into the confirm", async () => {
        const steps = await finishPartial();
        const apply = await within(steps).findByRole("button", { name: "Apply the 1 skipped update" });
        expect(stepRows(steps)[0]).toContainElement(apply);
        expect(stepRows(steps)[0]).toHaveTextContent("Skipped: glibc.");
        expect(apply).toHaveClass("pf-m-secondary");
        sweepA11y();

        mockPreflightUpgrade.mockClear();
        mockRunUpgrade.mockClear();
        await act(async () => {
          fireEvent.click(apply);
        });

        await waitFor(() => expect(mockPreflightUpgrade).toHaveBeenCalledWith(["held"]));
        expect(mockPreflightUpgrade).toHaveBeenCalledTimes(1);
        const dialog = await screen.findByRole("dialog", { name: "Upgrade 1 package?" });
        expect(within(dialog).queryByText(/Skipping/)).not.toBeInTheDocument();
        expect(mockRunUpgrade).not.toHaveBeenCalled();
      });

      it("says so when none of the skipped updates are pending any more", async () => {
        const steps = await finishPartial();
        const apply = await within(steps).findByRole("button", { name: "Apply the 1 skipped update" });
        mockCheckUpdates.mockResolvedValue({ updates: [held], warnings: [], ...SYNC_TIMES });
        mockPreflightUpgrade.mockClear();
        await act(async () => {
          fireEvent.click(apply);
        });
        expect(await screen.findByText("None of the skipped updates are pending any more")).toBeInTheDocument();
        expect(mockPreflightUpgrade).not.toHaveBeenCalled();
      });

      it("has no skipped step when only held updates were left out", async () => {
        mockCheckUpdates.mockResolvedValue({ updates: [mockUpdatesResponse.updates[0], held], warnings: [], ...SYNC_TIMES });
        await finishUpgrade();
        expect(screen.getByText(/1 package is ignored/)).toBeInTheDocument();
        const steps = await screen.findByRole("list", { name: "Next steps" });
        expect(within(steps).queryByRole("button", { name: /skipped/ })).not.toBeInTheDocument();
        expect(within(steps).queryByText(/Skipped:/)).not.toBeInTheDocument();
      });
    });

    it("resolves every row to a clear line when the outcome needs nothing", async () => {
      mockListOrphans.mockResolvedValue(orphans(2));
      await finishUpgrade();
      await waitFor(() => expect(mockListOrphans).toHaveBeenCalledTimes(2));

      const steps = await screen.findByRole("list", { name: "Next steps" });
      expect(await within(steps).findByText("The upgrade left no new orphan packages.")).toBeInTheDocument();
      expect(within(steps).getByText("No reboot needed.")).toBeInTheDocument();
      expect(within(steps).getByText("No running services need a restart.")).toBeInTheDocument();
      expect(within(steps).getByText("No configuration files to merge.")).toBeInTheDocument();
      expect(within(steps).queryByRole("button")).not.toBeInTheDocument();
    });

    it("shows the restart in progress, then a done line that is also announced", async () => {
      let finishRestart: () => void = () => {};
      mockRestartServices.mockReturnValue(new Promise<undefined>((resolve) => { finishRestart = () => resolve(undefined); }));
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusWithServices);
      await finishUpgrade(<AnnouncerProvider><UpdatesView /></AnnouncerProvider>);

      const steps = await screen.findByRole("list", { name: "Next steps" });
      const restart = await within(steps).findByRole("button", { name: "Restart 2 services" });
      fireEvent.click(restart);
      expect(restart).toHaveClass("pf-m-in-progress");
      fireEvent.click(restart);
      expect(mockRestartServices).toHaveBeenCalledTimes(1);

      await act(async () => {
        finishRestart();
      });
      expect(await within(steps).findByText("Restarted nginx.service, sshd.service.")).toBeInTheDocument();
      expect(within(steps).queryByRole("button", { name: /^Restart / })).not.toBeInTheDocument();
      const polite = document.querySelector<HTMLElement>('.pf-v6-screen-reader[role="status"][aria-atomic="true"]');
      await waitFor(() => expect(polite).toHaveTextContent("Restarted nginx.service, sshd.service"));
    });

    it("links each unit Cockpit cannot restart to its Services page", async () => {
      const jump = vi.fn();
      const cockpitGlobal = cockpit as unknown as { jump?: (path: string) => void };
      cockpitGlobal.jump = jump;
      try {
        mockGetServicesStatus.mockResolvedValue(mockServicesStatusMixed);
        await finishUpgrade();
        const steps = await screen.findByRole("list", { name: "Next steps" });
        fireEvent.click(await within(steps).findByRole("button", { name: "Open polkit.service in Services" }));
        expect(jump).toHaveBeenCalledWith("/system/services#/polkit.service");
      } finally {
        delete cockpitGlobal.jump;
      }
    });

    it("drops the dismissed entry of a notice a step covers", async () => {
      mockGetServicesStatus.mockResolvedValue(mockServicesStatusWithServices);
      mockGetServicesDismissal.mockResolvedValue({ signature: "nginx.service,sshd.service" });
      await finishUpgrade();

      const steps = await screen.findByRole("list", { name: "Next steps" });
      expect(await within(steps).findByText("Running services need to be restarted.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /dismissed notice/ })).not.toBeInTheDocument();
    });

    it("re-reads the pending list on a system change while the tab is hidden, without a sync", async () => {
      const onUpdateStatus = vi.fn();
      mockCheckUpdates.mockResolvedValue({
        updates: [mockUpdatesResponse.updates[0], { ...mockUpdatesResponse.updates[0], name: "glibc" }],
        warnings: [],
        ...SYNC_TIMES,
      });
      render(
        <TabActiveContext.Provider value={false}><UpdatesView onUpdateStatus={onUpdateStatus} /></TabActiveContext.Provider>,
      );
      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2 })));
      const syncs = mockSyncDatabase.mock.calls.length;

      mockCheckUpdates.mockResolvedValue({ updates: [mockUpdatesResponse.updates[0]], warnings: [], ...SYNC_TIMES });
      act(() => emitSystemChange("system"));

      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1 })));
      expect(mockSyncDatabase).toHaveBeenCalledTimes(syncs);
      expect(screen.queryByText("Querying package databases…")).not.toBeInTheDocument();
      expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
    });

    it("keeps the last count on the badge while checking again", async () => {
      const onUpdateStatus = vi.fn();
      mockCheckUpdates.mockResolvedValue({
        updates: [mockUpdatesResponse.updates[0], { ...mockUpdatesResponse.updates[0], name: "glibc" }],
        warnings: [],
        ...SYNC_TIMES,
      });
      render(<UpdatesView onUpdateStatus={onUpdateStatus} />);
      await screen.findByText(/2 of 2 updates/);
      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2 })));
      mockSyncDatabase.mockImplementation(() => ({ cancel: vi.fn(), forceStop: vi.fn() }));
      onUpdateStatus.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

      expect(await screen.findByText("Checking for updates")).toBeInTheDocument();
      expect(onUpdateStatus).not.toHaveBeenCalledWith(expect.objectContaining({ count: null }));
    });

    it("reports the selectable security updates and a failed check", async () => {
      const onUpdateStatus = vi.fn();
      const vulnerable = { ...mockUpdatesResponse.updates[0], name: "glibc" };
      mockCheckUpdates.mockResolvedValue({
        updates: [mockUpdatesResponse.updates[0], vulnerable, { ...vulnerable, name: "held", ignored: true }],
        warnings: [],
        ...SYNC_TIMES,
      });
      const advisory = (pkg: string) => ({
        package: pkg, severity: "High", advisory_type: "security", avg_name: "AVG-1", cve_ids: ["CVE-1"],
        fixed_version: "2-1", fix_available: true, affected_version: "1-1", installed_version: "1-1", status: "Vulnerable",
      });
      mockCheckSecurity.mockResolvedValue({ advisories: [advisory("glibc"), advisory("held")] });
      render(<UpdatesView onUpdateStatus={onUpdateStatus} />);
      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith({ count: 2, security: 1, failed: false }));

      mockSyncDatabase.mockImplementation((callbacks) => {
        setTimeout(() => callbacks.onError("network unreachable"), 0);
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith({ count: null, security: 0, failed: true }));
    });

    it("reports selectable updates without held ones, and nothing while unchecked", async () => {
      const onUpdateStatus = vi.fn();
      mockCheckUpdates.mockResolvedValue({
        updates: [
          mockUpdatesResponse.updates[0],
          { ...mockUpdatesResponse.updates[0], name: "glibc" },
          { ...mockUpdatesResponse.updates[0], name: "held", ignored: true },
        ],
        warnings: [],
        ...SYNC_TIMES,
      });
      render(<UpdatesView onUpdateStatus={onUpdateStatus} />);
      await waitFor(() => expect(onUpdateStatus).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2 })));
      expect(onUpdateStatus).toHaveBeenCalledWith(expect.objectContaining({ count: null }));
      expect(onUpdateStatus).not.toHaveBeenCalledWith(expect.objectContaining({ count: 3 }));
    });

    it("Open Cache carries the selection, and resume reruns the preflight for it into the confirm", async () => {
      mockCheckUpdates.mockResolvedValue({
        updates: [mockUpdatesResponse.updates[0], { ...mockUpdatesResponse.updates[0], name: "glibc" }],
        warnings: [],
        ...SYNC_TIMES,
      });
      const fullDisk = {
        ...mockPreflightResponse,
        warnings: [{
          id: "disk_space", severity: "danger" as const, title: "Not enough free space on /", message: "",
          packages: [], blocking: true, disk: { mount: "/", deficit: 1024 ** 3, holds_cache: true },
        }],
      };
      mockPreflightUpgrade.mockResolvedValue(fullDisk);
      const onViewCache = vi.fn();
      render(
        <NavigationProvider value={{ onViewCache }}>
          <UpdatesView />
        </NavigationProvider>,
      );
      await screen.findByText(/2 of 2 updates/);
      fireEvent.click(rowCheckbox("glibc"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 update/i }));
      });
      const dialog = await screen.findByRole("dialog", { name: /^Upgrade / });
      fireEvent.click(within(dialog).getByRole("button", { name: "Open Cache" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Upgrade / })).not.toBeInTheDocument());

      expect(onViewCache).toHaveBeenCalledWith(expect.objectContaining({ deficit: 1024 ** 3, mount: "/", selection: ["linux"] }));
      const context = onViewCache.mock.calls[0][0] as CacheContext;

      fireEvent.click(rowCheckbox("linux"));
      mockPreflightUpgrade.mockClear();
      mockPreflightUpgrade.mockResolvedValue(mockPreflightResponse);
      await act(async () => {
        context.resume?.();
      });
      await waitFor(() => expect(mockPreflightUpgrade).toHaveBeenCalledWith(["glibc"]));
      expect(await screen.findByRole("dialog", { name: /^Upgrade / })).toBeInTheDocument();
      expect(mockRunUpgrade).not.toHaveBeenCalled();
    });

    const leaveForCache = async () => {
      mockCheckUpdates.mockResolvedValue({
        updates: [mockUpdatesResponse.updates[0], { ...mockUpdatesResponse.updates[0], name: "glibc" }],
        warnings: [],
        ...SYNC_TIMES,
      });
      mockPreflightUpgrade.mockResolvedValue({
        ...mockPreflightResponse,
        warnings: [{
          id: "disk_space", severity: "danger" as const, title: "Not enough free space on /", message: "",
          packages: [], blocking: true, disk: { mount: "/", deficit: 1024 ** 3, holds_cache: true },
        }],
      });
      const onViewCache = vi.fn();
      render(
        <AnnouncerProvider>
          <NavigationProvider value={{ onViewCache }}>
            <UpdatesView />
          </NavigationProvider>
        </AnnouncerProvider>,
      );
      await screen.findByText(/2 of 2 updates/);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 2 updates/i }));
      });
      const dialog = await screen.findByRole("dialog", { name: /^Upgrade / });
      fireEvent.click(within(dialog).getByRole("button", { name: "Open Cache" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Upgrade / })).not.toBeInTheDocument());
      return onViewCache.mock.calls[0][0] as CacheContext;
    };

    it("shows an inline alert when a resume finds none of its updates pending", async () => {
      const context = await leaveForCache();
      mockPreflightUpgrade.mockClear();
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [], ...SYNC_TIMES });

      await act(async () => {
        context.resume?.();
      });

      const text = "None of the updates from that upgrade are pending any more";
      await waitFor(() => expect(document.querySelector(".pf-v6-c-alert.pf-m-info .pf-v6-c-alert__title")).toHaveTextContent(text));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(text));
      expect(mockPreflightUpgrade).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: `Close Info alert: alert: ${text}` }));
      expect(document.querySelector(".pf-v6-c-alert.pf-m-info")).toBeNull();
    });

    it("shows Apply loading from the resume until the preflight starts", async () => {
      const context = await leaveForCache();
      mockPreflightUpgrade.mockClear();
      let resolveList!: (v: Awaited<ReturnType<typeof api.checkUpdates>>) => void;
      mockCheckUpdates.mockImplementationOnce(() => new Promise((r) => { resolveList = r; }));
      let resolvePreflight!: (v: typeof mockPreflightResponse) => void;
      mockPreflightUpgrade.mockImplementationOnce(() => new Promise((r) => { resolvePreflight = r; }));

      act(() => {
        context.resume?.();
      });
      const apply = screen.getByRole("button", { name: /Checking…/ });
      expect(apply).toHaveAttribute("aria-disabled", "true");
      expect(mockPreflightUpgrade).not.toHaveBeenCalled();

      await act(async () => {
        resolveList({
          updates: [mockUpdatesResponse.updates[0], { ...mockUpdatesResponse.updates[0], name: "glibc" }],
          warnings: [],
          ...SYNC_TIMES,
        });
      });
      await waitFor(() => expect(mockPreflightUpgrade).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: /Checking…/ })).toBeInTheDocument();

      await act(async () => resolvePreflight(mockPreflightResponse));
      expect(await screen.findByRole("dialog", { name: /^Upgrade / })).toBeInTheDocument();
    });
  });

  describe("preserved safety behavior", () => {
it("syncs databases and refreshes news only on explicit refresh", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      expect(mockSyncDatabase).not.toHaveBeenCalled();
      expect(mockFetchNews).toHaveBeenCalledOnce();
      expect(mockFetchNews).toHaveBeenCalledWith(30, false);

      const refreshButton = screen.getByRole("button", { name: /Refresh/i });
      await act(async () => {
        fireEvent.click(refreshButton);
      });

      expect(mockSyncDatabase).toHaveBeenCalled();
      expect(mockFetchNews).toHaveBeenLastCalledWith(30, true);
    });
it("does not reopen a preview closed while its refresh was pending", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithConflicts);
      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: /Apply 1 Update/i }));
      const dialog = await screen.findByRole("dialog", { name: /^Upgrade / });
      act(() => { emitSystemChange(); });
      let finish!: (value: api.PreflightResponse) => void;
      mockPreflightUpgrade.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Refresh preview" }));
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await act(async () => finish(mockPreflightWithConflicts));
      expect(screen.queryByRole("dialog", { name: /^Upgrade / })).not.toBeInTheDocument();
      expect(mockRunUpgrade).not.toHaveBeenCalled();
    });
it("passes the confirmed preflight removals to the upgrade", async () => {
      mockPreflightUpgrade.mockResolvedValue({
        ...mockPreflightResponse,
        removals: ["old-driver"],
      });
      render(<UpdatesView />);
      fireEvent.click(await screen.findByRole("button", { name: /Apply 1 Update/i }));
      await screen.findByRole("dialog", { name: /^Upgrade / });
      expect(mockRunUpgrade).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("checkbox", { name: "Remove old-driver" }));
      fireEvent.click(screen.getByRole("button", { name: /^Upgrade .*packages?(?: and remove .*|)$/i }));
      expect(mockRunUpgrade.mock.calls[0][2]).toEqual(["old-driver"]);
    });
it("warns before leaving while an upgrade is applying", async () => {
      let upgradeCallbacks: Parameters<typeof api.runUpgrade>[0] | undefined;
      mockRunUpgrade.mockImplementation((callbacks) => {
        upgradeCallbacks = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
      });

      expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Apply 1 Update/i }));
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
      });

      expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);

      await act(async () => {
        upgradeCallbacks?.onComplete();
      });

      expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
    });
it("keeps an explicitly local connection failure out of the network error page", async () => {
      mockCheckUpdates.mockRejectedValue(new api.BackendError("Local socket connection refused", "internal_error", "system service socket"));
      render(<UpdatesView />);
      expect(await screen.findByText("system service socket")).toBeInTheDocument();
      expect(screen.queryByText("Can't reach Arch Linux services")).not.toBeInTheDocument();
    });
  });
});

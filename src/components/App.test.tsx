import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act, within } from "@testing-library/react";
import { mockLocationGo, mockSpawn, resetMockLocation, setMockLocation } from "../test/setup";
import { App } from "./App";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { SIGNOFF_TILE_FILTER } from "./SignoffsView";
import { CredentialError, getCredentials } from "../keyring";
import {
  BackendError, getSignoffList, listInstalled, listMirrors, listOrphans,
  runUpgrade, refreshExternalLockHolder, dismissTransactionOutcome,
  type SignoffGroupWithLocal,
} from "../api";
import {
  createMockSpawnPromise, createMockStreamingProcess,
  mockPackageListResponse, mockPreflightResponse, mockUpdatesResponse, mockServicesStatus,
} from "../test/mocks";
import { bundleVersion, mismatchedBackendVersion } from "../version";

vi.mock("../version", async () => {
  const actual = await vi.importActual<typeof import("../version")>("../version");
  return { ...actual, mismatchedBackendVersion: vi.fn() };
});

const recovery = vi.hoisted(() => ({ retry: vi.fn() }));

vi.mock("./HistoryView", async () => {
  const { useNavigation } = await vi.importActual<typeof import("../contexts/NavigationContext")>("../contexts/NavigationContext");
  return {
    HistoryView: () => {
      const { onViewKeyring } = useNavigation();
      return <div>
        History view mounted
        <button onClick={() => onViewKeyring?.({ origin: "install", target: "vim", retry: recovery.retry })}>
          Repair signature failure
        </button>
      </div>;
    },
  };
});

vi.mock("../keyring", async () => {
  const actual = await vi.importActual<typeof import("../keyring")>("../keyring");
  return { ...actual, getCredentials: vi.fn() };
});

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, getSignoffList: vi.fn(), listInstalled: vi.fn(), listMirrors: vi.fn(), listOrphans: vi.fn() };
});

const mockGetCredentials = vi.mocked(getCredentials);
const mockGetSignoffList = vi.mocked(getSignoffList);
const mockListInstalled = vi.mocked(listInstalled);
const mockListMirrors = vi.mocked(listMirrors);
const mockListOrphans = vi.mocked(listOrphans);
const emptyCache = {
  total_size: 0, package_count: 0, groups: [], total: 0,
  unique_packages: 0, multi_version_packages: 0, path: "/var/cache/pacman/pkg",
};
let spawned: ReturnType<typeof createMockStreamingProcess>[] = [];
let backendAnswers: Record<string, (args: string[]) => unknown>;
let backendCalls: string[][] = [];

beforeEach(() => {
  mockMismatch.mockReset();
  mockMismatch.mockResolvedValue(null);
  recovery.retry.mockReset();
  spawned = [];
  backendCalls = [];
  backendAnswers = {
    "check-updates": () => mockUpdatesResponse,
    "preflight-upgrade": () => mockPreflightResponse,
    "check-security": () => ({ advisories: [] }),
    "get-settings": () => ({ security_advisories: true }),
    "check-lock": () => ({ locked: false, stale: false, holder_unknown: false, lock_path: "/var/lib/pacman/db.lck" }),
    "list-ignored": () => ({ packages: [], total: 0 }),
    "cache-info": () => emptyCache,
    "cache-cleanup-preview": () => ({ files: 0, bytes: 0 }),
    "keyring-status": () => ({ keys: [], total: 0, master_key_initialized: true, status: "ready", warnings: [] }),
    "services-status": () => mockServicesStatus,
    "reboot-status": () => ({ requires_reboot: false, reason: "none", running_kernel: null, installed_kernel: null, kernel_package: null, updated_packages: [] }),
    "pacnew-status": () => ({ has_pacnew: false, files: [] }),
    "list-scheduled-runs": () => ({ runs: [], total: 0 }),
    "fetch-news": () => ({ items: [], fetched_at: null }),
    "news-read-state": () => ({ dismissed: [] }),
    "dismissal-state": () => ({ signature: null }),
    "list-mirror-backups": () => ({ backups: [], warnings: [] }),
  };
  mockSpawn.mockReset();
  mockSpawn.mockImplementation((argv: string[]) => {
    backendCalls.push(argv.slice(1));
    if (argv[1] === "upgrade" || argv[1] === "sync-database") {
      const proc = createMockStreamingProcess();
      spawned.push(proc);
      return proc;
    }
    const answer = backendAnswers[argv[1]];
    if (!answer) return createMockSpawnPromise("", true, new Error(`Unexpected backend command: ${argv[1]}`));
    const value = answer(argv.slice(2));
    return value instanceof Error
      ? createMockSpawnPromise("", true, value)
      : createMockSpawnPromise(JSON.stringify(value));
  });
  mockGetCredentials.mockReset();
  mockGetCredentials.mockRejectedValue(new CredentialError("absent", "No ArchWeb credentials found in keyring"));
  mockGetSignoffList.mockReset();
  mockGetSignoffList.mockResolvedValue({ signoff_groups: [], total: 0 });
  mockListInstalled.mockReset();
  mockListInstalled.mockResolvedValue(mockPackageListResponse);
  mockListMirrors.mockReset();
  mockListMirrors.mockImplementation(() => new Promise(() => {}));
  mockListOrphans.mockReset();
  mockListOrphans.mockResolvedValue({ orphans: [], total_size: 0 });
});

afterEach(async () => {
  cleanup();
  for (const proc of spawned.splice(0)) proc._fail({ problem: "cancelled" });
  dismissTransactionOutcome();
  backendAnswers["check-lock"] = () => ({ locked: false, stale: false, holder_unknown: false, lock_path: "/var/lib/pacman/db.lck" });
  await refreshExternalLockHolder();
});

const mockMismatch = vi.mocked(mismatchedBackendVersion);
const RELOAD_NOTICE = /Reload to finish updating this page/i;

describe("App version notice", () => {
  beforeEach(() => mockMismatch.mockReset());
  afterEach(() => cleanup());

  it("tells the user to reload when the backend has moved on beneath the bundle", async () => {
    mockMismatch.mockResolvedValue("99.0.0");
    render(<App />);

    await waitFor(() => expect(screen.getByText(RELOAD_NOTICE)).toBeInTheDocument());
    const escapedBundleVersion = bundleVersion!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(screen.getByText(new RegExp(`version ${escapedBundleVersion}`, "i"))).toBeInTheDocument();
    expect(screen.getByText(/version 99\.0\.0/i)).toBeInTheDocument();
  });

  it("says nothing when the versions agree", async () => {
    mockMismatch.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => expect(mockMismatch).toHaveBeenCalled());
    expect(screen.queryByText(RELOAD_NOTICE)).not.toBeInTheDocument();
  });
});


describe("App tabs", () => {
  afterEach(() => cleanup());

  it("mounts a hidden view on first selection and retains it when switching tabs", () => {
    mockMismatch.mockResolvedValue(null);
    render(<App />);
    expect(screen.queryByText("History view mounted")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByText("History view mounted")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
    expect(screen.getByText("History view mounted")).toBeInTheDocument();
    expect(screen.getByText("History view mounted")).not.toBeVisible();
  });
});

describe("App routing", () => {
  beforeEach(() => mockMismatch.mockResolvedValue(null));

  const tab = (name: string) => screen.getByRole("tab", { name });

  it("follows locationchanged and moves focus to the new panel", async () => {
    render(<App />);
    expect(tab("Updates")).toHaveAttribute("aria-selected", "true");
    act(() => setMockLocation(["keyring"]));
    await waitFor(() => expect(tab("Keyring")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tabpanel", { name: "Keyring" })).toHaveFocus();
  });

  it("treats an unknown tab as Updates", () => {
    resetMockLocation(["nonsense"]);
    render(<App />);
    expect(tab("Updates")).toHaveAttribute("aria-selected", "true");
  });

  it("a tab click navigates with go and leaves focus on the tab", async () => {
    render(<App />);
    tab("Mirrors").focus();
    fireEvent.click(tab("Mirrors"));
    expect(mockLocationGo).toHaveBeenCalledWith(["mirrors"]);
    await waitFor(() => expect(tab("Mirrors")).toHaveAttribute("aria-selected", "true"));
    expect(tab("Mirrors")).toHaveFocus();
  });

  it("returning to a tab by click keeps its options", async () => {
    resetMockLocation(["history"], { q: "linux" });
    render(<App />);
    fireEvent.click(tab("Cache"));
    await waitFor(() => expect(tab("Cache")).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(tab("History"));
    expect(mockLocationGo).toHaveBeenLastCalledWith(["history"], { q: "linux" });
  });

});

describe("App package jump and shortcuts", () => {
  beforeEach(() => mockMismatch.mockResolvedValue(null));

  const jump = () => screen.getByRole("textbox", { name: "Go to package or tab" });

  it("renders the jump field on every tab", async () => {
    render(<App />);
    const tabs = [screen.getByRole("tab", { name: "Updates" }), screen.getByRole("tab", { name: "History" })];
    expect(tabs.length).toBeGreaterThan(1);
    for (const tab of tabs) {
      fireEvent.click(tab);
      await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
      expect(screen.getAllByRole("textbox", { name: "Go to package or tab" })).toHaveLength(1);
    }
  });

  it("'/' focuses the jump from the page but not from inside another field", async () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(jump()).toHaveFocus();

    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    const notPrevented = fireEvent.keyDown(other, { key: "/" });
    expect(notPrevented).toBe(true);
    expect(other).toHaveFocus();
    other.remove();
  });

  it("Ctrl+/ does not move focus", () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    expect(jump()).not.toHaveFocus();
  });

  it("'?' opens the shortcut help", async () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

});

describe("App Signoffs availability", () => {
  beforeEach(() => mockMismatch.mockResolvedValue(null));

  it("keeps the Signoffs tab hidden when there are no ArchWeb credentials", async () => {
    render(<App />);
    await waitFor(() => expect(mockGetCredentials).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBeGreaterThan(1));
    expect(screen.queryByRole("tab", { name: "Signoffs" })).not.toBeInTheDocument();
  });

  it("shows a locked keyring in the tab and loads the list after Try again", async () => {
    mockGetCredentials.mockRejectedValueOnce(new CredentialError("locked", "Keyring requires interactive unlock"));
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Signoffs" }));
    expect(await screen.findByText(/login keyring is locked/)).toBeInTheDocument();
    expect(mockGetSignoffList).not.toHaveBeenCalled();

    mockGetCredentials.mockResolvedValueOnce({ username: "alice", password: "secret" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(mockGetSignoffList).toHaveBeenCalledWith({ username: "alice", password: "secret" }),
    );
    expect(screen.queryByText(/login keyring is locked/)).not.toBeInTheDocument();
  });

  it("re-reads rejected ArchWeb credentials and reloads the list in place", async () => {
    mockGetCredentials.mockResolvedValueOnce({ username: "alice", password: "old" });
    mockGetSignoffList.mockRejectedValue(new BackendError("authentication failed: invalid credentials", "permission_denied"));
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Signoffs" }));
    expect(await screen.findByText("ArchWeb rejected the stored credentials")).toBeInTheDocument();

    mockGetSignoffList.mockResolvedValue({ signoff_groups: [], total: 0 });
    mockGetCredentials.mockResolvedValueOnce({ username: "alice", password: "new" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(mockGetSignoffList).toHaveBeenLastCalledWith({ username: "alice", password: "new" }));
    await waitFor(() => expect(screen.queryByText("ArchWeb rejected the stored credentials")).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Signoffs" })).toHaveAttribute("aria-selected", "true");
  });

  it("opens Signoffs on the tile filter route and badges the tab with the same count", async () => {
    const row = (pkgbase: string, overrides: Partial<SignoffGroupWithLocal> = {}): SignoffGroupWithLocal => ({
      pkgbase, pkgnames: [pkgbase], version: "1.0-1", arch: "x86_64", repo: "core-testing", packager: "p",
      last_update: "2024-01-01T00:00:00Z", known_bad: false, approved: false, required: 2, enabled: true,
      signoffs: [], local_version: "1.0-1", version_match: "match", ...overrides,
    });
    let resolveCredentials!: (credentials: Awaited<ReturnType<typeof getCredentials>>) => void;
    let resolveSignoffs!: (response: Awaited<ReturnType<typeof getSignoffList>>) => void;
    mockGetCredentials.mockReturnValueOnce(new Promise((resolve) => { resolveCredentials = resolve; }));
    mockGetSignoffList.mockReturnValue(new Promise((resolve) => { resolveSignoffs = resolve; }));
    resetMockLocation(["signoffs"], { filter: SIGNOFF_TILE_FILTER });
    await act(async () => { render(<App />); });
    expect(mockGetCredentials).toHaveBeenCalledTimes(1);
    expect(mockGetSignoffList).not.toHaveBeenCalled();

    await act(async () => { resolveCredentials({ username: "alice", password: "secret" }); });
    expect(mockGetSignoffList).toHaveBeenCalledWith({ username: "alice", password: "secret" });
    expect(screen.getByRole("tab", { name: "Signoffs" })).toHaveAttribute("aria-selected", "true");

    await act(async () => { resolveSignoffs({
      signoff_groups: [
        row("counted"),
        row("signed-by-me", { signoffs: [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: false }] }),
        row("not-installed", { version_match: "not_installed", local_version: null }),
      ],
      total: 3,
    }); });

    expect(screen.getByRole("button", { name: "counted" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "signed-by-me" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "not-installed" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Signoffs\s*1\s*to sign off$/ })).toHaveAttribute("aria-selected", "true");
  });

  it("badges the Signoffs tab from the Updates load before Signoffs is visited", async () => {
    mockGetCredentials.mockResolvedValueOnce({ username: "alice", password: "secret" });
    mockGetSignoffList.mockResolvedValue({
      signoff_groups: [{
        pkgbase: "counted", pkgnames: ["counted"], version: "1.0-1", arch: "x86_64", repo: "core-testing", packager: "p",
        last_update: "2024-01-01T00:00:00Z", known_bad: false, approved: false, required: 2, enabled: true,
        signoffs: [], local_version: "1.0-1", version_match: "match",
      }],
      total: 1,
    });
    render(<App />);

    const tab = await screen.findByRole("tab", { name: /^Signoffs\s*1\s*to sign off$/ });
    expect(tab).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("button", { name: "counted" })).not.toBeInTheDocument();
  });

  it("keeps the Signoffs count when the Updates load resolves after it", async () => {
    const row = (pkgbase: string): SignoffGroupWithLocal => ({
      pkgbase, pkgnames: [pkgbase], version: "1.0-1", arch: "x86_64", repo: "core-testing", packager: "p",
      last_update: "2024-01-01T00:00:00Z", known_bad: false, approved: false, required: 2, enabled: true,
      signoffs: [], local_version: "1.0-1", version_match: "match",
    });
    mockGetCredentials.mockResolvedValueOnce({ username: "alice", password: "secret" });
    const pending: ((rows: SignoffGroupWithLocal[]) => void)[] = [];
    mockGetSignoffList.mockImplementation(() => new Promise((resolve) => {
      pending.push((rows) => resolve({ signoff_groups: rows, total: rows.length }));
    }));
    render(<App />);
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(await screen.findByRole("tab", { name: "Signoffs" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]([row("a")]));
    expect(await screen.findByRole("tab", { name: /^Signoffs\s*1\s*to sign off$/ })).toBeInTheDocument();
    await act(async () => pending[0]([row("a"), row("b")]));
    expect(screen.getByRole("tab", { name: /^Signoffs\s*1\s*to sign off$/ })).toBeInTheDocument();
  });

  it("shows the tab once credentials load", async () => {
    mockGetCredentials.mockResolvedValueOnce({ username: "alice", password: "secret" });
    render(<App />);
    expect(await screen.findByRole("tab", { name: "Signoffs" })).toBeInTheDocument();
  });
});



describe("App maintenance routing", () => {
  beforeEach(() => mockMismatch.mockResolvedValue(null));

  it("explains a route to hidden Signoffs and shows Updates", async () => {
    resetMockLocation(["signoffs"]);
    render(<App />);
    expect(await screen.findByText("Signoffs are not available")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Updates/ })).toHaveAttribute("aria-selected", "true");
  });

  it("opens Signoffs from its route once credentials load", async () => {
    mockGetCredentials.mockResolvedValueOnce({ username: "alice", password: "secret" });
    resetMockLocation(["signoffs"]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Signoffs" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByText("Signoffs are not available")).not.toBeInTheDocument();
  });

  it("keeps a retry with missing credentials on Signoffs", async () => {
    mockGetCredentials.mockRejectedValueOnce(new CredentialError("locked", "Keyring is locked"));
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Signoffs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No ArchWeb credentials")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Signoffs" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not load Mirrors until selected", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "linux" });
    expect(mockListMirrors).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Mirrors" }));
    await waitFor(() => expect(mockListMirrors).toHaveBeenCalledTimes(1));
  });
});

describe("App signature recovery", () => {
  beforeEach(() => {
    mockMismatch.mockResolvedValue(null);
    resetMockLocation(["history"]);
  });

  const repair = async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Repair signature failure" }));
    await screen.findByText("Install blocked by an untrusted signature");
    expect(screen.getByRole("tab", { name: "Keyring" })).toHaveAttribute("aria-selected", "true");
  };

  it("passes the failure to Keyring and returns to its origin on retry", async () => {
    await repair();
    fireEvent.click(screen.getByRole("button", { name: "Retry install" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true"));
    expect(recovery.retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Install blocked by an untrusted signature")).not.toBeInTheDocument();
  });

  it("clears the failure on a later plain visit", async () => {
    await repair();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.click(screen.getByRole("tab", { name: "Keyring" }));
    expect(screen.queryByText("Install blocked by an untrusted signature")).not.toBeInTheDocument();
    expect(recovery.retry).not.toHaveBeenCalled();
  });
});

describe("App running transaction", () => {
  beforeEach(() => mockMismatch.mockResolvedValue(null));
  const unloadAllowed = () => window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

  it("warns on unload until the backend exits, then rechecks the bundle version", async () => {
    resetMockLocation(["history"]);
    render(<App />);
    await waitFor(() => expect(mockMismatch).toHaveBeenCalledTimes(1));
    expect(unloadAllowed()).toBe(true);
    const onComplete = vi.fn();
    await act(async () => { runUpgrade({ onComplete, onError: vi.fn() }); });
    expect(unloadAllowed()).toBe(false);
    expect(screen.getByRole("tabpanel", { name: "History" })).toContainElement(screen.getByText("An upgrade is running"));
    const proc = spawned[0];
    await act(async () => { proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n"); });
    expect(unloadAllowed()).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockMismatch).toHaveBeenCalledTimes(1);

    mockMismatch.mockResolvedValue("99.0.0");
    await act(async () => { proc._complete(); });
    expect(unloadAllowed()).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockMismatch).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Reload page" })).toBeInTheDocument();
  });

  it("opens the upgrade progress from another tab", async () => {
    resetMockLocation(["history"]);
    render(<App />);
    await act(async () => { runUpgrade({ onComplete: vi.fn(), onError: vi.fn() }); });
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(screen.getByRole("tab", { name: /^Updates/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("An upgrade is running")).not.toBeInTheDocument();
    expect(unloadAllowed()).toBe(false);
  });
});

describe("App upgrade outcomes", () => {
  beforeEach(() => {
    mockMismatch.mockReset();
    mockMismatch.mockResolvedValue(null);
    resetMockLocation([]);
  });

  const update = (name: string, ignored = false) => ({ ...mockUpdatesResponse.updates[0], name, ignored });
  const GIB = 1024 ** 3;
  const fullDisk = {
    ...mockPreflightResponse,
    warnings: [{
      id: "disk_space", severity: "danger", title: "Not enough free space on /", message: "",
      packages: [], blocking: true, disk: { mount: "/", deficit: GIB, holds_cache: true },
    }],
  };

  function answerBackend(answers: Record<string, (args: string[]) => unknown>) {
    Object.assign(backendAnswers, answers);
    return backendCalls;
  }

  const finishLandingLoad = () => act(async () => {});

  const updatesTab = () => screen.getByRole("tab", { name: /^Updates/, hidden: true });

  it("counts selectable updates in the Updates tab, leaving out held ones", async () => {
    answerBackend({
      "check-updates": () => ({
        updates: [update("a"), update("b"), update("c"), update("d"), update("held", true)],
        warnings: [], last_sync_at: mockUpdatesResponse.last_sync_at, oldest_database_at: mockUpdatesResponse.oldest_database_at,
      }),
    });
    render(<App />);
    await finishLandingLoad();
    await waitFor(() => expect(updatesTab()).toHaveAccessibleName(/^Updates\s*4\s*updates available$/));
  });

  it("marks a failed check on the tab, and shows no count once it is dismissed", async () => {
    answerBackend({ "check-updates": () => new Error("boom") });
    render(<App />);
    await finishLandingLoad();
    await waitFor(() => expect(updatesTab()).toHaveAccessibleName(/^Updates\s*Update check failed$/));
    expect(updatesTab().querySelector(".pf-v6-c-badge svg")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Updates not checked")).toBeInTheDocument();
    expect(updatesTab()).toHaveAccessibleName("Updates");
  });

  it("shows an unread badge naming the security updates", async () => {
    const advisory = (pkg: string) => ({
      package: pkg, severity: "High", advisory_type: "security", avg_name: "AVG-1", cve_ids: ["CVE-1"],
      fixed_version: "2-1", affected_version: "1-1", installed_version: "1-1", status: "Vulnerable",
    });
    answerBackend({
      "check-updates": () => ({ updates: [update("a"), update("b"), update("c")], warnings: [] }),
      "check-security": () => ({ advisories: [advisory("b")] }),
    });
    render(<App />);
    await finishLandingLoad();
    await waitFor(() => expect(updatesTab()).toHaveAccessibleName(/^Updates\s*3\s*updates available, 1 security$/));
    expect(updatesTab().querySelector(".pf-v6-c-badge")).toHaveClass("pf-m-unread");
  });

  it("keeps a read badge with the last count while checking again", async () => {
    answerBackend({
      "check-updates": () => ({ updates: [update("a"), update("b")], warnings: [] }),
    });
    render(<App />);
    await finishLandingLoad();
    await waitFor(() => expect(updatesTab()).toHaveAccessibleName(/^Updates\s*2\s*updates available$/));
    expect(updatesTab().querySelector(".pf-v6-c-badge")).toHaveClass("pf-m-read");

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Checking for updates")).toBeInTheDocument();
    expect(updatesTab()).toHaveAccessibleName(/^Updates\s*2\s*updates available$/);
  });

  it("leads from a space-blocked upgrade to Cache and back into the preview for the same selection", async () => {
    const calls = answerBackend({
      "check-updates": () => ({ updates: [update("linux"), update("glibc")], warnings: [] }),
      "preflight-upgrade": () => fullDisk,
      "cache-info": () => ({ ...emptyCache, total_size: GIB, package_count: 1 }),
    });
    render(<App />);
    await finishLandingLoad();

    const glibcRow = (await screen.findByRole("button", { name: "glibc" })).closest("tr")!;
    fireEvent.click(within(glibcRow).getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply 1 update/ }));
    });
    const dialog = await screen.findByRole("dialog", { name: /^Upgrade / });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open Cache" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Cache" })).toHaveAttribute("aria-selected", "true"));
    expect(await screen.findByRole("heading", { name: /The upgrade needs 1\.00 GiB more on \/$/ })).toBeInTheDocument();

    const preflights = () => calls.filter(([cmd]) => cmd === "preflight-upgrade");
    expect(preflights()).toEqual([["preflight-upgrade", "glibc"]]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to upgrade" }));
    });
    await waitFor(() => expect(updatesTab()).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(preflights()).toEqual([["preflight-upgrade", "glibc"], ["preflight-upgrade", "glibc"]]));
    expect(await screen.findByRole("dialog", { name: /^Upgrade / })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to upgrade", hidden: true })).not.toBeInTheDocument();
  });

  describe("waiting upgrade across tabs", () => {
    const waitingText = "An upgrade is waiting for 1.00 GiB on /";

    async function blockIntoCache() {
      const calls = answerBackend({
        "check-updates": () => ({ updates: [update("linux"), update("glibc")], warnings: [] }),
        "preflight-upgrade": () => fullDisk,
        "cache-info": () => ({ ...emptyCache, total_size: GIB, package_count: 1 }),
      });
      render(<AnnouncerProvider><App /></AnnouncerProvider>);
      await finishLandingLoad();
      await screen.findByRole("button", { name: "glibc" });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Apply 2 updates/ }));
      });
      const dialog = await screen.findByRole("dialog", { name: /^Upgrade / });
      fireEvent.click(within(dialog).getByRole("button", { name: "Open Cache" }));
      await waitFor(() => expect(screen.getByRole("tab", { name: "Cache" })).toHaveAttribute("aria-selected", "true"));
      await screen.findByRole("heading", { name: /The upgrade needs 1\.00 GiB more on \/$/ });
      return calls;
    }

    const installedPanel = () => screen.getByRole("tabpanel", { name: "Installed packages" });
    const lineShown = () => screen.queryAllByText(waitingText).some((el) => !el.closest("[aria-live]"));

    it("keeps the way back on Installed after Review orphans and returns into the preview", async () => {
      const calls = await blockIntoCache();
      expect(lineShown()).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: "Review orphans" }));
      await waitFor(() => expect(screen.getByRole("tab", { name: "Installed packages" })).toHaveAttribute("aria-selected", "true"));
      expect(mockLocationGo).toHaveBeenLastCalledWith(["installed"], { filter: "orphan" });
      expect(within(installedPanel()).getByText(waitingText)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(waitingText));

      const preflights = () => calls.filter(([cmd]) => cmd === "preflight-upgrade");
      expect(preflights()).toHaveLength(1);
      await act(async () => {
        fireEvent.click(within(installedPanel()).getByRole("button", { name: "Back to upgrade" }));
      });
      await waitFor(() => expect(updatesTab()).toHaveAttribute("aria-selected", "true"));
      await waitFor(() => expect(preflights()).toHaveLength(2));
      expect(preflights()[1]).toEqual(preflights()[0]);
      expect(await screen.findByRole("dialog", { name: /^Upgrade / })).toBeInTheDocument();
      expect(lineShown()).toBe(false);
    });

    it("survives a plain switch from Cache and ends on Dismiss", async () => {
      await blockIntoCache();
      fireEvent.click(screen.getByRole("tab", { name: "History" }));
      await waitFor(() => expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true"));
      const historyPanel = screen.getByRole("tabpanel", { name: "History" });
      expect(within(historyPanel).getByText(waitingText)).toBeInTheDocument();

      fireEvent.click(within(historyPanel).getByRole("button", { name: "Dismiss the waiting upgrade" }));
      expect(lineShown()).toBe(false);
      fireEvent.click(screen.getByRole("tab", { name: "Cache" }));
      await waitFor(() => expect(screen.getByRole("tab", { name: "Cache" })).toHaveAttribute("aria-selected", "true"));
      expect(screen.queryByRole("heading", { name: /The upgrade needs/ })).not.toBeInTheDocument();
    });

    it("ends when a new check starts", async () => {
      await blockIntoCache();
      fireEvent.click(updatesTab());
      await waitFor(() => expect(updatesTab()).toHaveAttribute("aria-selected", "true"));
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
      });
      await finishLandingLoad();
      fireEvent.click(screen.getByRole("tab", { name: "History" }));
      await waitFor(() => expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true"));
      expect(lineShown()).toBe(false);
    });
  });
});

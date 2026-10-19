import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { MirrorsView, describeMirrorChanges } from "./MirrorsView";
import * as api from "../api";
import { mockPermission } from "../test/setup";
import { sweepA11y } from "../test/a11ySweep";


function configurationResult<T extends { backup_path: string | null }>(result: T) {
  return { warnings: [] as string[], revision: "saved-revision", backup_timestamp: result.backup_path ? Number(result.backup_path.split(".").slice(-1)[0]) : null, ...result };
}

const fileWatchers = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../systemWatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../systemWatch")>()),
  watchFile: vi.fn((path: string, onChange: () => void) => {
    fileWatchers.set(path, onChange);
    return { close: () => fileWatchers.delete(path) };
  }),
}));

const announceSpy = vi.hoisted(() => vi.fn());
vi.mock("../contexts/AnnouncerContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contexts/AnnouncerContext")>()),
  useAnnounce: () => announceSpy,
}));

const changeOutside = () => act(async () => {
  fileWatchers.get("/etc/pacman.d/mirrorlist")?.();
});

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listMirrors: vi.fn(),
    fetchMirrorStatus: vi.fn(),
    testMirrors: vi.fn(),
    saveMirrorlist: vi.fn(),
    listMirrorBackups: vi.fn(),
    restoreMirrorBackup: vi.fn(),
    undoMirrorSave: vi.fn(),
    deleteMirrorBackup: vi.fn(),
    refreshMirrors: vi.fn(),
    getActiveTransaction: vi.fn(() => null),
    onActiveTransactionChanged: vi.fn(() => () => {}),
  };
});

const mockListMirrors = vi.mocked(api.listMirrors);
const mockFetchMirrorStatus = vi.mocked(api.fetchMirrorStatus);
const mockTestMirrors = vi.mocked(api.testMirrors);
const mockSaveMirrorlist = vi.mocked(api.saveMirrorlist);
const mockListMirrorBackups = vi.mocked(api.listMirrorBackups);
const mockUndoMirrorSave = vi.mocked(api.undoMirrorSave);
const mockRestoreMirrorBackup = vi.mocked(api.restoreMirrorBackup);
const mockDeleteMirrorBackup = vi.mocked(api.deleteMirrorBackup);
const mockRefreshMirrors = vi.mocked(api.refreshMirrors);
const mockGetActiveTransaction = vi.mocked(api.getActiveTransaction);

const rankedResponse: api.RefreshMirrorsResponse = {
  mirrors: [
    { url: "https://ranked1.example.org/$repo/os/$arch", enabled: true, comment: "Germany" },
    { url: "https://ranked2.example.org/$repo/os/$arch", enabled: true, comment: "France" },
  ],
  total: 2,
  last_check: null,
};

const oneBackup: api.MirrorBackupListResponse = { warnings: [],
  backups: [
    { timestamp: 1704067200, date: "2024-01-01 00:00:00 UTC", enabled_count: 3, total_count: 10, size: 2048, source: "manual" },
  ],
};

const renderLoaded = async () => {
  render(<MirrorsView />);
  await waitFor(() => expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument());
};

const toggleSecondMirror = async () => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole("switch")[1]);
  });
};

const mockMirrorResponse: api.MirrorListResponse = { revision: "rev-1",
  mirrors: [
    {
      url: "https://mirror1.example.com/$repo/os/$arch",
      enabled: true,
      comment: "Fast mirror",
    },
    {
      url: "https://mirror2.example.com/$repo/os/$arch",
      enabled: false,
      comment: "",
    },
  ],
  total: 2,
  enabled_count: 1,
  path: "/etc/pacman.d/mirrorlist",
  last_modified: 1704067200,
};

describe("MirrorsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUndoMirrorSave.mockResolvedValue({ success: true, revision: "undo-revision", backup_timestamp: null, backup_path: null, warnings: [] });
    window.localStorage.clear();
    mockListMirrors.mockResolvedValue({ ...mockMirrorResponse, revision: "rev-1" } as api.MirrorListResponse);
    mockRefreshMirrors.mockResolvedValue(rankedResponse);
    mockGetActiveTransaction.mockReturnValue(null);
    mockFetchMirrorStatus.mockResolvedValue({
      mirrors: [],
      total: 0,
      last_check: null,
    });
    mockTestMirrors.mockImplementation((callbacks) => {
      setTimeout(() => callbacks.onComplete?.(), 0);
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    // Pre-populate status cache so the auto-fetch effect uses the cache path
    const cached = {
      data: { mirrors: [], total: 0, last_check: null },
      timestamp: Date.now(),
    };
    window.localStorage.setItem("cockpit-pacman-mirror-status", JSON.stringify(cached));
  });

  afterEach(() => {
    cleanup();
  });

  it("preserves backup-history and mirror-test diagnostics", async () => {
    mockListMirrorBackups.mockRejectedValue(new api.BackendError("History unavailable", "permission_denied", "Directory /etc/pacman.d is not readable"));
    mockTestMirrors.mockImplementation((callbacks) => {
      window.queueMicrotask(() => callbacks.onError?.("Mirror test failed", "internal_error", "Failed to create the HTTP client"));
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    await renderLoaded();
    await screen.findByText("Failed to create the HTTP client");
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    expect(screen.getByText("Directory /etc/pacman.d is not readable")).toBeInTheDocument();
    expect(screen.queryByText(/No backups found/)).not.toBeInTheDocument();
  });

  it("preserves every failed backup deletion and successful deletion warnings", async () => {
    mockListMirrorBackups.mockResolvedValue({ backups: [100, 200, 300].map(timestamp => ({ timestamp, date: String(timestamp), total_count: 2, enabled_count: 2, size: 200, source: "manual" })), warnings: ["One backup could not be read"] });
    mockDeleteMirrorBackup.mockRejectedValueOnce(new api.BackendError("First failed", "permission_denied", "First backup is read-only"));
    mockDeleteMirrorBackup.mockRejectedValueOnce(new api.BackendError("Second failed", "internal_error", "Second backup directory could not be synced"));
    mockDeleteMirrorBackup.mockResolvedValueOnce(configurationResult({ success: true, backup_path: null, message: "Deleted", warnings: ["Backup provenance could not be saved"] }));
    await renderLoaded();
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    fireEvent.click(screen.getByLabelText("Select all backups"));
    fireEvent.click(screen.getByRole("button", { name: "Delete (3)" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete 3 backups" })); });
    expect(screen.getByText(/First backup is read-only/)).toHaveTextContent("Second backup directory could not be synced");
    expect(screen.getByText("Backup provenance could not be saved")).toBeInTheDocument();
    expect(screen.getByText("One backup could not be read")).toBeInTheDocument();
  });

  it("keeps maintenance warnings after a successful mirror save", async () => {
    mockSaveMirrorlist.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Saved", warnings: ["Backup provenance could not be saved"] }));
    await renderLoaded();
    await toggleSecondMirror();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Save changes/i })); });
    expect(screen.getByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ })).toBeInTheDocument();
    expect(screen.getByText("Backup provenance could not be saved")).toBeInTheDocument();
  });

  it("defaults ranking to HTTPS and warns before including HTTP mirrors", async () => {
    await renderLoaded();
    const rank = screen.getByRole("button", { name: "Rank mirrors" });
    await waitFor(() => expect(rank).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(rank);
    await screen.findByRole("dialog", { name: "Rank mirrors" });
    const protocol = screen.getByLabelText("Protocol");
    expect(protocol).toHaveValue("https");
    expect(screen.queryByText("HTTP does not protect package database transfers")).not.toBeInTheDocument();
    fireEvent.change(protocol, { target: { value: "all" } });
    expect(screen.getByText("HTTP does not protect package database transfers")).toBeInTheDocument();
  });

  it("warns about enabled HTTP mirrors before saving", async () => {
    mockListMirrors.mockResolvedValue({ ...mockMirrorResponse, mirrors: [{ ...mockMirrorResponse.mirrors[0], url: "http://mirror1.example.com/$repo/os/$arch" }] });
    await renderLoaded();
    expect(screen.getByText("HTTP does not protect package database transfers")).toBeInTheDocument();
    expect(mockSaveMirrorlist).not.toHaveBeenCalled();
  });

  it("shows loading state initially", () => {
    mockListMirrors.mockImplementation(() => new Promise(() => {}));
    render(<MirrorsView />);
    expect(screen.getByText(/Loading mirrors/i)).toBeInTheDocument();
  });

  it("renders mirror list after loading", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    expect(screen.getByText(/mirror2\.example\.com/)).toBeInTheDocument();
  });

  it("exposes help as named buttons that do not sort their column", async () => {
    render(<MirrorsView />);
    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    expect(screen.getAllByRole("button", { name: /^More information about/ })).toHaveLength(3);
    const latencyHeader = screen.getByRole("columnheader", { name: /Latency/ });
    const before = latencyHeader.getAttribute("aria-sort");
    fireEvent.click(screen.getByRole("button", { name: "More information about latency" }));
    expect(await screen.findByText(/Round-trip time from this machine/)).toBeInTheDocument();
    expect(latencyHeader.getAttribute("aria-sort")).toBe(before);
  });

  it("shows stat boxes with counts", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    // Total count and enabled count
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  // Each test renders a full 50-row page, which takes over 20 s under a loaded full run.
  describe("pagination", { timeout: 60000 }, () => {
    const makeMirrors = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        url: `https://mpage${String(i).padStart(4, "0")}.test/$repo/os/$arch`,
        enabled: true,
        comment: "",
      }));

    const respond = (n: number) =>
      mockListMirrors.mockResolvedValue({ revision: "rev-1",
        mirrors: makeMirrors(n),
        total: n,
        enabled_count: n,
        path: "/etc/pacman.d/mirrorlist",
        last_modified: 1704067200,
      });

    it("renders only the first page (50) and pages to the rest", async () => {
      respond(60);
      render(<MirrorsView />);
      await waitFor(() => expect(screen.getByText(/mpage0000\./)).toBeInTheDocument());

      expect(screen.queryByText(/mpage0055\./)).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Go to next page"));
      });

      await waitFor(() => expect(screen.getByText(/mpage0055\./)).toBeInTheDocument());
      expect(screen.queryByText(/mpage0000\./)).not.toBeInTheDocument();
    });

    it("resets to page 1 when the filter changes", async () => {
      respond(60);
      render(<MirrorsView />);
      await waitFor(() => expect(screen.getByText(/mpage0000\./)).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Go to next page"));
      });
      await waitFor(() => expect(screen.getByText(/mpage0055\./)).toBeInTheDocument());

      const search = screen.getByLabelText("Search mirrors");
      await act(async () => {
        fireEvent.change(search, { target: { value: "mpage000" } });
      });

      await waitFor(() => expect(screen.getByText(/mpage0000\./)).toBeInTheDocument());
      expect(screen.queryByText(/mpage0055\./)).not.toBeInTheDocument();
    });
  });

  it("shows error on API failure", async () => {
    mockListMirrors.mockRejectedValue(new Error("Permission denied"));
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/Could not load mirrors/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when no mirrors", async () => {
    mockListMirrors.mockResolvedValue({ revision: "rev-1",
      mirrors: [],
      total: 0,
      enabled_count: 0,
      path: "/etc/pacman.d/mirrorlist",
      last_modified: null,
    });
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/No mirrors found/i)).toBeInTheDocument();
    });
  });

  it("toggles mirror enabled state", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    const switches = screen.getAllByRole("switch");
    expect(switches[0]).toBeChecked(); // mirror1 enabled
    expect(switches[1]).not.toBeChecked(); // mirror2 disabled

    await act(async () => {
      fireEvent.click(switches[1]);
    });

    expect(switches[1]).toBeChecked();
  });

  it("enables save button after changes", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    expect(saveButton).toHaveAttribute("aria-disabled", "true");

    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[1]);
    });

    expect(saveButton).not.toHaveAttribute("aria-disabled", "true");
  });

  it("saves without a dialog and shows an inline success with Undo", async () => {
    mockSaveMirrorlist.mockResolvedValue(configurationResult({
      success: true,
      backup_path: "/etc/pacman.d/mirrorlist.backup.1704067300",
      message: "Mirrorlist saved",
    }));
    mockRestoreMirrorBackup.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Restored" }));
    await renderLoaded();
    await toggleSecondMirror();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockSaveMirrorlist).toHaveBeenCalledWith(
      [
        { url: "https://mirror1.example.com/$repo/os/$arch", enabled: true, comment: "Fast mirror" },
        { url: "https://mirror2.example.com/$repo/os/$arch", enabled: true, comment: "" },
      ],
      "rev-1",
    );
    expect(await screen.findByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ })).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Mirror list" })).toBeInTheDocument();
    expect(mockListMirrors).toHaveBeenCalledTimes(2);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mockUndoMirrorSave).toHaveBeenCalledWith(1704067300, "saved-revision");
    await waitFor(() => expect(mockListMirrors).toHaveBeenCalledTimes(3));
  });

  it("sends the revision from the latest load on a second save", async () => {
    mockSaveMirrorlist.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "ok" }));
    await renderLoaded();
    await toggleSecondMirror();
    mockListMirrors.mockResolvedValue({ ...mockMirrorResponse, revision: "rev-2" } as api.MirrorListResponse);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });
    await screen.findByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ });

    await toggleSecondMirror();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });
    expect(mockSaveMirrorlist).toHaveBeenLastCalledWith(expect.any(Array), "rev-2");
  });

  it("lists pending changes expanded, and Discard can be undone without a read", async () => {
    await renderLoaded();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    await toggleSecondMirror();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1]);
    });

    expect(screen.getByRole("button", { name: "Pending changes (2)" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Enable https://mirror2.example.com/$repo/os/$arch")).toBeVisible();
    expect(screen.getByText("Reorder 2 mirrors")).toBeVisible();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    });
    expect(mockListMirrors).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("switch")[1]).not.toBeChecked();
    expect(screen.queryByRole("button", { name: /Pending changes/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Changes/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Search mirrors")).toHaveFocus();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(screen.getByRole("button", { name: "Pending changes (2)" })).toBeInTheDocument();
    expect(screen.getAllByRole("switch")[0]).toBeChecked();
  });

  it("marks an edited mirror and reverts it alone", async () => {
    await renderLoaded();
    await toggleSecondMirror();
    expect(screen.getByText("Edited")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revert changes to https://mirror2.example.com/$repo/os/$arch" }));
    });
    expect(screen.queryByText("Edited")).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")[1]).not.toBeChecked();
    expect(screen.queryByRole("button", { name: /Pending changes/ })).not.toBeInTheDocument();
  });

  it("shows the resulting Server lines as text before saving", async () => {
    await renderLoaded();
    await toggleSecondMirror();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "View result as text" }));
    });
    expect(document.querySelector(".pf-v6-c-code-block__code")?.textContent).toBe(
      "## Fast mirror\nServer = https://mirror1.example.com/$repo/os/$arch\nServer = https://mirror2.example.com/$repo/os/$arch",
    );
  });

  it("locks the switches and Move buttons while the save is in flight", async () => {
    let finish: (() => void) | undefined;
    mockSaveMirrorlist.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve(configurationResult({ success: true, backup_path: null, message: "ok" }));
    }));
    await renderLoaded();
    await toggleSecondMirror();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });

    const first = screen.getAllByRole("switch")[0];
    expect(first).toHaveAttribute("aria-disabled", "true");
    expect(first).toHaveAccessibleDescription("/etc/pacman.d/mirrorlist is being written");
    expect(screen.getAllByRole("button", { name: "Move down" })[0]).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(first);
    });
    expect(first).toBeChecked();

    await act(async () => {
      finish?.();
    });
    await screen.findByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ });
    expect(screen.getAllByRole("switch")[0]).not.toHaveAttribute("aria-disabled");
  });

  it("names the cause of a failed status fetch and offers Try again", async () => {
    window.localStorage.clear();
    mockFetchMirrorStatus.mockRejectedValueOnce(new Error("archlinux.org timed out"));
    await renderLoaded();
    const heading = await screen.findByRole("heading", { name: /Mirror status could not be fetched/ });
    const alert = heading.closest(".pf-v6-c-alert") as HTMLElement;
    expect(alert).toHaveTextContent("archlinux.org timed out");
    expect(screen.queryByRole("heading", { name: /^Warning alert: Error$/ })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    });
    expect(mockFetchMirrorStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Mirror status could not be fetched/ })).not.toBeInTheDocument());
  });

  it("a failed restore shows above the table with Try again", async () => {
    mockListMirrorBackups.mockResolvedValue(oneBackup);
    mockRestoreMirrorBackup.mockRejectedValueOnce(new Error("backup is unreadable"));
    await renderLoaded();
    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    });
    const heading = await screen.findByRole("heading", { name: /\/etc\/pacman.d\/mirrorlist not restored/ });
    expect(heading.closest(".pf-v6-c-alert")).toHaveTextContent("backup is unreadable");
  });

  it("aria-disables Save with a reason and hints at ranking when no mirror is enabled", async () => {
    await renderLoaded();
    expect(screen.queryByRole("heading", { name: /No mirror is enabled/ })).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("switch")[0]);
    });

    const save = screen.getByRole("button", { name: /Save Changes/i });
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(save);
    expect(mockSaveMirrorlist).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /No mirror is enabled/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Rank mirrors" })).toHaveLength(2);
  });

  it("keeps Save enabled while the automatic mirror test runs and blocks ranking with a reason", async () => {
    mockTestMirrors.mockImplementation(() => ({ cancel: vi.fn(), forceStop: vi.fn() }));
    await renderLoaded();
    await waitFor(() => expect(mockTestMirrors).toHaveBeenCalledTimes(1));
    await toggleSecondMirror();

    expect(screen.getByRole("button", { name: /Save Changes/i })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /Save Changes/i })).not.toHaveAttribute("aria-disabled", "true");
    const rank = screen.getAllByRole("button", { name: "Rank mirrors" })[0];
    expect(rank).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(rank);
    expect(mockRefreshMirrors).not.toHaveBeenCalled();
  });

  it("runs the automatic mirror test once, not again after a save", async () => {
    mockSaveMirrorlist.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "ok" }));
    await renderLoaded();
    await waitFor(() => expect(mockTestMirrors).toHaveBeenCalledTimes(1));
    await toggleSecondMirror();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });
    await screen.findByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockTestMirrors).toHaveBeenCalledTimes(1);
  });

  it("disables Save with the running transaction as the reason", async () => {
    mockGetActiveTransaction.mockReturnValue({ command: "upgrade", startedAt: Date.now() });
    await renderLoaded();
    await toggleSecondMirror();
    const save = screen.getByRole("button", { name: /Save Changes/i });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.focus(save);
      fireEvent.mouseEnter(save);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/An upgrade is running/);
    fireEvent.click(save);
    expect(mockSaveMirrorlist).not.toHaveBeenCalled();
  });

  it("'Clear sort' restores file order and re-enables Move", async () => {
    await renderLoaded();
    expect(screen.queryByRole("button", { name: "Clear sort" })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(screen.getByRole("columnheader", { name: /URL/ })).getByRole("button"));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("columnheader", { name: /URL/ })).getByRole("button"));
    });
    const urls = () => screen.getAllByText(/mirror[12]\.example\.com/).map((n) => n.textContent);
    expect(urls()[0]).toMatch(/mirror2/);
    for (const move of screen.getAllByRole("button", { name: /Move (up|down)/ })) {
      expect(move).toHaveAttribute("aria-disabled", "true");
    }

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear sort" }));
    });
    expect(urls()[0]).toMatch(/mirror1/);
    expect(screen.queryByRole("button", { name: "Clear sort" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Move down" })[0]).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByRole("button", { name: "Move down" })[0]).not.toBeDisabled();
  });

  describe("ranking", () => {
    it("opening the rank modal generates the ranking without another click", async () => {
      await renderLoaded();
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Rank mirrors" })[0]).not.toHaveAttribute("aria-disabled", "true"));
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Rank mirrors" })[0]);
      });
      expect(mockRefreshMirrors).toHaveBeenCalledTimes(1);
      const dialog = screen.getByRole("dialog", { name: "Rank mirrors" });
      expect(await within(dialog).findByText(/ranked1\.example\.org/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Replace mirrorlist (2 mirrors)" })).not.toBeDisabled();
      expect(mockRefreshMirrors).toHaveBeenCalledTimes(1);
    });

    it("'Replace mirrorlist' saves the previewed list with the revision and returns to the table", async () => {
      mockSaveMirrorlist.mockResolvedValue(configurationResult({
        success: true,
        backup_path: "/etc/pacman.d/mirrorlist.backup.1704067400",
        message: "ok",
      }));
      mockRestoreMirrorBackup.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Restored" }));
      await renderLoaded();
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Rank mirrors" })[0]).not.toHaveAttribute("aria-disabled", "true"));
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Rank mirrors" })[0]);
      });
      mockListMirrors.mockResolvedValue({ revision: "rev-1",
        mirrors: rankedResponse.mirrors,
        total: 2,
        enabled_count: 2,
        path: "/etc/pacman.d/mirrorlist",
        last_modified: 1704067400,
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Replace mirrorlist (2 mirrors)" }));
      });

      expect(mockSaveMirrorlist).toHaveBeenCalledWith(rankedResponse.mirrors, "rev-1");
      expect(await screen.findByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ })).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("grid", { name: "Mirror list" })).toHaveTextContent(/ranked1\.example\.org/);
      expect(screen.getByRole("button", { name: /Save Changes/i })).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(mockUndoMirrorSave).toHaveBeenCalledWith(1704067400, "saved-revision");
    });

    const statusFor = (url: string, country: string, code: string): api.MirrorStatus => ({
      url, country, country_code: code, last_sync: null, delay: null, score: 1,
      completion_pct: 100, active: true, ipv4: true, ipv6: false,
    });

    const cacheStatus = (mirrors: api.MirrorStatus[]) => {
      window.localStorage.setItem("cockpit-pacman-mirror-status", JSON.stringify({
        data: { mirrors, total: mirrors.length, last_check: null },
        timestamp: Date.now(),
      }));
    };

    const openRank = async () => {
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Rank mirrors" })[0]).not.toHaveAttribute("aria-disabled", "true"));
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Rank mirrors" })[0]);
      });
      return screen.getByRole("dialog", { name: "Rank mirrors" });
    };

    it("shows the ranked table first with the options collapsed behind the result count", async () => {
      await renderLoaded();
      const dialog = await openRank();
      await within(dialog).findByText(/ranked1\.example\.org/);
      const toggle = within(dialog).getByRole("button", { name: "Ranking options (2 mirrors found)" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(within(dialog).queryByLabelText("Country")).not.toBeVisible();
      const table = within(dialog).getByRole("grid", { name: "Preview mirrors" });
      expect(table.compareDocumentPosition(toggle) & table.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("makes the scrolling preview a focusable, named region", async () => {
      await renderLoaded();
      const dialog = await openRank();
      await within(dialog).findByText(/ranked1\.example\.org/);
      const region = within(dialog).getByRole("region", { name: "Mirror changes" });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(within(region).getByRole("grid", { name: "Preview mirrors" })).toBeInTheDocument();
      region.focus();
      expect(document.activeElement).toBe(region);
      sweepA11y({ dialogs: ["Rank mirrors"] });
    });

    it("defaults Country to the country most enabled mirrors are in", async () => {
      cacheStatus([
        statusFor("https://mirror1.example.com/", "Germany", "DE"),
        statusFor("https://mirror2.example.com/", "France", "FR"),
      ]);
      await renderLoaded();
      await openRank();
      expect(mockRefreshMirrors).toHaveBeenCalledWith(expect.objectContaining({ country: "DE" }));
      expect(screen.getByLabelText("Country")).toHaveValue("DE");
    });

    it("re-ranks 300 ms after an option change and keeps Replace disabled until the new list arrives", async () => {
      cacheStatus([
        statusFor("https://mirror1.example.com/", "Germany", "DE"),
        statusFor("https://mirror2.example.com/", "France", "FR"),
      ]);
      await renderLoaded();
      const dialog = await openRank();
      const replace = await within(dialog).findByRole("button", { name: "Replace mirrorlist (2 mirrors)" });
      await waitFor(() => expect(replace).not.toHaveAttribute("aria-disabled", "true"));

      let resolveFrance: ((r: api.RefreshMirrorsResponse) => void) | undefined;
      mockRefreshMirrors.mockImplementationOnce(() => new Promise((resolve) => { resolveFrance = resolve; }));
      fireEvent.click(within(dialog).getByRole("button", { name: /^Ranking options/ }));
      fireEvent.change(within(dialog).getByLabelText("Country"), { target: { value: "FR" } });

      expect(replace).toHaveAttribute("aria-disabled", "true");
      expect(replace).toHaveAccessibleDescription("Ranking with the new options");
      expect(within(dialog).getByText(/ranked1\.example\.org/).closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
      expect(mockRefreshMirrors).toHaveBeenCalledTimes(1);

      await waitFor(() => expect(mockRefreshMirrors).toHaveBeenCalledTimes(2));
      expect(mockRefreshMirrors).toHaveBeenLastCalledWith(expect.objectContaining({ country: "FR" }));
      expect(replace).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        resolveFrance?.({
          mirrors: [{ url: "https://fr.example.org/$repo/os/$arch", enabled: true, comment: "France" }],
          total: 1,
          last_check: null,
        });
      });
      const replaceFrance = within(dialog).getByRole("button", { name: "Replace mirrorlist (1 mirror)" });
      expect(replaceFrance).not.toHaveAttribute("aria-disabled", "true");
      expect(within(dialog).getByText(/fr\.example\.org/)).toBeInTheDocument();
      expect(within(dialog).queryByText(/ranked1\.example\.org/)).not.toBeInTheDocument();
    });

    it("drops a ranking that resolves after newer options were requested", async () => {
      await renderLoaded();
      let resolveFirst: ((r: api.RefreshMirrorsResponse) => void) | undefined;
      mockRefreshMirrors.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
      const dialog = await openRank();
      fireEvent.click(within(dialog).getByRole("button", { name: /^Ranking options/ }));
      fireEvent.change(within(dialog).getByLabelText("Protocol"), { target: { value: "all" } });
      await waitFor(() => expect(mockRefreshMirrors).toHaveBeenCalledTimes(2));
      await within(dialog).findByText(/ranked1\.example\.org/);
      await act(async () => {
        resolveFirst?.({
          mirrors: [{ url: "https://old.example.org/$repo/os/$arch", enabled: true, comment: null }],
          total: 1,
          last_check: null,
        });
      });
      expect(within(dialog).queryByText(/old\.example\.org/)).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Replace mirrorlist (2 mirrors)" })).not.toHaveAttribute("aria-disabled", "true");
    });

    it("confirms before Replace discards unsaved edits, and Keep my changes saves nothing", async () => {
      await renderLoaded();
      await toggleSecondMirror();
      const dialog = await openRank();
      await act(async () => {
        fireEvent.click(await within(dialog).findByRole("button", { name: "Replace mirrorlist (2 mirrors)" }));
      });
      expect(within(dialog).getByRole("heading", { name: /Replacing discards your 1 unsaved change/ })).toBeInTheDocument();
      const confirm = within(dialog).getByRole("button", { name: "Discard 1 unsaved change and replace" });
      expect(confirm).toHaveFocus();
      expect(mockSaveMirrorlist).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Keep my changes" }));
      });
      expect(within(dialog).getByRole("button", { name: "Replace mirrorlist (2 mirrors)" })).toHaveFocus();
      expect(mockSaveMirrorlist).not.toHaveBeenCalled();
    });

    it("restores the draft from before the replace when the save fails", async () => {
      mockSaveMirrorlist.mockRejectedValueOnce(new Error("write failed"));
      await renderLoaded();
      await toggleSecondMirror();
      const dialog = await openRank();
      await act(async () => {
        fireEvent.click(await within(dialog).findByRole("button", { name: "Replace mirrorlist (2 mirrors)" }));
      });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Discard 1 unsaved change and replace" }));
      });

      expect(mockSaveMirrorlist).toHaveBeenCalledWith(rankedResponse.mirrors, "rev-1");
      expect(await screen.findByRole("heading", { name: /Mirrorlist not saved/ })).toBeInTheDocument();
      expect(screen.getByText(/Your changes are still here/)).toBeInTheDocument();
      const grid = screen.getByRole("grid", { name: "Mirror list" });
      expect(grid).toHaveTextContent(/mirror2\.example\.com/);
      expect(grid).not.toHaveTextContent(/ranked1\.example\.org/);
      expect(screen.getAllByRole("switch")[1]).toBeChecked();
    });

    it("'Edit before saving' puts the ranking in the table unsaved", async () => {
      await renderLoaded();
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Rank mirrors" })[0]).not.toHaveAttribute("aria-disabled", "true"));
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Rank mirrors" })[0]);
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Edit before saving" }));
      });
      expect(mockSaveMirrorlist).not.toHaveBeenCalled();
      expect(screen.getByRole("grid", { name: "Mirror list" })).toHaveTextContent(/ranked2\.example\.org/);
      expect(screen.getByRole("button", { name: /Save Changes/i })).not.toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("outside edits", () => {
    const changed = "mirrorlist changed since it was read";
    const rejectChanged = () =>
      mockSaveMirrorlist.mockRejectedValueOnce(
        new api.BackendError(changed, "config_changed", changed),
      );

    it("config_changed keeps the edits and shows the outside change before a confirmed overwrite", async () => {
      rejectChanged();
      mockSaveMirrorlist.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "ok" }));
      await renderLoaded();
      await toggleSecondMirror();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });

      expect(await screen.findByRole("heading", { name: /changed since you started editing/ })).toBeInTheDocument();
      expect(screen.getAllByRole("switch")[1]).toBeChecked();
      expect(screen.getByRole("button", { name: "Reload and reapply my 1 change" })).toBeInTheDocument();

      mockListMirrors.mockResolvedValueOnce({
        ...mockMirrorResponse,
        mirrors: [...mockMirrorResponse.mirrors, { url: "https://outside.example.org/$repo/os/$arch", enabled: true, comment: null }],
        revision: "rev-2",
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save my version anyway" }));
      });
      const dialog = screen.getByRole("dialog", { name: /Replace mirrorlist\?/ });
      expect(await within(dialog).findByText("Add https://outside.example.org/$repo/os/$arch")).toBeInTheDocument();
      expect(mockSaveMirrorlist).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Replace mirrorlist" }));
      });
      expect(mockSaveMirrorlist).toHaveBeenCalledTimes(2);
      expect(mockSaveMirrorlist).toHaveBeenLastCalledWith(expect.any(Array), "rev-2");
      expect(await screen.findByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ })).toBeInTheDocument();
    });

    it("an outside change rebases a pending toggle, keeps focus and saves against the new revision", async () => {
      mockListMirrorBackups.mockResolvedValue(oneBackup);
      await renderLoaded();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Backup history/ }));
      });
      await waitFor(() => expect(mockListMirrorBackups).toHaveBeenCalledTimes(1));
      await toggleSecondMirror();
      const toggled = screen.getAllByRole("switch")[1];
      toggled.focus();
      mockListMirrors.mockResolvedValue({
        ...mockMirrorResponse,
        mirrors: [{ url: "https://outside.example.org/$repo/os/$arch", enabled: true, comment: null }, ...mockMirrorResponse.mirrors],
        revision: "rev-2",
      });
      await changeOutside();

      expect(await screen.findByRole("heading", { name: /mirrorlist changed since you started editing/ })).toBeInTheDocument();
      expect(screen.getByText(/Your 1 change was reapplied/)).toBeInTheDocument();
      expect(screen.getByText("https://outside.example.org/$repo/os/$arch")).toBeInTheDocument();
      expect(screen.getAllByRole("switch").map((el) => (el as HTMLInputElement).checked)).toEqual([true, true, true]);
      expect(document.activeElement).toBe(toggled);
      await waitFor(() => expect(mockListMirrorBackups).toHaveBeenCalledTimes(2));

      mockSaveMirrorlist.mockResolvedValueOnce(configurationResult({ success: true, backup_path: null, message: "ok" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });
      expect(mockSaveMirrorlist).toHaveBeenCalledTimes(1);
      expect(mockSaveMirrorlist).toHaveBeenLastCalledWith(expect.any(Array), "rev-2");
    });

    it("an echo of its own save or an unchanged file changes nothing", async () => {
      await renderLoaded();
      await toggleSecondMirror();
      await changeOutside();
      expect(screen.queryByRole("heading", { name: /changed since you started editing/ })).not.toBeInTheDocument();
      expect(screen.getAllByRole("switch")[1]).toBeChecked();

      mockSaveMirrorlist.mockResolvedValueOnce(configurationResult({ success: true, backup_path: null, message: "ok", revision: "rev-2" }));
      mockListMirrors.mockResolvedValue({
        ...mockMirrorResponse,
        mirrors: mockMirrorResponse.mirrors.map((m) => ({ ...m, enabled: true })),
        revision: "rev-2",
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });
      expect(await screen.findByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ })).toBeInTheDocument();
      await toggleSecondMirror();
      await changeOutside();
      expect(screen.queryByRole("heading", { name: /changed since you started editing/ })).not.toBeInTheDocument();
      expect(screen.getAllByRole("switch")[1]).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Pending changes (1)" })).toBeInTheDocument();
    });

    it("a failed outside reread keeps the table, the edit and the revision", async () => {
      await renderLoaded();
      await toggleSecondMirror();
      mockListMirrors.mockRejectedValueOnce(new Error("read failed"));
      await changeOutside();

      const alert = await screen.findByRole("heading", { name: /Could not refresh mirrorlist/ });
      expect(alert.closest(".pf-v6-c-alert")).toHaveTextContent("Your 1 unsaved change is still here");
      expect(screen.queryByText(/Could not load mirrors/)).not.toBeInTheDocument();
      expect(screen.getAllByRole("switch")[1]).toBeChecked();
      expect(screen.getByRole("button", { name: "Pending changes (1)" })).toBeInTheDocument();

      mockSaveMirrorlist.mockResolvedValueOnce(configurationResult({ success: true, backup_path: null, message: "ok" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });
      expect(mockSaveMirrorlist).toHaveBeenLastCalledWith(expect.any(Array), "rev-1");
    });

    it("an outside change with no edits shows a dismissable notice with its changes, announced once", async () => {
      await renderLoaded();
      mockListMirrors.mockResolvedValue({
        ...mockMirrorResponse,
        mirrors: mockMirrorResponse.mirrors.map((m) => ({ ...m, enabled: true })),
        revision: "rev-2",
      } as api.MirrorListResponse);
      announceSpy.mockClear();
      await changeOutside();

      const heading = await screen.findByRole("heading", { name: /mirrorlist changed at/ });
      expect(announceSpy).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole("switch")[1]).toBeChecked();
      const show = screen.getByRole("button", { name: "Show changes" });
      expect(show).toHaveAttribute("aria-expanded", "false");
      await act(async () => {
        fireEvent.click(show);
      });
      expect(screen.getByRole("button", { name: "Hide changes" })).toHaveAttribute("aria-expanded", "true");
      expect(within(heading.closest(".pf-v6-c-alert") as HTMLElement).getByRole("listitem")).toHaveTextContent("mirror2.example.com");
      expect(announceSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Close.*mirrorlist changed/ }));
      });
      expect(screen.queryByRole("heading", { name: /mirrorlist changed at/ })).not.toBeInTheDocument();
    });

    it("an outside change after a save removes Undo", async () => {
      mockSaveMirrorlist.mockResolvedValue(configurationResult({
        success: true,
        backup_path: "/etc/pacman.d/mirrorlist.backup.1704067300",
        message: "ok",
      }));
      await renderLoaded();
      await toggleSecondMirror();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });
      expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();

      mockListMirrors.mockResolvedValue({ ...mockMirrorResponse, revision: "rev-3" } as api.MirrorListResponse);
      await changeOutside();
      await screen.findByRole("heading", { name: /mirrorlist changed at/ });
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
      expect(mockRestoreMirrorBackup).not.toHaveBeenCalled();
    });

    it("a restore over a file changed since the last read asks first, naming the change", async () => {
      mockListMirrorBackups.mockResolvedValue(oneBackup);
      mockRestoreMirrorBackup.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Restored" }));
      await renderLoaded();
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      mockListMirrors.mockResolvedValue({
        ...mockMirrorResponse,
        mirrors: mockMirrorResponse.mirrors.map((m) => ({ ...m, enabled: true })),
        revision: "rev-2",
      } as api.MirrorListResponse);
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
      });

      const dialog = await screen.findByRole("dialog", { name: /Restore over the changed mirrorlist\?/ });
      expect(within(dialog).getByRole("listitem")).toHaveTextContent("mirror2.example.com");
      expect(mockRestoreMirrorBackup).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Replace changes and restore" }));
      });
      expect(mockRestoreMirrorBackup).toHaveBeenCalledWith(1704067200);
    });

    it("reapplies the edits on the reread mirrorlist, keeping the outside addition", async () => {
      rejectChanged();
      await renderLoaded();
      await toggleSecondMirror();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });
      mockListMirrors.mockResolvedValue({
        ...mockMirrorResponse,
        mirrors: [{ url: "https://outside.example.org/$repo/os/$arch", enabled: true, comment: null }, ...mockMirrorResponse.mirrors],
        revision: "rev-2",
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Reload and reapply my 1 change" }));
      });

      expect(await screen.findByRole("heading", { name: /Reapplied 1 change to the current file/ })).toBeInTheDocument();
      expect(screen.getByText("https://outside.example.org/$repo/os/$arch")).toBeInTheDocument();
      expect(screen.getAllByRole("switch").map((s) => (s as HTMLInputElement).checked)).toEqual([true, true, true]);

      mockSaveMirrorlist.mockResolvedValueOnce(configurationResult({ success: true, backup_path: null, message: "ok" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });
      expect(mockSaveMirrorlist).toHaveBeenLastCalledWith(expect.any(Array), "rev-2");
      expect(mockSaveMirrorlist.mock.calls[1][0].map((m) => m.url)).toEqual([
        "https://outside.example.org/$repo/os/$arch",
        "https://mirror1.example.com/$repo/os/$arch",
        "https://mirror2.example.com/$repo/os/$arch",
      ]);
    });
  });

  it("has search input for filtering mirrors", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("Search mirrors…")).toBeInTheDocument();
  });

  it("passes the a11y sweep on the mirror list", async () => {
    render(<MirrorsView />);
    await screen.findByText(/mirror1\.example\.com/);
    sweepA11y();
  });

  it("filters mirrors by search text", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search mirrors…");
    fireEvent.change(searchInput, { target: { value: "mirror1" } });

    expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/mirror2\.example\.com/)).not.toBeInTheDocument();
  });

  describe("reorder", () => {
    const threeMirrors: api.MirrorListResponse = {
      ...mockMirrorResponse,
      mirrors: [
        ...mockMirrorResponse.mirrors,
        { url: "https://mirror3.example.com/$repo/os/$arch", enabled: true, comment: "" },
      ],
      total: 3,
      revision: "rev-1",
    } as api.MirrorListResponse;

    const order = () =>
      screen.getAllByRole("switch").map((s) => s.getAttribute("aria-label")?.replace("Enable mirror https://", "").split(".")[0]);

    const kebabAction = async (url: string, action: string) => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: `More actions for ${url}` }));
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("menuitem", { name: action }));
      });
    };

    it("moves a mirror to the top and the bottom, with focus on its menu toggle", async () => {
      mockListMirrors.mockResolvedValue(threeMirrors);
      await renderLoaded();
      const third = "https://mirror3.example.com/$repo/os/$arch";

      await kebabAction(third, "Move to top");
      expect(order()).toEqual(["mirror3", "mirror1", "mirror2"]);
      await waitFor(() => expect(screen.getByRole("button", { name: `More actions for ${third}` })).toHaveFocus());
      expect(screen.getByRole("button", { name: /Save Changes/i })).not.toHaveAttribute("aria-disabled", "true");

      await kebabAction(third, "Move to bottom");
      expect(order()).toEqual(["mirror1", "mirror2", "mirror3"]);
      await waitFor(() => expect(screen.getByRole("button", { name: `More actions for ${third}` })).toHaveFocus());
    });

    it("keeps focus on the moved row's arrow, or its menu at the edge", async () => {
      mockListMirrors.mockResolvedValue(threeMirrors);
      await renderLoaded();
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
      });
      expect(order()).toEqual(["mirror2", "mirror1", "mirror3"]);
      expect(screen.getAllByRole("button", { name: "Move down" })[1]).toHaveFocus();

      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[1]);
      });
      expect(order()).toEqual(["mirror2", "mirror3", "mirror1"]);
      expect(screen.getByRole("button", { name: "More actions for https://mirror1.example.com/$repo/os/$arch" })).toHaveFocus();
    });

    it("pages to a mirror moved off the current page", async () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        url: `https://m${i}.example.com/$repo/os/$arch`, enabled: true, comment: "",
      }));
      mockListMirrors.mockResolvedValue({ ...mockMirrorResponse, mirrors: many, total: 60, enabled_count: 60, revision: "rev-1" } as api.MirrorListResponse);
      render(<MirrorsView />);
      await screen.findByText("https://m0.example.com/$repo/os/$arch");
      await kebabAction("https://m0.example.com/$repo/os/$arch", "Move to bottom");
      expect(await screen.findByText("https://m0.example.com/$repo/os/$arch")).toBeInTheDocument();
      expect(screen.queryByText("https://m1.example.com/$repo/os/$arch")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "More actions for https://m0.example.com/$repo/os/$arch" })).toHaveFocus());
    });

    it("blocks Move to top while a sort is applied, with a reason", async () => {
      mockListMirrors.mockResolvedValue(threeMirrors);
      await renderLoaded();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "URL" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "More actions for https://mirror3.example.com/$repo/os/$arch" }));
      });
      const item = await screen.findByRole("menuitem", { name: /Move to top/ });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAccessibleDescription("Clear the sort to reorder");
    });
  });

  it("shows move up/down buttons", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    const moveUpButtons = screen.getAllByRole("button", { name: /Move up/i });
    const moveDownButtons = screen.getAllByRole("button", { name: /Move down/i });

    expect(moveUpButtons.length).toBe(2);
    expect(moveDownButtons.length).toBe(2);

    expect(moveUpButtons[0]).toBeDisabled();
    expect(moveDownButtons[moveDownButtons.length - 1]).toBeDisabled();
  });

  it("shows backup history section", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    expect(screen.getByText("Backup history")).toBeInTheDocument();
  });

  it("loads backups when expanding backup history", async () => {
    mockListMirrorBackups.mockResolvedValue({ warnings: [],
      backups: [
        {
          timestamp: 1704067200,
          date: "2024-01-01 00:00:00 UTC",
          enabled_count: 3,
          total_count: 10,
          size: 2048,
          source: "manual",
        },
      ],
    });

    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });

    await waitFor(() => {
      expect(mockListMirrorBackups).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getAllByText(/ago$/).length).toBeGreaterThan(0);
      expect(screen.getByText("3 enabled / 10 total")).toBeInTheDocument();
    });
  });

  it("gates backup delete on the mutation gate and names an empty selection", async () => {
    mockListMirrorBackups.mockResolvedValue({ warnings: [],
      backups: [
        { timestamp: 1704067200, date: "2024-01-01 00:00:00 UTC", enabled_count: 3, total_count: 10, size: 2048, source: "manual" },
      ],
    });
    render(<MirrorsView />);
    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });
    const del = await screen.findByRole("button", { name: "Delete selected" });
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(del).toHaveAccessibleDescription("Select at least one backup");

    mockGetActiveTransaction.mockReturnValue({ command: "upgrade", startedAt: Date.now() });
    cleanup();
    render(<MirrorsView />);
    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });
    const blockedDelete = await screen.findByRole("button", { name: "Delete selected" });
    expect(blockedDelete).toHaveAccessibleDescription("An upgrade is running.");
    mockGetActiveTransaction.mockReturnValue(null);
  });

  it("distinguishes a backup you took from one taken for you", async () => {
    mockListMirrorBackups.mockResolvedValue({ warnings: [],
      backups: [
        {
          timestamp: 1704067200,
          date: "2024-01-01 00:00:00 UTC",
          enabled_count: 3,
          total_count: 10,
          size: 2048,
          source: "manual",
        },
        {
          timestamp: 1704063600,
          date: "2023-12-31 23:00:00 UTC",
          enabled_count: 2,
          total_count: 9,
          size: 1024,
          source: "auto",
        },
      ],
    });

    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });

    await waitFor(() => {
      expect(screen.getByText("Manual")).toBeInTheDocument();
    });
    expect(screen.getByText("Automatic")).toBeInTheDocument();
  });

  it("shows empty state when no backups exist", async () => {
    mockListMirrorBackups.mockResolvedValue({ warnings: [], backups: [] });

    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });

    await waitFor(() => {
      expect(screen.getByText(/No backups found/)).toBeInTheDocument();
    });
  });

  it("restores without a dialog when there are no edits, with Undo", async () => {
    mockListMirrorBackups.mockResolvedValue(oneBackup);
    mockRestoreMirrorBackup.mockResolvedValue(configurationResult({
      success: true,
      backup_path: "/etc/pacman.d/mirrorlist.backup.1704067201",
      message: "Restored",
    }));
    await renderLoaded();
    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockRestoreMirrorBackup).toHaveBeenCalledWith(1704067200);
    expect(await screen.findByRole("heading", { name: /Restored \/etc\/pacman.d\/mirrorlist from 2024-01-01/ })).toBeInTheDocument();
    expect(mockListMirrors).toHaveBeenCalledTimes(3);
    expect(mockListMirrorBackups).toHaveBeenCalledTimes(2);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mockUndoMirrorSave).toHaveBeenCalledWith(1704067201, "saved-revision");
  });

  it("names the edits a restore discards before restoring", async () => {
    mockListMirrorBackups.mockResolvedValue(oneBackup);
    mockRestoreMirrorBackup.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Restored" }));
    await renderLoaded();
    await toggleSecondMirror();
    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    });

    const dialog = screen.getByRole("dialog", { name: /Restore mirrorlist backup\?/ });
    expect(dialog).toHaveTextContent("Your 1 unsaved change to mirrorlist will be lost:");
    expect(within(dialog).getByText("Enable https://mirror2.example.com/$repo/os/$arch")).toBeInTheDocument();
    expect(mockRestoreMirrorBackup).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes and restore" }));
    });
    expect(mockRestoreMirrorBackup).toHaveBeenCalledWith(1704067200);
  });

  it("auto-runs mirror test on mount and renders latency after completion", async () => {
    let capturedCallbacks: Parameters<typeof api.testMirrors>[0] | null = null;
    mockTestMirrors.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<MirrorsView />);
    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(mockTestMirrors).toHaveBeenCalled();
    });

    expect(screen.getByText(/Starting mirror tests/)).toBeInTheDocument();

    await act(async () => {
      capturedCallbacks!.onTestResult!(
        { url: "https://mirror1.example.com/$repo/os/$arch", success: true, latency_ms: 42, speed_bps: null, error: null },
        1, 1
      );
    });

    expect(screen.getByText("42ms")).toBeInTheDocument();

    await act(async () => {
      capturedCallbacks!.onComplete!();
    });

    await waitFor(() => {
      expect(screen.queryByText(/Starting mirror tests/)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Sort by latency/)).not.toBeInTheDocument();
  });

  it("re-runs auto-test after retry from error state", async () => {
    mockListMirrors.mockRejectedValueOnce(new Error("network error"));

    render(<MirrorsView />);
    await waitFor(() => {
      expect(screen.getByText(/Could not load mirrors/)).toBeInTheDocument();
    });

    mockListMirrors.mockResolvedValue(mockMirrorResponse);
    mockTestMirrors.mockImplementation((callbacks) => {
      setTimeout(() => callbacks.onComplete?.(), 0);
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(mockTestMirrors).toHaveBeenCalled();
    });
  });

  describe("view as text", () => {
    const cockpitGlobal = globalThis as unknown as { cockpit: Record<string, unknown> };
    let fileMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fileMock = vi.fn(() => ({
        read: vi.fn().mockResolvedValue("Server = https://mirror1.example.com/$repo/os/$arch\n"),
        close: vi.fn(),
      }));
      cockpitGlobal.cockpit.file = fileMock;
    });

    afterEach(() => {
      delete cockpitGlobal.cockpit.file;
    });

    it("reads the mirrorlist from disk and offers a named copy control", async () => {
      render(<MirrorsView />);
      await waitFor(() => expect(screen.getByText(/mirror1\.example\.com\/\$repo/)).toBeInTheDocument());
      expect(fileMock).not.toHaveBeenCalledWith("/etc/pacman.d/mirrorlist");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "View as text" }));
      });

      await waitFor(() => {
        expect(screen.getByText(/^Server = https:\/\/mirror1/)).toBeInTheDocument();
      });
      expect(fileMock).toHaveBeenCalledWith("/etc/pacman.d/mirrorlist");
      expect(screen.getByRole("button", { name: "Copy /etc/pacman.d/mirrorlist" })).toBeInTheDocument();
      expect(screen.queryByText(/Unsaved edits are not included/)).not.toBeInTheDocument();
    });

    it("says the text is the file on disk while edits are unsaved", async () => {
      render(<MirrorsView />);
      await waitFor(() => expect(screen.getAllByRole("switch").length).toBeGreaterThan(0));

      await act(async () => {
        fireEvent.click(screen.getAllByRole("switch")[1]);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "View as text" }));
      });

      expect(screen.getByText("File on disk. Unsaved edits are not included.")).toBeInTheDocument();
    });
  });

  it("'Test mirrors again' fetches fresh status, then re-runs the latency test", async () => {
    render(<MirrorsView />);
    await waitFor(() => expect(mockTestMirrors).toHaveBeenCalledTimes(1));
    const retest = screen.getByRole("button", { name: "Test mirrors again" });
    await waitFor(() => expect(retest).not.toHaveAttribute("aria-disabled", "true"));
    expect(mockFetchMirrorStatus).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(retest);
    });

    await waitFor(() => expect(mockTestMirrors).toHaveBeenCalledTimes(2));
    expect(mockFetchMirrorStatus).toHaveBeenCalledTimes(1);
    expect(mockFetchMirrorStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mockTestMirrors.mock.invocationCallOrder[1],
    );
  });

  it("disables 'Test mirrors again' while a test runs", async () => {
    mockTestMirrors.mockImplementation(() => ({ cancel: vi.fn(), forceStop: vi.fn() }));
    render(<MirrorsView />);
    await waitFor(() => expect(mockTestMirrors).toHaveBeenCalledTimes(1));
    const retest = screen.getByRole("button", { name: "Test mirrors again" });
    expect(retest).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      fireEvent.click(retest);
    });
    expect(mockTestMirrors).toHaveBeenCalledTimes(1);
  });

  it("offers 'Clear search' when the search matches no mirror", async () => {
    render(<MirrorsView />);
    await waitFor(() => expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Search mirrors…"), {
        target: { value: "nothing-matches-this" },
      });
    });
    const clear = screen.getByRole("button", { name: "Clear search" });

    await act(async () => {
      fireEvent.click(clear);
    });
    expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/mirror2\.example\.com/)).toBeInTheDocument();
  });
  describe("dead ends", () => {
    const emptyList: api.MirrorListResponse = { revision: "rev-1",
      mirrors: [],
      total: 0,
      enabled_count: 0,
      path: "/etc/pacman.d/mirrorlist",
      last_modified: null,
    };

    it("a saveMirrorlist rejection keeps the table and edits, with Save enabled and Try again", async () => {
      mockSaveMirrorlist.mockRejectedValueOnce(new Error("write failed"));
      await renderLoaded();
      await toggleSecondMirror();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });

      const tryAgain = await screen.findByRole("button", { name: "Try again" });
      expect(screen.getByRole("heading", { name: /Mirrorlist not saved/ })).toBeInTheDocument();
      expect(screen.getByRole("grid", { name: "Mirror list" })).toBeInTheDocument();
      expect(screen.getAllByRole("switch")[1]).toBeChecked();
      expect(screen.getByRole("button", { name: /Save Changes/i })).not.toHaveAttribute("aria-disabled", "true");

      mockSaveMirrorlist.mockResolvedValueOnce(configurationResult({ success: true, backup_path: null, message: "ok" }));
      await act(async () => {
        fireEvent.click(tryAgain);
      });
      expect(mockSaveMirrorlist).toHaveBeenCalledTimes(2);
      expect(await screen.findByRole("heading", { name: /Saved \/etc\/pacman.d\/mirrorlist/ })).toBeInTheDocument();
    });

    it("a failed reread after a save keeps the table and offers Try again", async () => {
      mockSaveMirrorlist.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "ok" }));
      await renderLoaded();
      await toggleSecondMirror();
      mockListMirrors.mockRejectedValueOnce(new Error("read failed"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
      });
      expect(await screen.findByRole("heading", { name: /Could not refresh mirrorlist/ })).toBeInTheDocument();
      expect(screen.queryByText(/Could not load mirrors/)).not.toBeInTheDocument();
      expect(screen.getByRole("grid", { name: "Mirror list" })).toBeInTheDocument();

      mockListMirrors.mockResolvedValueOnce({
        ...mockMirrorResponse,
        mirrors: mockMirrorResponse.mirrors.map((m) => ({ ...m, enabled: true })),
        revision: "rev-2",
      } as api.MirrorListResponse);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      await waitFor(() => expect(screen.queryByRole("heading", { name: /Could not refresh/ })).not.toBeInTheDocument());
      expect(screen.queryByText(/Pending changes/)).not.toBeInTheDocument();
    });

    it("an empty mirrorlist offers ranking, which opens the rank modal", async () => {
      mockListMirrors.mockResolvedValue(emptyList);
      render(<MirrorsView />);
      const rank = await screen.findByRole("button", { name: "Rank mirrors from Arch status" });
      expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Reload$/ })).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(rank);
      });
      expect(screen.getByRole("dialog", { name: "Rank mirrors" })).toBeInTheDocument();
      expect(mockRefreshMirrors).toHaveBeenCalledTimes(1);
    });

    it("ranks a missing mirrorlist and saves against its absent-file revision", async () => {
      mockListMirrors.mockResolvedValue({ ...emptyList, revision: "missing" });
      mockSaveMirrorlist.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Saved" }));
      mockRefreshMirrors.mockResolvedValue({
        mirrors: [{ url: "https://ranked.example.org/$repo/os/$arch", enabled: true, comment: "Germany" }],
        total: 1, last_check: null,
      });
      render(<MirrorsView />);
      fireEvent.click(await screen.findByRole("button", { name: "Rank mirrors from Arch status" }));
      await screen.findByRole("grid", { name: "Preview mirrors" });
      await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Edit before saving" })); });
      expect(screen.getByRole("grid", { name: "Mirror list" })).toHaveTextContent(/ranked\.example\.org/);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Save Changes/i })); });
      expect(mockSaveMirrorlist).toHaveBeenCalledWith(expect.any(Array), "missing");
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    });

    it("a load error that is not a missing file offers only Retry", async () => {
      mockListMirrors.mockRejectedValue(new Error("Permission denied"));
      render(<MirrorsView />);
      await screen.findByText(/Could not load mirrors/);
      expect(screen.queryByRole("button", { name: "Rank mirrors from Arch status" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toHaveClass("pf-m-primary");
    });
  });

  describe("backup deletion", () => {
    const twoBackups = { warnings: [],
      backups: [
        { timestamp: 1704067200, date: "2024-01-01 00:00:00 UTC", enabled_count: 3, total_count: 10, size: 2048, source: "manual" as const },
        { timestamp: 1704063600, date: "2023-12-31 23:00:00 UTC", enabled_count: 2, total_count: 9, size: 1024, source: "auto" as const },
      ],
    };

    const openBackups = async () => {
      render(<MirrorsView />);
      await waitFor(() => expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      await screen.findByRole("grid", { name: "Mirrorlist backups" });
    };

    it("names each backup checkbox by its date", async () => {
      mockListMirrorBackups.mockResolvedValue(twoBackups);
      await openBackups();
      const rows = screen.getAllByRole("checkbox").filter((b) => b.closest("tbody"));
      expect(rows).toHaveLength(2);
      expect(screen.getAllByRole("checkbox", { name: "Select backup from 2024-01-01 00:00:00 UTC" })).toHaveLength(1);
      expect(new Set(rows.map((b) => b.getAttribute("aria-label"))).size).toBe(2);
      expect(new Set(rows.map((b) => b.getAttribute("name"))).size).toBe(2);
      expect(screen.queryAllByRole("checkbox", { name: /^Select row \d+$/ })).toHaveLength(0);
      sweepA11y();
    });

    it("spawns nothing until the named confirm button is pressed", async () => {
      mockListMirrorBackups.mockResolvedValue(twoBackups);
      mockDeleteMirrorBackup.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "ok" }));
      await openBackups();

      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select all backups" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
      });
      expect(mockDeleteMirrorBackup).not.toHaveBeenCalled();

      const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Delete 2 backups" });
      await act(async () => {
        fireEvent.click(confirm);
      });
      await waitFor(() => expect(mockDeleteMirrorBackup).toHaveBeenCalledTimes(2));
    });

    it("names a single backup by date and Cancel spawns nothing", async () => {
      mockListMirrorBackups.mockResolvedValue(twoBackups);
      await openBackups();

      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select backup from 2024-01-01 00:00:00 UTC" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Delete (1)" }));
      });
      const dialog = screen.getByRole("dialog", { name: /Delete mirrorlist backup\?$/ });
      sweepA11y({ dialogs: [/Delete mirrorlist backup\?$/] });
      expect(within(dialog).getByRole("button", { name: "Delete backup from 2024-01-01 00:00:00 UTC" })).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      });
      expect(mockDeleteMirrorBackup).not.toHaveBeenCalled();
    });

    it("a backup list error shows the error with Try again, not 'No backups found'", async () => {
      mockListMirrorBackups.mockRejectedValueOnce(new Error("cannot read backups"));
      await act(async () => {
        render(<MirrorsView />);
      });
      await waitFor(() => expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });

      const retry = await screen.findByRole("button", { name: "Try again" });
      expect(screen.queryByText(/No backups found/)).not.toBeInTheDocument();

      mockListMirrorBackups.mockResolvedValueOnce(twoBackups);
      await act(async () => {
        fireEvent.click(retry);
      });
      expect(await screen.findByRole("grid", { name: "Mirrorlist backups" })).toBeInTheDocument();
    });
  });

  describe("without administrative access", () => {
    beforeEach(() => {
      mockPermission.mockImplementation(() => ({
        allowed: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      }));
    });

    afterEach(() => {
      mockPermission.mockImplementation(() => ({
        allowed: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      }));
    });

    it("aria-disables Save and Restore while edits and ranking stay available", async () => {
      mockListMirrorBackups.mockResolvedValue({ warnings: [],
        backups: [
          { timestamp: 1704067200, date: "2024-01-01 00:00:00 UTC", enabled_count: 3, total_count: 10, size: 2048, source: "manual" },
        ],
      });
      render(<MirrorsView />);
      await waitFor(() => expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getAllByRole("switch")[1]);
      });
      expect(screen.getAllByRole("switch")[1]).toBeChecked();

      const save = screen.getByRole("button", { name: /Save Changes/i });
      expect(save).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(save);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      await waitFor(() => expect(screen.getByRole("button", { name: "Rank mirrors" })).not.toHaveAttribute("aria-disabled", "true"));

      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      const restore = await screen.findByRole("button", { name: "Restore" });
      expect(restore).toHaveAttribute("aria-disabled", "true");
    });
  });
});

describe("describeMirrorChanges", () => {
  const mirrors = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://m${i}.example/$repo/os/$arch`, enabled: true, comment: null }) as api.MirrorEntry);

  it.each([
    [2, "Reorder 2 mirrors"],
    [1000, "Reorder 1,000 mirrors"],
  ])("counts a reorder of %i mirrors", (n, expected) => {
    const before = mirrors(n);
    expect(describeMirrorChanges(before, [...before.slice(1), before[0]])).toEqual([expected]);
  });
});

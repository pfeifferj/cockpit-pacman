import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { MirrorsView } from "./MirrorsView";
import * as api from "../api";

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
    deleteMirrorBackup: vi.fn(),
  };
});

const mockListMirrors = vi.mocked(api.listMirrors);
const mockFetchMirrorStatus = vi.mocked(api.fetchMirrorStatus);
const mockTestMirrors = vi.mocked(api.testMirrors);
const mockSaveMirrorlist = vi.mocked(api.saveMirrorlist);
const mockListMirrorBackups = vi.mocked(api.listMirrorBackups);
const mockRestoreMirrorBackup = vi.mocked(api.restoreMirrorBackup);
const mockDeleteMirrorBackup = vi.mocked(api.deleteMirrorBackup);

const mockMirrorResponse: api.MirrorListResponse = {
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
    window.localStorage.clear();
    mockListMirrors.mockResolvedValue(mockMirrorResponse);
    mockListMirrorBackups.mockResolvedValue({ backups: [], warnings: [] });
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

  it("shows stat boxes with counts", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    // Total count and enabled count
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  describe("pagination", () => {
    const makeMirrors = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        url: `https://mpage${String(i).padStart(4, "0")}.test/$repo/os/$arch`,
        enabled: true,
        comment: "",
      }));

    const respond = (n: number) =>
      mockListMirrors.mockResolvedValue({
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
    }, 15000);

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
      expect(screen.getByText(/Error loading mirrors/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when no mirrors", async () => {
    mockListMirrors.mockResolvedValue({
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
    expect(saveButton).toBeDisabled();

    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[1]);
    });

    expect(saveButton).not.toBeDisabled();
  });

  it("opens confirm modal when saving", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    // Make a change first
    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[1]);
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await waitFor(() => {
      expect(screen.getByText("Save mirrorlist?")).toBeInTheDocument();
    });
  });

  it("saves mirrorlist on confirm", async () => {
    mockSaveMirrorlist.mockResolvedValue({
      warnings: [],
      success: true,
      backup_path: "/etc/pacman.d/mirrorlist.bak",
      message: "Mirrorlist saved",
    });
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[1]);
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    await waitFor(() => {
      expect(screen.getByText("Save mirrorlist?")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Mirrorlist/i }));
    });

    await waitFor(() => {
      expect(mockSaveMirrorlist).toHaveBeenCalled();
    });
  });

  it("has search input for filtering mirrors", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("Search mirrors...")).toBeInTheDocument();
  });

  it("filters mirrors by search text", async () => {
    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search mirrors...");
    fireEvent.change(searchInput, { target: { value: "mirror1" } });

    expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/mirror2\.example\.com/)).not.toBeInTheDocument();
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

    // First mirror's move up should be disabled
    expect(moveUpButtons[0]).toBeDisabled();
    // Last mirror's move down should be disabled
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
    mockListMirrorBackups.mockResolvedValue({
      warnings: [],
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

  it("distinguishes a backup you took from one taken for you", async () => {
    mockListMirrorBackups.mockResolvedValue({
      warnings: [],
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
    mockListMirrorBackups.mockResolvedValue({ backups: [], warnings: [] });

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

  it("reports unavailable backup history instead of claiming there are no backups", async () => {
    mockListMirrorBackups.mockRejectedValue(new api.BackendError("Permission denied", "permission_denied", "Directory /etc/pacman.d is not readable"));
    render(<MirrorsView />);
    await screen.findByText(/mirror1\.example\.com/);
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    expect(screen.getByText("Backup history could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("Directory /etc/pacman.d is not readable")).toBeInTheDocument();
    expect(screen.queryByText(/No backups found/)).not.toBeInTheDocument();
  });

  it("preserves backend details from a failed mirror test", async () => {
    mockTestMirrors.mockImplementation((callbacks) => {
      window.queueMicrotask(() => callbacks.onError?.("Mirror test failed", "internal_error", "Failed to create the HTTP client"));
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    render(<MirrorsView />);
    expect(await screen.findByText("Mirror test failed")).toBeInTheDocument();
    expect(screen.getByText("Failed to create the HTTP client")).toBeInTheDocument();
  });

  it("preserves each backend failure when deleting several backups", async () => {
    mockListMirrorBackups.mockResolvedValue({ backups: [100, 200].map(timestamp => ({ timestamp, date: "1970-01-01", total_count: 2, enabled_count: 2, size: 200, source: "manual" })), warnings: [] });
    mockDeleteMirrorBackup.mockRejectedValueOnce(new api.BackendError("Could not delete first backup", "permission_denied", "First backup is read-only"));
    mockDeleteMirrorBackup.mockRejectedValueOnce(new api.BackendError("Could not delete second backup", "internal_error", "Second backup directory could not be synced"));
    render(<MirrorsView />);
    await screen.findByText(/mirror1\.example\.com/);
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    fireEvent.click(screen.getByLabelText("Select all backups"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete (2)" })); });
    expect(screen.getByText("Failed to delete 2 of 2 backups")).toBeInTheDocument();
    expect(screen.getByText(/First backup is read-only/)).toHaveTextContent("Second backup directory could not be synced");
  });

  it("shows backup maintenance warnings after a successful save", async () => {
    mockSaveMirrorlist.mockResolvedValue({ success: true, backup_path: "/etc/pacman.d/mirrorlist.backup.100", message: "Saved", warnings: ["Backup provenance could not be saved"] });
    render(<MirrorsView />);
    await screen.findByText(/mirror1\.example\.com/);
    fireEvent.click(screen.getAllByRole("switch")[1]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save Mirrorlist" })); });
    expect(screen.getByRole("heading", { name: "Mirrorlist saved" })).toBeInTheDocument();
    expect(screen.getByText("Backup provenance could not be saved")).toBeInTheDocument();
  });

  it("shows deletion warnings after the backup history reloads", async () => {
    mockListMirrorBackups.mockResolvedValue({ backups: [{ timestamp: 100, date: "1970-01-01", total_count: 2, enabled_count: 2, size: 200, source: "manual" }], warnings: ["One backup could not be read"] });
    mockDeleteMirrorBackup.mockResolvedValue({ success: true, backup_path: null, message: "Deleted", warnings: ["Backup provenance could not be saved"] });
    render(<MirrorsView />);
    await screen.findByText(/mirror1\.example\.com/);
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    expect(screen.getByText("One backup could not be read")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select all backups"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete (1)" })); });
    expect(mockDeleteMirrorBackup).toHaveBeenCalledWith(100);
    expect(screen.getByText("Backup provenance could not be saved")).toBeInTheDocument();
    expect(screen.getByText("One backup could not be read")).toBeInTheDocument();
  });

  it("warns when HTTP is selected while keeping HTTPS as the default", async () => {
    render(<MirrorsView />);
    const refresh = await screen.findByRole("button", { name: "Refresh" });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    const protocol = screen.getByLabelText("Protocol");
    expect(protocol).toHaveValue("https");
    expect(screen.queryByText("HTTP does not protect package database transfers")).not.toBeInTheDocument();
    fireEvent.change(protocol, { target: { value: "http" } });
    expect(screen.getByText("HTTP does not protect package database transfers")).toBeInTheDocument();
    fireEvent.change(protocol, { target: { value: "all" } });
    expect(screen.getByText("HTTP does not protect package database transfers")).toBeInTheDocument();
    fireEvent.change(protocol, { target: { value: "https" } });
    expect(screen.queryByText("HTTP does not protect package database transfers")).not.toBeInTheDocument();
  });

  it("warns before saving enabled HTTP mirrors", async () => {
    mockListMirrors.mockResolvedValue({ ...mockMirrorResponse, mirrors: [{ ...mockMirrorResponse.mirrors[0], url: "http://mirror1.example.com/$repo/os/$arch" }, mockMirrorResponse.mirrors[1]] });
    render(<MirrorsView />);
    await screen.findByText(/mirror1\.example\.com/);
    fireEvent.click(screen.getAllByRole("switch")[1]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByText("HTTP does not protect package database transfers")).toBeInTheDocument();
    expect(mockSaveMirrorlist).not.toHaveBeenCalled();
  });

  it("shows restore confirmation modal", async () => {
    mockListMirrorBackups.mockResolvedValue({
      warnings: [],
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
      expect(screen.getAllByText(/ago$/).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
    });

    await waitFor(() => {
      expect(screen.getByText("Restore mirrorlist backup?")).toBeInTheDocument();
    });
  });

  it("restores backup and reloads mirrors", async () => {
    mockListMirrorBackups.mockResolvedValue({
      warnings: [],
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
    mockRestoreMirrorBackup.mockResolvedValue({
      warnings: [],
      success: true,
      backup_path: "/etc/pacman.d/mirrorlist.backup.1704067201",
      message: "Restored",
    });

    render(<MirrorsView />);

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });

    await waitFor(() => {
      expect(screen.getAllByText(/ago$/).length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
    });

    await waitFor(() => {
      expect(screen.getByText("Restore mirrorlist backup?")).toBeInTheDocument();
    });

    // Click the confirm Restore button in the modal
    const modalButtons = screen.getAllByRole("button", { name: /^Restore$/ });
    await act(async () => {
      fireEvent.click(modalButtons[modalButtons.length - 1]);
    });

    await waitFor(() => {
      expect(mockRestoreMirrorBackup).toHaveBeenCalledWith(1704067200);
    });

    // Should reload mirrors after restore
    await waitFor(() => {
      expect(mockListMirrors).toHaveBeenCalledTimes(2);
    });
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
      expect(screen.getByText(/Error loading mirrors/)).toBeInTheDocument();
    });

    mockListMirrors.mockResolvedValue(mockMirrorResponse);
    mockTestMirrors.mockImplementation((callbacks) => {
      setTimeout(() => callbacks.onComplete?.(), 0);
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(mockTestMirrors).toHaveBeenCalled();
    });
  });
});

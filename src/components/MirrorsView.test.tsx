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
    listRepoMirrors: vi.fn(),
  };
});

const mockListMirrors = vi.mocked(api.listMirrors);
const mockFetchMirrorStatus = vi.mocked(api.fetchMirrorStatus);
const mockTestMirrors = vi.mocked(api.testMirrors);
const mockSaveMirrorlist = vi.mocked(api.saveMirrorlist);
const mockListMirrorBackups = vi.mocked(api.listMirrorBackups);
const mockRestoreMirrorBackup = vi.mocked(api.restoreMirrorBackup);
const mockListRepoMirrors = vi.mocked(api.listRepoMirrors);

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
    mockListRepoMirrors.mockResolvedValue({ repos: [] });
    mockFetchMirrorStatus.mockResolvedValue({
      mirrors: [],
      total: 0,
      last_check: null,
    });
    mockTestMirrors.mockImplementation((callbacks) => {
      setTimeout(() => callbacks.onComplete?.(), 0);
      return { cancel: vi.fn() };
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
      backups: [
        {
          timestamp: 1704067200,
          date: "2024-01-01 00:00:00 UTC",
          enabled_count: 3,
          total_count: 10,
          size: 2048,
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
      expect(screen.getByText("2024-01-01 00:00:00 UTC")).toBeInTheDocument();
      expect(screen.getByText("3 enabled / 10 total")).toBeInTheDocument();
    });
  });

  it("shows empty state when no backups exist", async () => {
    mockListMirrorBackups.mockResolvedValue({ backups: [] });

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

  it("shows restore confirmation modal", async () => {
    mockListMirrorBackups.mockResolvedValue({
      backups: [
        {
          timestamp: 1704067200,
          date: "2024-01-01 00:00:00 UTC",
          enabled_count: 3,
          total_count: 10,
          size: 2048,
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
      expect(screen.getByText("2024-01-01 00:00:00 UTC")).toBeInTheDocument();
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
      backups: [
        {
          timestamp: 1704067200,
          date: "2024-01-01 00:00:00 UTC",
          enabled_count: 3,
          total_count: 10,
          size: 2048,
        },
      ],
    });
    mockRestoreMirrorBackup.mockResolvedValue({
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
      expect(screen.getByText("2024-01-01 00:00:00 UTC")).toBeInTheDocument();
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

  it("shows repo override rows with pills in unified table", async () => {
    mockListRepoMirrors.mockResolvedValue({
      repos: [
        { name: "core", directives: [
          { directive_type: "Include" as const, value: "/etc/pacman.d/mirrorlist" },
        ] },
        { name: "multilib", directives: [
          { directive_type: "Server" as const, value: "https://geo.mirror.pkgbuild.com/$repo/os/$arch" },
          { directive_type: "Include" as const, value: "/etc/pacman.d/mirrorlist" },
        ] },
      ],
    });

    render(<MirrorsView />);
    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("multilib")).toBeInTheDocument();
      expect(screen.getByText("geo.mirror.pkgbuild.com")).toBeInTheDocument();
    });
  });

  it("shows no repo rows when all repos use standard mirrorlist", async () => {
    mockListRepoMirrors.mockResolvedValue({
      repos: [
        { name: "core", directives: [
          { directive_type: "Include" as const, value: "/etc/pacman.d/mirrorlist" },
        ] },
        { name: "extra", directives: [
          { directive_type: "Include" as const, value: "/etc/pacman.d/mirrorlist" },
        ] },
      ],
    });

    render(<MirrorsView />);
    await waitFor(() => {
      expect(screen.getByText(/mirror1\.example\.com/)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(mockListRepoMirrors).toHaveBeenCalled();
    });

    expect(screen.queryByText("Repo overrides")).not.toBeInTheDocument();
  });

  it("auto-runs mirror test on mount and shows sort suggestion", async () => {
    let capturedCallbacks: Parameters<typeof api.testMirrors>[0] | null = null;
    mockTestMirrors.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn() };
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
      expect(screen.getByText(/Tested 1 mirror\b/)).toBeInTheDocument();
      expect(screen.getByText("Sort by latency")).toBeInTheDocument();
    });
  });

  it("dismisses test result banner when close button is clicked", async () => {
    let capturedCallbacks: Parameters<typeof api.testMirrors>[0] | null = null;
    mockTestMirrors.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn() };
    });

    render(<MirrorsView />);
    await waitFor(() => {
      expect(mockTestMirrors).toHaveBeenCalled();
    });

    await act(async () => {
      capturedCallbacks!.onTestResult!(
        { url: "https://mirror1.example.com/$repo/os/$arch", success: true, latency_ms: 10, speed_bps: null, error: null },
        1, 1
      );
    });
    await act(async () => {
      capturedCallbacks!.onComplete!();
    });

    await waitFor(() => {
      expect(screen.getByText(/Tested 1 mirror\b/)).toBeInTheDocument();
    });

    const closeButton = screen.getByLabelText("Close Info alert: alert: Tested 1 mirror");
    fireEvent.click(closeButton);

    expect(screen.queryByText(/Tested 1 mirror\b/)).not.toBeInTheDocument();
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
      return { cancel: vi.fn() };
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

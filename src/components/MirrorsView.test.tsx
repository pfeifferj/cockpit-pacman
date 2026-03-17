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
  };
});

const mockListMirrors = vi.mocked(api.listMirrors);
const mockFetchMirrorStatus = vi.mocked(api.fetchMirrorStatus);
const mockSaveMirrorlist = vi.mocked(api.saveMirrorlist);

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
    mockFetchMirrorStatus.mockResolvedValue({
      mirrors: [],
      total: 0,
      last_check: null,
    });
    // Pre-populate status cache so the auto-fetch effect uses the cache
    // instead of calling fetchMirrorStatus (which transitions to "fetching_status" state)
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
});

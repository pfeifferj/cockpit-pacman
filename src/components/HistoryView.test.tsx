import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { HistoryView } from "./HistoryView";
import * as api from "../api";
import { mockGroupedLogResponse } from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getGroupedHistory: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
  };
});

const mockGetGroupedHistory = vi.mocked(api.getGroupedHistory);

describe("HistoryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGroupedHistory.mockResolvedValue(mockGroupedLogResponse);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading state initially", () => {
    mockGetGroupedHistory.mockImplementation(() => new Promise(() => {}));
    render(<HistoryView />);
    expect(screen.getByText(/Loading history/i)).toBeInTheDocument();
  });

  it("renders history data after loading", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText("Package History")).toBeInTheDocument();
    });

    // Stat boxes show upgraded/installed/removed counts
    expect(screen.getByText("Upgraded")).toBeInTheDocument();
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
  });

  it("shows error state on API failure", async () => {
    mockGetGroupedHistory.mockRejectedValue(new Error("Failed to read log"));
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText(/Error loading history/i)).toBeInTheDocument();
    });
  });

  it("shows retry button on error", async () => {
    mockGetGroupedHistory.mockRejectedValue(new Error("Failed"));
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    });
  });

  it("shows empty state when no history", async () => {
    mockGetGroupedHistory.mockResolvedValue({
      groups: [],
      total_groups: 0,
      total_upgraded: 0,
      total_installed: 0,
      total_removed: 0,
      total_other: 0,
    });
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText(/No history found/i)).toBeInTheDocument();
    });
  });

  it("expands accordion group on click", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText("Package History")).toBeInTheDocument();
    });

    // Click on the first group toggle (should contain "3 packages")
    const toggles = screen.getAllByText(/packages\)/i);
    fireEvent.click(toggles[0]);

    // After expanding, entries should be visible
    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });
  });

  it("toggles expand all / collapse all", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText("Package History")).toBeInTheDocument();
    });

    const expandButton = screen.getByRole("button", { name: /Expand all/i });
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Collapse all/i })).toBeInTheDocument();
    });

    // Should show entries from all groups
    expect(screen.getByText("linux")).toBeInTheDocument();
    expect(screen.getByText("neovim")).toBeInTheDocument();
  });

  it("has filter dropdown with action options", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText("Package History")).toBeInTheDocument();
    });

    // Default filter shows "All actions"
    expect(screen.getByText("All actions")).toBeInTheDocument();
  });

  it("has search input", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText("Package History")).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("Filter by package name...")).toBeInTheDocument();
  });
});

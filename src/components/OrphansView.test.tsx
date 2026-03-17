import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { OrphansView } from "./OrphansView";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listOrphans: vi.fn(),
    removeOrphans: vi.fn(),
  };
});

const mockListOrphans = vi.mocked(api.listOrphans);
const mockRemoveOrphans = vi.mocked(api.removeOrphans);

const mockOrphanResponse: api.OrphanResponse = {
  orphans: [
    {
      name: "libunused",
      version: "1.0.0-1",
      description: "An unused library",
      installed_size: 5000000,
      install_date: 1704067200,
      repository: "extra",
    },
    {
      name: "old-dep",
      version: "2.3.1-1",
      description: "Old dependency",
      installed_size: 12000000,
      install_date: 1700000000,
      repository: "core",
    },
  ],
  total_size: 17000000,
};

describe("OrphansView", () => {
  const defaultProps = {
    onRowClick: vi.fn(),
    onOrphansLoaded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListOrphans.mockResolvedValue(mockOrphanResponse);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading spinner initially", () => {
    mockListOrphans.mockImplementation(() => new Promise(() => {}));
    render(<OrphansView {...defaultProps} />);
    expect(screen.getByText(/Checking for orphan packages/i)).toBeInTheDocument();
  });

  it("renders orphan packages after loading", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    expect(screen.getByText("old-dep")).toBeInTheDocument();
    expect(screen.getByText("1.0.0-1")).toBeInTheDocument();
    expect(screen.getByText("2.3.1-1")).toBeInTheDocument();
  });

  it("calls onOrphansLoaded with count", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(defaultProps.onOrphansLoaded).toHaveBeenCalledWith(2);
    });
  });

  it("shows error on API failure", async () => {
    mockListOrphans.mockRejectedValue(new Error("Permission denied"));
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Error loading orphans/i)).toBeInTheDocument();
    });
  });

  it("shows lock error message when database is locked", async () => {
    mockListOrphans.mockRejectedValue(new Error("unable to lock database"));
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Database is locked/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when no orphans", async () => {
    mockListOrphans.mockResolvedValue({ orphans: [], total_size: 0 });
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /No orphan packages/i })).toBeInTheDocument();
    });
  });

  it("opens confirmation modal on Remove All click", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Remove All Orphans/i }));

    await waitFor(() => {
      expect(screen.getByText("Remove orphan packages?")).toBeInTheDocument();
    });
  });

  it("starts removal when confirming", async () => {
    mockRemoveOrphans.mockReturnValue({ cancel: vi.fn() });
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Remove All Orphans/i }));

    await waitFor(() => {
      expect(screen.getByText("Remove orphan packages?")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Remove All$/i }));

    expect(mockRemoveOrphans).toHaveBeenCalled();
  });

  it("shows success state after removal completes", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRemoveOrphans.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn() };
    });

    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Remove All Orphans/i }));
    await waitFor(() => {
      expect(screen.getByText("Remove orphan packages?")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Remove All$/i }));

    await act(async () => {
      capturedCallbacks?.onComplete();
    });

    await waitFor(() => {
      expect(screen.getByText(/Orphan packages removed/i)).toBeInTheDocument();
    });
  });

  it("filters orphans by search input", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Filter orphans...");
    fireEvent.change(searchInput, { target: { value: "libunused" } });

    expect(screen.getByText("libunused")).toBeInTheDocument();
    expect(screen.queryByText("old-dep")).not.toBeInTheDocument();
  });

  it("calls onRowClick when clicking a package row", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    const rows = screen.getAllByRole("row");
    // First data row (index 1, after header)
    fireEvent.click(rows[1]);

    expect(defaultProps.onRowClick).toHaveBeenCalledWith("libunused");
  });
});

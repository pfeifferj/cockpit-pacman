import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { DependencyView } from "./DependencyView";
import * as api from "../api";
import React from "react";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getDependencyTree: vi.fn(),
    getPackageInfo: vi.fn(),
    searchPackages: vi.fn(),
  };
});

vi.mock("../hooks/useForceGraph", () => ({
  useForceGraph: () => ({
    svgRef: React.createRef(),
    resetView: vi.fn(),
  }),
}));

const mockGetDependencyTree = vi.mocked(api.getDependencyTree);
const mockSearchPackages = vi.mocked(api.searchPackages);

const mockDependencyTreeResponse: api.DependencyTreeResponse = {
  nodes: [
    {
      id: "linux",
      name: "linux",
      version: "6.7.0-arch1-1",
      depth: 0,
      installed: true,
      reason: "explicit",
      repository: "core",
    },
    {
      id: "kmod",
      name: "kmod",
      version: "33-1",
      depth: 1,
      installed: true,
      reason: "dependency",
      repository: "core",
    },
    {
      id: "zlib",
      name: "zlib",
      version: "1.3.1-1",
      depth: 2,
      installed: true,
      reason: "dependency",
      repository: "core",
    },
  ],
  edges: [
    { source: "linux", target: "kmod", edge_type: "depends" },
    { source: "kmod", target: "zlib", edge_type: "depends" },
  ],
  root: "linux",
  max_depth_reached: false,
  warnings: [],
};

const triggerSearch = async (searchValue: string) => {
  const searchInput = screen.getByPlaceholderText("Search packages...");
  await act(async () => {
    fireEvent.change(searchInput, { target: { value: searchValue } });
  });
  await act(async () => {
    fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
  });
};

describe("DependencyView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDependencyTree.mockResolvedValue(mockDependencyTreeResponse);
    mockSearchPackages.mockResolvedValue({ results: [], total: 0, total_installed: 0, total_not_installed: 0, repositories: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty state initially", async () => {
    render(<DependencyView />);
    expect(screen.getByText("Explore package dependencies")).toBeInTheDocument();
  });

  it("renders search input", async () => {
    render(<DependencyView />);
    expect(screen.getByPlaceholderText("Search packages...")).toBeInTheDocument();
  });

  it("renders depth slider", async () => {
    render(<DependencyView />);
    expect(screen.getByText(/Depth:/)).toBeInTheDocument();
  });

  it("renders direction toggle group", async () => {
    render(<DependencyView />);
    expect(screen.getByText("Forward")).toBeInTheDocument();
    expect(screen.getByText("Reverse")).toBeInTheDocument();
    expect(screen.getByText("Both")).toBeInTheDocument();
  });

  it("displays loading state when searching", async () => {
    let resolvePromise: (value: api.DependencyTreeResponse) => void;
    mockGetDependencyTree.mockImplementation(() => new Promise((resolve) => {
      resolvePromise = resolve;
    }));
    render(<DependencyView />);

    await triggerSearch("linux");

    expect(screen.getByText("Loading dependency tree...")).toBeInTheDocument();

    await act(async () => {
      resolvePromise!(mockDependencyTreeResponse);
    });
  });

  it("calls getDependencyTree with correct params on search", async () => {
    render(<DependencyView />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(mockGetDependencyTree).toHaveBeenCalledWith({
        name: "linux",
        depth: 3,
        direction: "forward",
      });
    });
  });

  it("displays error message on API failure", async () => {
    mockGetDependencyTree.mockRejectedValue(new Error("Package not found"));

    render(<DependencyView />);

    await triggerSearch("nonexistent");

    await waitFor(() => {
      expect(screen.getByText("Failed to load dependencies")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("displays node and edge counts after loading", async () => {
    render(<DependencyView />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
      expect(screen.getByText("2 edges")).toBeInTheDocument();
    });
  });

  it("displays warnings when max depth reached", async () => {
    mockGetDependencyTree.mockResolvedValue({
      ...mockDependencyTreeResponse,
      max_depth_reached: true,
    });

    render(<DependencyView />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText(/Maximum depth reached/)).toBeInTheDocument();
    });
  });

  it("renders SVG graph container", async () => {
    render(<DependencyView />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
    });

    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders legend after loading graph", async () => {
    render(<DependencyView />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
    });

    expect(screen.getByText("Root package")).toBeInTheDocument();
    expect(screen.getByText("Explicit")).toBeInTheDocument();
    expect(screen.getByText("Dependency")).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
  });

  it("shows Reset View button after loading graph", async () => {
    render(<DependencyView />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("Reset View")).toBeInTheDocument();
    });
  });

  it("clears graph when search is cleared", async () => {
    render(<DependencyView />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
    });

    const clearButton = screen.getByLabelText("Clear input");
    await act(async () => {
      fireEvent.click(clearButton);
    });

    await waitFor(() => {
      expect(screen.getByText("Explore package dependencies")).toBeInTheDocument();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { DependencyView } from "./DependencyView";
import * as api from "../api";
import { useForceGraph } from "../hooks/useForceGraph";
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
  useForceGraph: vi.fn(() => ({
    svgRef: React.createRef(),
    resetView: vi.fn(),
  })),
}));

const mockGetDependencyTree = vi.mocked(api.getDependencyTree);
const mockSearchPackages = vi.mocked(api.searchPackages);
const mockUseForceGraph = vi.mocked(useForceGraph);

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

const deferredTree = () => {
  let resolve!: (response: api.DependencyTreeResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<api.DependencyTreeResponse>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    expect(screen.getByRole("slider", { name: "Depth" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("slider", { name: "Optional dependency depth" })).toHaveAttribute("aria-valuenow", "0");
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
        depth: 1,
        direction: "forward",
        optionalDepth: 0,
      });
    });
  });

  it("preserves optional depth when searching and changing the graph controls", async () => {
    render(<DependencyView />);

    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    expect(mockGetDependencyTree).not.toHaveBeenCalled();
    await triggerSearch("linux");
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux", depth: 1, direction: "forward", optionalDepth: 1 });

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("slider", { name: "Depth" }), { key: "ArrowRight" });
    });
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux", depth: 2, direction: "forward", optionalDepth: 1 });

    await act(async () => { fireEvent.click(screen.getByText("Reverse")); });
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux", depth: 2, direction: "reverse", optionalDepth: 1 });

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    });
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux", depth: 2, direction: "reverse", optionalDepth: 2 });

    await act(async () => {
      mockUseForceGraph.mock.lastCall?.[3].onNodeDoubleClick?.({ ...mockDependencyTreeResponse.nodes[1], reason: "dependency" });
    });
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "kmod", depth: 2, direction: "reverse", optionalDepth: 2 });

    await triggerSearch("zlib");
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "zlib", depth: 2, direction: "reverse", optionalDepth: 2 });
  });

  it("preserves optional depth for typeahead selection and a new initial package", async () => {
    mockSearchPackages.mockResolvedValue({
      results: [{ name: "linux-lts", version: "6.6-1", description: "LTS kernel", repository: "core", installed: false, installed_version: null }],
      total: 1, total_installed: 0, total_not_installed: 1, repositories: ["core"],
    });
    const { rerender } = render(<DependencyView />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    fireEvent.change(screen.getByPlaceholderText("Search packages..."), { target: { value: "linux" } });

    fireEvent.click(await screen.findByRole("option", { name: /linux-lts/ }));
    await waitFor(() => {
      expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux-lts", depth: 1, direction: "forward", optionalDepth: 1 });
    });

    rerender(<DependencyView initialPackage="zlib" />);
    await waitFor(() => {
      expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "zlib", depth: 1, direction: "forward", optionalDepth: 1 });
    });
  });

  it("refetches during initial loading and ignores an older response", async () => {
    const first = deferredTree();
    const latest = deferredTree();
    mockGetDependencyTree.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    render(<DependencyView initialPackage="linux" />);
    await waitFor(() => { expect(mockGetDependencyTree).toHaveBeenCalledTimes(1); });

    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux", depth: 1, direction: "forward", optionalDepth: 1 });

    await act(async () => {
      latest.resolve({ ...mockDependencyTreeResponse, nodes: mockDependencyTreeResponse.nodes.slice(0, 1), edges: [] });
    });
    expect(screen.getByText("1 nodes")).toBeInTheDocument();

    await act(async () => { first.resolve(mockDependencyTreeResponse); });
    expect(screen.getByText("1 nodes")).toBeInTheDocument();
    expect(screen.queryByText("3 nodes")).not.toBeInTheDocument();
  });

  it("keeps the current request loading when an older request fails", async () => {
    const first = deferredTree();
    const latest = deferredTree();
    mockGetDependencyTree.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    render(<DependencyView initialPackage="linux" />);
    await waitFor(() => { expect(mockGetDependencyTree).toHaveBeenCalledTimes(1); });

    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    await act(async () => { first.reject(new Error("Old request failed")); });

    expect(screen.getByText("Loading dependency tree...")).toBeInTheDocument();
    expect(screen.queryByText("Failed to load dependencies")).not.toBeInTheDocument();
    await act(async () => { latest.resolve(mockDependencyTreeResponse); });
    expect(screen.getByText("3 nodes")).toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)("keeps the graph clear when a pending request settles: %s", async (outcome) => {
    const pending = deferredTree();
    mockGetDependencyTree.mockReturnValueOnce(pending.promise);
    render(<DependencyView />);
    await triggerSearch("linux");

    fireEvent.click(screen.getByLabelText("Clear input"));
    expect(screen.getByText("Explore package dependencies")).toBeInTheDocument();
    await act(async () => {
      if (outcome === "resolve") pending.resolve(mockDependencyTreeResponse);
      else pending.reject(new Error("Cleared request failed"));
    });
    expect(screen.getByText("Explore package dependencies")).toBeInTheDocument();
    expect(screen.queryByText("3 nodes")).not.toBeInTheDocument();
    expect(screen.queryByText("Failed to load dependencies")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    expect(mockGetDependencyTree).toHaveBeenCalledTimes(1);
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

  it("does not display max depth warning when depth is below slider max", async () => {
    mockGetDependencyTree.mockResolvedValue({
      ...mockDependencyTreeResponse,
      max_depth_reached: true,
    });

    render(<DependencyView />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Maximum depth reached/)).not.toBeInTheDocument();
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

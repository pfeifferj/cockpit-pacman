import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act, within } from "@testing-library/react";
import { DependencyView } from "./DependencyView";
import * as api from "../api";
import { useForceGraph } from "../hooks/useForceGraph";
import React from "react";
import { sweepA11y } from "../test/a11ySweep";

const systemListeners = vi.hoisted(() => new Set<(kind: "system" | "sync") => void>());

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    onSystemChanged: vi.fn((listener: (kind: "system" | "sync") => void) => {
      systemListeners.add(listener);
      return () => systemListeners.delete(listener);
    }),
    getDependencyTree: vi.fn(),
    getPackageInfo: vi.fn(),
    searchPackages: vi.fn(),
  };
});

vi.mock("../hooks/useForceGraph", () => ({
  useForceGraph: vi.fn(() => ({
    svgRef: React.createRef(),
    resetView: vi.fn(),
    fitToContent: vi.fn(),
    focusNode: vi.fn(),
    keepNodeInView: vi.fn(),
  })),
}));

const mockGetDependencyTree = vi.mocked(api.getDependencyTree);
const mockSearchPackages = vi.mocked(api.searchPackages);
const mockUseForceGraph = vi.mocked(useForceGraph);
const onShowDetails = vi.fn();

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
  const searchInput = screen.getByPlaceholderText("Search packages…");
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
    render(<DependencyView onShowDetails={onShowDetails} />);
    expect(screen.getByRole("heading", { level: 3, name: "Explore package dependencies" })).toBeInTheDocument();
    sweepA11y();
  });

  it("names a package that is in no database with one heading", async () => {
    mockGetDependencyTree.mockResolvedValue({ ...mockDependencyTreeResponse, nodes: [], edges: [] });
    render(<DependencyView onShowDetails={onShowDetails} />);
    await triggerSearch("nosuchpkg");
    expect(await screen.findByRole("heading", { level: 3, name: "Package not found" })).toBeInTheDocument();
    sweepA11y();
  });

  it("renders search input", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    expect(screen.getByPlaceholderText("Search packages…")).toBeInTheDocument();
  });

  it("renders depth slider", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    expect(screen.getByRole("slider", { name: "Depth" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("slider", { name: "Optional dependency depth" })).toHaveAttribute("aria-valuenow", "0");
  });

  it("renders direction toggle group", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    expect(screen.getByText("Forward")).toBeInTheDocument();
    expect(screen.getByText("Reverse")).toBeInTheDocument();
    expect(screen.getByText("Both")).toBeInTheDocument();
  });

  it("puts depth and direction in a named toggle group and lets the search shrink", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    const toggle = screen.getByRole("button", { name: "Show graph options" });
    const group = toggle.closest(".pf-m-toggle-group") as HTMLElement;
    expect(within(group).getByRole("slider", { name: "Depth" })).toBeInTheDocument();
    expect(within(group).getByRole("slider", { name: "Optional dependency depth" })).toBeInTheDocument();
    expect(within(group).getByRole("group", { name: "Direction" })).toBeInTheDocument();
    expect(within(group).queryByRole("group", { name: "View" })).not.toBeInTheDocument();
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();

    const searchItem = screen.getByRole("combobox").closest(".pf-v6-c-toolbar__item") as HTMLElement;
    expect(searchItem.style.minWidth).toBe("0px");
    for (const el of searchItem.closest(".pf-v6-c-toolbar")!.querySelectorAll<HTMLElement>("[style]")) {
      expect(el.style.width).not.toMatch(/^\d+px$/);
    }

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expanded = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(within(expanded).getByRole("group", { name: "Direction" })).toBeInTheDocument();
  });

  it("displays loading state when searching", async () => {
    let resolvePromise: (value: api.DependencyTreeResponse) => void;
    mockGetDependencyTree.mockImplementation(() => new Promise((resolve) => {
      resolvePromise = resolve;
    }));
    render(<DependencyView onShowDetails={onShowDetails} />);

    await triggerSearch("linux");

    expect(screen.getByText("Loading dependency tree…")).toBeInTheDocument();

    await act(async () => {
      resolvePromise!(mockDependencyTreeResponse);
    });
  });

  it("calls getDependencyTree with correct params on search", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);

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
    render(<DependencyView onShowDetails={onShowDetails} />);

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
    const { rerender } = render(<DependencyView onShowDetails={onShowDetails} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    fireEvent.change(screen.getByPlaceholderText("Search packages…"), { target: { value: "linux" } });

    fireEvent.click(await screen.findByRole("option", { name: /linux-lts/ }));
    await waitFor(() => {
      expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux-lts", depth: 1, direction: "forward", optionalDepth: 1 });
    });

    rerender(<DependencyView request={{ name: "zlib", seq: 1 }} onShowDetails={onShowDetails} />);
    await waitFor(() => {
      expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "zlib", depth: 1, direction: "forward", optionalDepth: 1 });
    });
  });

  it("refetches during initial loading and ignores an older response", async () => {
    const first = deferredTree();
    const latest = deferredTree();
    mockGetDependencyTree.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    render(<DependencyView request={{ name: "linux", seq: 1 }} onShowDetails={onShowDetails} />);
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
    render(<DependencyView request={{ name: "linux", seq: 1 }} onShowDetails={onShowDetails} />);
    await waitFor(() => { expect(mockGetDependencyTree).toHaveBeenCalledTimes(1); });

    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    await act(async () => { first.reject(new Error("Old request failed")); });

    expect(screen.getByText("Loading dependency tree…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Could not load dependencies/ })).not.toBeInTheDocument();
    await act(async () => { latest.resolve(mockDependencyTreeResponse); });
    expect(screen.getByText("3 nodes")).toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)("keeps the graph clear when a pending request settles: %s", async (outcome) => {
    const pending = deferredTree();
    mockGetDependencyTree.mockReturnValueOnce(pending.promise);
    render(<DependencyView onShowDetails={onShowDetails} />);
    await triggerSearch("linux");

    fireEvent.click(screen.getByLabelText("Clear input"));
    expect(screen.getByText("Explore package dependencies")).toBeInTheDocument();
    await act(async () => {
      if (outcome === "resolve") pending.resolve(mockDependencyTreeResponse);
      else pending.reject(new Error("Cleared request failed"));
    });
    expect(screen.getByText("Explore package dependencies")).toBeInTheDocument();
    expect(screen.queryByText("3 nodes")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Could not load dependencies/ })).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    expect(mockGetDependencyTree).toHaveBeenCalledTimes(1);
  });

  it("shows a failed first load as a load error with its cause", async () => {
    mockGetDependencyTree.mockRejectedValue(new api.BackendError("database unreadable", "internal_error", "caused by: EIO"));

    render(<DependencyView onShowDetails={onShowDetails} />);

    await triggerSearch("nonexistent");

    expect(await screen.findByRole("heading", { level: 3, name: /Could not load dependencies of nonexistent/ })).toBeInTheDocument();
    expect(screen.getByText("database unreadable")).toBeInTheDocument();
    expect(screen.getByText("caused by: EIO")).toBeInTheDocument();
    expect(screen.queryByText("Explore package dependencies")).not.toBeInTheDocument();
  });

  it("reruns the same request from Try again after a failed load", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Depth" }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByText("Reverse"));
    mockGetDependencyTree.mockRejectedValueOnce(new Error("db busy"));
    await triggerSearch("linux");
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(mockGetDependencyTree).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(retry); });

    expect(mockGetDependencyTree).toHaveBeenCalledTimes(2);
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux", depth: 2, direction: "reverse", optionalDepth: 1 });
    expect(await screen.findByText("3 nodes")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Could not load dependencies/ })).not.toBeInTheDocument();
  });

  it("names an empty search in place of a load error", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    await triggerSearch("   ");
    expect(screen.getByRole("heading", { name: /Please enter a package name/ })).toBeInTheDocument();
    expect(mockGetDependencyTree).not.toHaveBeenCalled();
  });

  it("displays node and edge counts after loading", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);

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

    render(<DependencyView onShowDetails={onShowDetails} />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Maximum depth reached/)).not.toBeInTheDocument();
  });

  it("renders SVG graph container", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
    });

    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders legend after loading graph", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);

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
    render(<DependencyView onShowDetails={onShowDetails} />);

    await triggerSearch("linux");

    await waitFor(() => {
      expect(screen.getByText("Reset View")).toBeInTheDocument();
    });
  });

  it("clears graph when search is cleared", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);

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

  const listText = (name: string) =>
    screen.getAllByRole("button", { name }).find((el) => el.classList.contains("pf-v6-c-tree-view__node-text"))!;

  const showList = async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    await triggerSearch("linux");
    await screen.findByText("3 nodes");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "List" })); });
  };

  it("labels the graph and points keyboard users to the list", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    await triggerSearch("linux");
    const graph = await screen.findByRole("group", { name: "Dependency graph for linux, 3 packages" });
    expect(graph.tagName.toLowerCase()).toBe("svg");
    expect(graph).toHaveAccessibleDescription(/To explore with the keyboard, switch to List/);
    sweepA11y();
  });

  it("counts a single package in the graph label in the singular", async () => {
    mockGetDependencyTree.mockResolvedValue({ ...mockDependencyTreeResponse, nodes: mockDependencyTreeResponse.nodes.slice(0, 1), edges: [] });
    render(<DependencyView onShowDetails={onShowDetails} />);
    await triggerSearch("linux");
    expect(await screen.findByRole("group", { name: "Dependency graph for linux, 1 package" })).toBeInTheDocument();
  });

  it("fits the graph from the Fit button", async () => {
    render(<DependencyView onShowDetails={onShowDetails} />);
    await triggerSearch("linux");
    fireEvent.click(await screen.findByRole("button", { name: "Fit" }));
    const calls = mockUseForceGraph.mock.results.flatMap((r) => vi.mocked((r.value as ReturnType<typeof useForceGraph>).fitToContent).mock.calls);
    expect(calls).toHaveLength(1);
  });

  it("lists every node as a treeitem with its relation as text", async () => {
    await showList();
    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(mockDependencyTreeResponse.nodes.length);
    expect(screen.getByRole("tree", { name: "Dependencies of linux" })).toBeInTheDocument();
    expect(screen.getByText("linux 6.7.0-arch1-1, centre package")).toBeInTheDocument();
    expect(screen.getByText("kmod 33-1, dependency of linux")).toBeInTheDocument();
    expect(screen.getByText("zlib 1.3.1-1, dependency of kmod")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "false");
    sweepA11y();
  });

  it("describes reverse and optional relations and marks packages that are not installed", async () => {
    mockGetDependencyTree.mockResolvedValue({
      ...mockDependencyTreeResponse,
      nodes: [
        { ...mockDependencyTreeResponse.nodes[1] },
        { ...mockDependencyTreeResponse.nodes[0], depth: 1 },
        { id: "tool", name: "tool", version: "1-1", depth: 1, installed: false, reason: null, repository: "extra" },
      ],
      edges: [
        { source: "linux", target: "kmod", edge_type: "required_by" },
        { source: "tool", target: "kmod", edge_type: "optional_for" },
      ],
      root: "kmod",
    });
    await showList();
    expect(screen.getByText("linux 6.7.0-arch1-1, requires kmod")).toBeInTheDocument();
    expect(screen.getByText("tool 1-1, optionally requires kmod, not installed")).toBeInTheDocument();
  });

  it("opens details for the activated list item", async () => {
    await showList();
    const kmod = listText("kmod 33-1, dependency of linux");
    kmod.focus();
    await act(async () => { fireEvent.click(kmod); });
    expect(onShowDetails).toHaveBeenCalledWith({ name: "kmod", installed: true, repository: "core" });
  });

  it("re-centres from the list and returns focus to the new centre", async () => {
    await showList();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Centre on kmod" })); });
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "kmod", depth: 1, direction: "forward", optionalDepth: 0 });
    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent("linux 6.7.0-arch1-1, centre package");
    });
  });

  it("reaches a row's Centre action with the arrow keys", async () => {
    await showList();
    const zlib = listText("zlib 1.3.1-1, dependency of kmod");
    const centre = screen.getByRole("button", { name: "Centre on zlib" });
    expect(centre).toHaveAttribute("tabindex", "-1");
    zlib.focus();
    fireEvent.keyDown(zlib, { key: "ArrowRight" });
    expect(centre).toHaveFocus();
    fireEvent.keyDown(centre, { key: "ArrowLeft" });
    expect(zlib).toHaveFocus();
  });

  it("keeps the list and optional depth in step with the graph controls", async () => {
    await showList();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("slider", { name: "Optional dependency depth" }), { key: "ArrowRight" });
    });
    expect(mockGetDependencyTree).toHaveBeenLastCalledWith({ name: "linux", depth: 1, direction: "forward", optionalDepth: 1 });
    expect(await screen.findAllByRole("treeitem")).toHaveLength(3);
  });

  it("pans the graph to the last list selection when switching back", async () => {
    await showList();
    await act(async () => { fireEvent.click(listText("zlib 1.3.1-1, dependency of kmod")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Graph" })); });
    const calls = mockUseForceGraph.mock.results.flatMap((r) => vi.mocked((r.value as ReturnType<typeof useForceGraph>).focusNode).mock.calls);
    expect(calls).toEqual([["zlib"]]);
  });

  describe("details panel", () => {
    const fitCalls = () =>
      mockUseForceGraph.mock.results.flatMap((r) => vi.mocked((r.value as ReturnType<typeof useForceGraph>).fitToContent).mock.calls).length;
    const keepCalls = () =>
      mockUseForceGraph.mock.results.flatMap((r) => vi.mocked((r.value as ReturnType<typeof useForceGraph>).keepNodeInView).mock.calls);
    const kmodNode = { ...mockDependencyTreeResponse.nodes[1], reason: "dependency" as const };
    const lastOptions = () => mockUseForceGraph.mock.calls[mockUseForceGraph.mock.calls.length - 1][3];

    it("hands installed and not-installed nodes to the host", async () => {
      render(<DependencyView onShowDetails={onShowDetails} />);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");
      const onNodeClick = lastOptions().onNodeClick!;
      act(() => onNodeClick({ ...mockDependencyTreeResponse.nodes[1], reason: "dependency" }));
      act(() => onNodeClick({ id: "tool", name: "tool", version: "1-1", depth: 1, installed: false, reason: null, repository: "extra" }));
      expect(onShowDetails.mock.calls).toEqual([
        [{ name: "kmod", installed: true, repository: "core" }],
        [{ name: "tool", installed: false, repository: "extra" }],
      ]);
      expect(mockGetDependencyTree).toHaveBeenCalledTimes(1);
    });

    it("keeps the clicked node in view when the inline panel opens and leaves the view alone on close", async () => {
      const { rerender } = render(<DependencyView onShowDetails={onShowDetails} />);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");
      act(() => lastOptions().onNodeClick!(kmodNode));

      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen />);
      expect(keepCalls()).toEqual([["kmod"]]);
      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen />);
      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen={false} />);
      expect(keepCalls()).toEqual([["kmod"]]);
      expect(fitCalls()).toBe(0);
    });

    it("rings the node whose details are shown and drops the ring when the panel closes", async () => {
      const { rerender } = render(<DependencyView onShowDetails={onShowDetails} />);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");
      expect(lastOptions().selectedId).toBeNull();
      act(() => lastOptions().onNodeClick!(kmodNode));
      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen />);
      expect(lastOptions().selectedId).toBe("kmod");
      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen={false} />);
      expect(lastOptions().selectedId).toBeNull();
    });

    it("marks the list item whose details are shown with aria-current", async () => {
      const { rerender } = render(<DependencyView onShowDetails={onShowDetails} />);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "List" })); });
      await act(async () => { fireEvent.click(listText("kmod 33-1, dependency of linux")); });
      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen />);
      const current = screen.getAllByRole("treeitem").filter((li) => li.getAttribute("aria-current") === "true");
      expect(current.map((li) => li.id)).toEqual(["dependency-list-kmod"]);

      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen={false} />);
      expect(screen.getAllByRole("treeitem").some((li) => li.hasAttribute("aria-current"))).toBe(false);
    });

    it("keeps the view when the panel overlays the graph", async () => {
      const original = window.matchMedia;
      window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;
      try {
        const { rerender } = render(<DependencyView onShowDetails={onShowDetails} />);
        await triggerSearch("linux");
        await screen.findByText("3 nodes");
        act(() => lastOptions().onNodeClick!(kmodNode));
        rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen />);
        rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen={false} />);
        expect(fitCalls()).toBe(0);
        expect(keepCalls()).toEqual([]);
      } finally {
        window.matchMedia = original;
      }
    });

    it("returns focus to the list item when the panel closes", async () => {
      const { rerender } = render(<DependencyView onShowDetails={onShowDetails} />);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "List" })); });
      const kmod = listText("kmod 33-1, dependency of linux");
      kmod.focus();
      await act(async () => { fireEvent.click(kmod); });
      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen />);
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);

      rerender(<DependencyView onShowDetails={onShowDetails} detailsOpen={false} />);
      expect(listText("kmod 33-1, dependency of linux")).toHaveFocus();
    });

    it("loads again for a repeated request of the same package and not for an unchanged one", async () => {
      const { rerender } = render(<DependencyView request={{ name: "linux", seq: 1 }} onShowDetails={onShowDetails} />);
      await screen.findByText("3 nodes");
      rerender(<DependencyView request={{ name: "linux", seq: 1 }} onShowDetails={onShowDetails} />);
      await act(async () => {});
      expect(mockGetDependencyTree).toHaveBeenCalledTimes(1);

      rerender(<DependencyView request={{ name: "linux", seq: 2 }} onShowDetails={onShowDetails} />);
      await waitFor(() => expect(mockGetDependencyTree).toHaveBeenCalledTimes(2));
    });
  });

  describe("outside system changes", () => {
    const systemChanged = () => act(async () => {
      systemListeners.forEach((listener) => listener("system"));
    });
    const withLibc: api.DependencyTreeResponse = {
      ...mockDependencyTreeResponse,
      nodes: [
        ...mockDependencyTreeResponse.nodes,
        { id: "glibc", name: "glibc", version: "2.40-1", depth: 1, installed: true, reason: "dependency", repository: "core" },
      ],
      edges: [...mockDependencyTreeResponse.edges, { source: "linux", target: "glibc", edge_type: "depends" }],
    };

    it("refetches the same centre and keeps direction and view mode", async () => {
      await showList();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reverse" })); });
      await screen.findByText("3 nodes");
      mockGetDependencyTree.mockClear();
      mockGetDependencyTree.mockResolvedValue(withLibc);

      await systemChanged();

      expect(mockGetDependencyTree).toHaveBeenCalledTimes(1);
      expect(mockGetDependencyTree).toHaveBeenCalledWith({ name: "linux", depth: 1, direction: "reverse", optionalDepth: 0 });
      expect(await screen.findByText("4 nodes")).toBeInTheDocument();
      expect(screen.getAllByRole("treeitem")).toHaveLength(4);
      expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Reverse" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByText(/Loading dependency tree/)).not.toBeInTheDocument();
    });

    it("keeps the graph view key on a changed refresh and bumps it on an explicit load", async () => {
      render(<DependencyView onShowDetails={onShowDetails} />);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");
      const keyBefore = mockUseForceGraph.mock.lastCall?.[3].viewKey;

      mockGetDependencyTree.mockResolvedValue(withLibc);
      await systemChanged();
      await screen.findByText("4 nodes");
      expect(mockUseForceGraph.mock.lastCall?.[3].viewKey).toBe(keyBefore);

      mockGetDependencyTree.mockResolvedValue(mockDependencyTreeResponse);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");
      expect(mockUseForceGraph.mock.lastCall?.[3].viewKey).not.toBe(keyBefore);
    });

    it("leaves an unchanged graph and a failed refresh on screen", async () => {
      render(<DependencyView onShowDetails={onShowDetails} />);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");
      const nodesBefore = mockUseForceGraph.mock.lastCall?.[0];

      mockGetDependencyTree.mockResolvedValue({ ...mockDependencyTreeResponse, nodes: [...mockDependencyTreeResponse.nodes] });
      await systemChanged();
      expect(mockUseForceGraph.mock.lastCall?.[0]).toBe(nodesBefore);

      mockGetDependencyTree.mockRejectedValue(new Error("db busy"));
      await systemChanged();
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Could not load dependencies/ })).not.toBeInTheDocument();
    });

    it("keeps the graph and offers Try again when a refresh fails", async () => {
      render(<DependencyView onShowDetails={onShowDetails} />);
      await triggerSearch("linux");
      await screen.findByText("3 nodes");

      mockGetDependencyTree.mockRejectedValueOnce(new Error("db busy"));
      await systemChanged();

      expect(await screen.findByText("Could not refresh dependency graph")).toBeInTheDocument();
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
      expect(mockUseForceGraph.mock.lastCall?.[0]).toHaveLength(3);

      mockGetDependencyTree.mockResolvedValueOnce(withLibc);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      expect(await screen.findByText("4 nodes")).toBeInTheDocument();
      expect(screen.queryByText("Could not refresh dependency graph")).not.toBeInTheDocument();
    });

    it("does nothing before a package is shown", async () => {
      render(<DependencyView onShowDetails={onShowDetails} />);
      await systemChanged();
      expect(mockGetDependencyTree).not.toHaveBeenCalled();
    });
  });
});

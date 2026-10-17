import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import React from "react";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { computeFitTransform, computeKeepInView, seedPositions, transitionDuration, useForceGraph, type ForceGraphResult } from "./useForceGraph";
import type { DependencyNode, DependencyEdge } from "../api";

/* global SVGSVGElement */

describe("computeFitTransform", () => {
  const width = 800;
  const height = 600;
  const padding = 40;

  const projectedBox = (nodes: { x: number; y: number; name: string }[], t: { k: number; x: number; y: number }) => {
    const xs = nodes.flatMap((n) => [n.x - 12, n.x + 14 + n.name.length * 6.5]);
    const ys = nodes.flatMap((n) => [n.y - 12, n.y + 12]);
    return {
      left: t.x + t.k * Math.min(...xs),
      right: t.x + t.k * Math.max(...xs),
      top: t.y + t.k * Math.min(...ys),
      bottom: t.y + t.k * Math.max(...ys),
    };
  };

  it("scales a wide layout down so it fits inside the padding, centred", () => {
    const nodes = [
      { x: -1000, y: -50, name: "a" },
      { x: 1000, y: 50, name: "bbbb" },
      { x: 0, y: 0, name: "c" },
    ];
    const t = computeFitTransform(nodes, width, height, padding)!;
    expect(t.k).toBeLessThan(1);
    const box = projectedBox(nodes, t);
    expect(box.left).toBeCloseTo(padding, 5);
    expect(box.right).toBeCloseTo(width - padding, 5);
    expect(box.top).toBeGreaterThanOrEqual(padding);
    expect(box.bottom).toBeLessThanOrEqual(height - padding);
    expect((box.top + box.bottom) / 2).toBeCloseTo(height / 2, 5);
  });

  it("does not zoom a small layout past 1:1 and centres it", () => {
    const nodes = [{ x: 10, y: 10, name: "zlib" }];
    const t = computeFitTransform(nodes, width, height, padding)!;
    expect(t.k).toBe(1);
    const box = projectedBox(nodes, t);
    expect((box.left + box.right) / 2).toBeCloseTo(width / 2, 5);
    expect((box.top + box.bottom) / 2).toBeCloseTo(height / 2, 5);
  });

  it("clamps to the minimum zoom for huge layouts", () => {
    const t = computeFitTransform([{ x: -1e6, y: 0 }, { x: 1e6, y: 0 }], width, height, padding)!;
    expect(t.k).toBe(0.1);
  });

  it("returns null without positions or with an empty viewport", () => {
    expect(computeFitTransform([{ name: "unplaced" }], width, height)).toBeNull();
    expect(computeFitTransform([{ x: 0, y: 0 }], 0, height)).toBeNull();
  });
});

describe("computeKeepInView", () => {
  const t = { k: 2, x: 100, y: 50 };

  it("leaves a node that is already inside alone", () => {
    expect(computeKeepInView(t, { x: 0, y: 0, name: "a" }, 800, 600, 16)).toBeNull();
  });

  it("pans a node under the right edge just inside, at the same scale", () => {
    const moved = computeKeepInView(t, { x: 300, y: 0, name: "a" }, 600, 600, 16)!;
    expect(moved.k).toBe(2);
    expect(moved.y).toBe(50);
    expect(moved.x + 2 * (300 + 14 + 6.5)).toBeCloseTo(600 - 16, 5);
  });

  it("pans a node above the top edge down", () => {
    const moved = computeKeepInView(t, { x: 0, y: -100, name: "a" }, 800, 600, 16)!;
    expect(moved.k).toBe(2);
    expect(moved.x).toBe(100);
    expect(moved.y + 2 * (-100 - 12)).toBeCloseTo(16, 5);
  });

  it("aligns a node wider than the view to its left edge", () => {
    const moved = computeKeepInView(t, { x: 300, y: 0, name: "a-very-long-package-name" }, 120, 600, 16)!;
    expect(moved.x + 2 * (300 - 12)).toBeCloseTo(16, 5);
  });
});

describe("transitionDuration", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is 0 under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" }));
    expect(transitionDuration(500)).toBe(0);
  });

  it("keeps the length otherwise", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(transitionDuration(500)).toBe(500);
  });
});

describe("seedPositions", () => {
  it("keeps coordinates for nodes present before and after a change", () => {
    const previous = new Map([["kmod", { x: 12, y: -34 }], ["gone", { x: 1, y: 1 }]]);
    const nodes: { id: string; x?: number; y?: number }[] = [{ id: "kmod" }, { id: "new" }];
    expect(seedPositions(nodes, previous)).toBe(1);
    expect(nodes[0]).toEqual({ id: "kmod", x: 12, y: -34 });
    expect(nodes[1].x).toBeUndefined();
    expect(nodes[1].y).toBeUndefined();
  });
});

describe("useForceGraph view across rebuilds", () => {
  afterEach(cleanup);

  // jsdom has no SVG geometry; d3-zoom reads the extent from width/height.baseVal.
  beforeAll(() => {
    for (const dim of ["width", "height"] as const) {
      Object.defineProperty(SVGSVGElement.prototype, dim, {
        configurable: true,
        get: () => ({ baseVal: { value: dim === "width" ? 800 : 600 } }),
      });
    }
  });
  afterAll(() => {
    for (const dim of ["width", "height"] as const) {
      delete (SVGSVGElement.prototype as unknown as Record<string, unknown>)[dim];
    }
  });

  const node = (id: string): DependencyNode => ({
    id, name: id, version: "1", depth: id === "a" ? 0 : 1, installed: true, reason: "explicit", repository: "core",
  } as DependencyNode);
  const two = { nodes: [node("a"), node("b")], edges: [{ source: "a", target: "b", edge_type: "depends" }] as DependencyEdge[] };
  const three = { nodes: [...two.nodes, node("c")], edges: [...two.edges, { source: "a", target: "c", edge_type: "depends" }] as DependencyEdge[] };

  const Graph: React.FC<{
    graph: typeof two;
    viewKey: number;
    width?: number;
    selectedId?: string | null;
    api?: { current: ForceGraphResult | null };
  }> = ({ graph, viewKey, width = 800, selectedId, api }) => {
    const result = useForceGraph(graph.nodes, graph.edges, "a", { width, height: 600, viewKey, selectedId });
    React.useEffect(() => {
      if (api) api.current = result;
    });
    return React.createElement("svg", { ref: result.svgRef, "data-testid": "graph" });
  };

  const viewTransform = (svg: Element) => svg.querySelector(":scope > g")?.getAttribute("transform");
  const centred = "translate(400,300) scale(1)";

  it("keeps a view the user moved when the graph changes under the same key", () => {
    const { getByTestId, rerender } = render(React.createElement(Graph, { graph: two, viewKey: 1 }));
    const svg = getByTestId("graph");
    expect(viewTransform(svg)).toBe(centred);

    act(() => { fireEvent.wheel(svg, { deltaY: -500 }); });
    const moved = viewTransform(svg);
    expect(moved).not.toBe(centred);

    rerender(React.createElement(Graph, { graph: three, viewKey: 1 }));
    expect(svg.querySelectorAll("circle:not(.selection-ring)")).toHaveLength(3);
    expect(viewTransform(svg)).toBe(moved);
  });

  it("starts centred again under a new key", () => {
    const { getByTestId, rerender } = render(React.createElement(Graph, { graph: two, viewKey: 1 }));
    const svg = getByTestId("graph");
    act(() => { fireEvent.wheel(svg, { deltaY: -500 }); });
    expect(viewTransform(svg)).not.toBe(centred);

    rerender(React.createElement(Graph, { graph: three, viewKey: 2 }));
    expect(viewTransform(svg)).toBe(centred);
  });

  it("starts centred on a changed graph when the user never moved the view", () => {
    const { getByTestId, rerender } = render(React.createElement(Graph, { graph: two, viewKey: 1 }));
    const svg = getByTestId("graph");
    rerender(React.createElement(Graph, { graph: three, viewKey: 1 }));
    expect(viewTransform(svg)).toBe(centred);
  });

  const scaleOf = (svg: Element) => Number(/scale\(([^)]+)\)/.exec(viewTransform(svg) ?? "")?.[1]);

  it("keeps layout and view when the width changes", () => {
    const { getByTestId, rerender } = render(React.createElement(Graph, { graph: two, viewKey: 1 }));
    const svg = getByTestId("graph");
    act(() => { fireEvent.wheel(svg, { deltaY: -500 }); });
    const moved = viewTransform(svg);
    const circle = svg.querySelector("circle");

    rerender(React.createElement(Graph, { graph: two, viewKey: 1, width: 500 }));
    expect(viewTransform(svg)).toBe(moved);
    expect(svg.querySelector("circle")).toBe(circle);
  });

  describe("under prefers-reduced-motion", () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const reduceMotion = (reduce: boolean) =>
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)" }));

    it("applies a fit at once instead of animating it", () => {
      const api = { current: null as ForceGraphResult | null };
      const { getByTestId } = render(React.createElement(Graph, { graph: two, viewKey: 1, api }));
      const svg = getByTestId("graph");
      reduceMotion(false);
      act(() => api.current!.fitToContent());
      expect(viewTransform(svg)).toBe(centred);

      reduceMotion(true);
      act(() => api.current!.fitToContent());
      expect(viewTransform(svg)).not.toBe(centred);
    });

    it("keeps the scale when it pans a node back into a narrowed view", () => {
      reduceMotion(true);
      const api = { current: null as ForceGraphResult | null };
      const { getByTestId, rerender } = render(React.createElement(Graph, { graph: two, viewKey: 1, api }));
      const svg = getByTestId("graph");
      act(() => { fireEvent.wheel(svg, { deltaY: -500 }); });
      const k = scaleOf(svg);
      expect(k).not.toBe(1);

      rerender(React.createElement(Graph, { graph: two, viewKey: 1, width: 100, api }));
      const before = viewTransform(svg);
      act(() => api.current!.keepNodeInView("b"));
      expect(viewTransform(svg)).not.toBe(before);
      expect(scaleOf(svg)).toBe(k);
    });
  });

  it("rings only the selected node and moves the ring without a rebuild", () => {
    const { getByTestId, rerender } = render(React.createElement(Graph, { graph: two, viewKey: 1, selectedId: "a" }));
    const svg = getByTestId("graph");
    const shown = () => Array.from(svg.querySelectorAll("circle.selection-ring"))
      .filter((c) => c.getAttribute("display") !== "none")
      .map((c) => c.parentElement?.querySelector("text")?.textContent);
    expect(shown()).toEqual(["a"]);
    const circle = svg.querySelector("circle");

    rerender(React.createElement(Graph, { graph: two, viewKey: 1, selectedId: "b" }));
    expect(shown()).toEqual(["b"]);
    expect(svg.querySelector("circle")).toBe(circle);

    rerender(React.createElement(Graph, { graph: two, viewKey: 1, selectedId: null }));
    expect(shown()).toEqual([]);
  });
});

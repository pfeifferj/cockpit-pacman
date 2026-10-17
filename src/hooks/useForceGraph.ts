import React, { useEffect, useRef, useCallback } from "react";
import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide,
  type Simulation, type SimulationNodeDatum, type SimulationLinkDatum,
} from "d3-force";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { drag } from "d3-drag";
import { DependencyNode, DependencyEdge } from "../api";

/* global SVGSVGElement, SVGGElement, SVGCircleElement */

export interface ForceGraphNode extends SimulationNodeDatum {
  id: string;
  name: string;
  version: string;
  depth: number;
  installed: boolean;
  reason: "explicit" | "dependency" | null;
  repository: string | null;
  isRoot?: boolean;
}

export interface ForceGraphEdge extends SimulationLinkDatum<ForceGraphNode> {
  source: string | ForceGraphNode;
  target: string | ForceGraphNode;
  edge_type: "depends" | "optdepends" | "required_by" | "optional_for";
}

export interface ForceGraphOptions {
  width: number;
  height: number;
  onNodeClick?: (node: ForceGraphNode) => void;
  onNodeDoubleClick?: (node: ForceGraphNode) => void;
  /** Rebuilds with the same key keep a view the user moved; a new key starts fresh and fits. Defaults to rootId. */
  viewKey?: string | number;
  selectedId?: string | null;
}

export interface ForceGraphResult {
  svgRef: React.RefObject<SVGSVGElement>;
  resetView: () => void;
  fitToContent: (padding?: number) => void;
  focusNode: (id: string) => void;
  /** Pans at the current zoom to reveal a node. */
  keepNodeInView: (id: string) => void;
}

export interface FitTransform {
  k: number;
  x: number;
  y: number;
}

export interface Positioned {
  x?: number;
  y?: number;
  name?: string;
}

const SCALE_EXTENT: [number, number] = [0.1, 4];
// Fit never zooms in past 1:1, so a two-node graph is not blown up to fill the view.
const FIT_MAX_SCALE = 1;
const LABEL_OFFSET = 14;
const LABEL_CHAR_WIDTH = 6.5;
const NODE_EXTENT = 12;
const FIT_PADDING = 40;
const KEEP_IN_VIEW_MARGIN = 16;
const SELECTION_RING_GAP = 5;

export function transitionDuration(ms: number): number {
  const reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  return reduce ? 0 : ms;
}

function zoomTo(svgEl: SVGSVGElement, behavior: ZoomBehavior<SVGSVGElement, unknown>, t: ZoomTransform, ms: number) {
  const svg = select(svgEl);
  const duration = transitionDuration(ms);
  if (duration === 0) {
    svg.interrupt();
    svg.call(behavior.transform, t);
  } else {
    svg.transition().duration(duration).call(behavior.transform, t);
  }
}

function nodeRight(n: Positioned): number {
  return n.name ? LABEL_OFFSET + n.name.length * LABEL_CHAR_WIDTH : NODE_EXTENT;
}

/** Fits nodes and labels inside the padded viewport. */
export function computeFitTransform(
  nodes: Positioned[],
  width: number,
  height: number,
  padding = FIT_PADDING
): FitTransform | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x === undefined || n.y === undefined) continue;
    const labelRight = nodeRight(n);
    minX = Math.min(minX, n.x - NODE_EXTENT);
    maxX = Math.max(maxX, n.x + labelRight);
    minY = Math.min(minY, n.y - NODE_EXTENT);
    maxY = Math.max(maxY, n.y + NODE_EXTENT);
  }
  if (!Number.isFinite(minX) || width <= 0 || height <= 0) return null;
  const availW = Math.max(width - 2 * padding, 1);
  const availH = Math.max(height - 2 * padding, 1);
  const k = Math.max(SCALE_EXTENT[0], Math.min(FIT_MAX_SCALE, availW / (maxX - minX), availH / (maxY - minY)));
  return {
    k,
    x: width / 2 - k * (minX + maxX) / 2,
    y: height / 2 - k * (minY + maxY) / 2,
  };
}

/** Pans to reveal a node and label; returns null when already visible. */
export function computeKeepInView(
  t: FitTransform,
  node: Positioned,
  width: number,
  height: number,
  margin = KEEP_IN_VIEW_MARGIN
): FitTransform | null {
  if (node.x === undefined || node.y === undefined || width <= 0 || height <= 0) return null;
  const shift = (lo: number, hi: number, size: number) => {
    if (hi > size - margin) return Math.max(size - margin - hi, margin - lo);
    if (lo < margin) return margin - lo;
    return 0;
  };
  const dx = shift(t.x + t.k * (node.x - NODE_EXTENT), t.x + t.k * (node.x + nodeRight(node)), width);
  const dy = shift(t.y + t.k * (node.y - NODE_EXTENT), t.y + t.k * (node.y + NODE_EXTENT), height);
  if (dx === 0 && dy === 0) return null;
  return { k: t.k, x: t.x + dx, y: t.y + dy };
}

/** Copies x/y from the previous layout onto nodes with the same id; returns how many were seeded. */
export function seedPositions(
  nodes: { id: string; x?: number; y?: number }[],
  previous: Map<string, { x: number; y: number }>
): number {
  let seeded = 0;
  for (const n of nodes) {
    const p = previous.get(n.id);
    if (p) {
      n.x = p.x;
      n.y = p.y;
      seeded++;
    }
  }
  return seeded;
}

const NODE_COLORS = {
  root: "#0066cc",
  explicit: "#3e8635",
  dependency: "#f0ab00",
  notInstalled: "#6a6e73",
};

export function useForceGraph(
  nodes: DependencyNode[],
  edges: DependencyEdge[],
  rootId: string,
  options: ForceGraphOptions
): ForceGraphResult {
  const { width, height, onNodeClick, onNodeDoubleClick } = options;
  const viewKey = options.viewKey ?? rootId;
  const svgRef = useRef<SVGSVGElement>(null!);
  const simulationRef = useRef<Simulation<ForceGraphNode, ForceGraphEdge> | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const graphNodesRef = useRef<ForceGraphNode[]>([]);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const userMovedRef = useRef(false);
  const userTransformRef = useRef<ZoomTransform | null>(null);
  const viewKeyRef = useRef<string | number | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const sizeRef = useRef({ width, height });
  const selectedId = options.selectedId ?? null;

  useEffect(() => {
    sizeRef.current = { width, height };
  }, [width, height]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (!svgRef.current) return;
    select(svgRef.current)
      .selectAll<SVGCircleElement, ForceGraphNode>("circle.selection-ring")
      .attr("display", (d) => d.id === selectedId ? null : "none");
  }, [selectedId]);

  const resetView = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    userMovedRef.current = true;
    zoomTo(svgRef.current, zoomRef.current, zoomIdentity.translate(width / 2, height / 2), 750);
  }, [width, height]);

  const fitToContent = useCallback((padding = FIT_PADDING) => {
    if (!svgRef.current || !zoomRef.current) return;
    const t = computeFitTransform(graphNodesRef.current, width, height, padding);
    if (!t) return;
    userMovedRef.current = true;
    zoomTo(svgRef.current, zoomRef.current, zoomIdentity.translate(t.x, t.y).scale(t.k), 500);
  }, [width, height]);

  const focusNode = useCallback((id: string) => {
    if (!svgRef.current || !zoomRef.current) return;
    const target = graphNodesRef.current.find((n) => n.id === id);
    if (!target || target.x === undefined || target.y === undefined) return;
    const { k } = zoomTransform(svgRef.current);
    userMovedRef.current = true;
    zoomTo(svgRef.current, zoomRef.current, zoomIdentity.translate(width / 2 - k * target.x, height / 2 - k * target.y).scale(k), 500);
  }, [width, height]);

  const keepNodeInView = useCallback((id: string) => {
    if (!svgRef.current || !zoomRef.current) return;
    const target = graphNodesRef.current.find((n) => n.id === id);
    if (!target) return;
    const t = computeKeepInView(zoomTransform(svgRef.current), target, width, height);
    if (!t) return;
    userMovedRef.current = true;
    zoomTo(svgRef.current, zoomRef.current, zoomIdentity.translate(t.x, t.y).scale(t.k), 500);
  }, [width, height]);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;
    const { width, height } = sizeRef.current;

    const svg = select(svgRef.current);
    svg.interrupt();
    svg.selectAll("*").remove();

    if (viewKey !== viewKeyRef.current) {
      viewKeyRef.current = viewKey;
      userTransformRef.current = null;
    }
    if (!userTransformRef.current) userMovedRef.current = false;

    // The backend only emits the documented reason/edge_type literals; the
    // generated wire types widen them to string, so narrow back here.
    const graphNodes: ForceGraphNode[] = nodes.map((n) => ({
      ...n,
      reason: n.reason as ForceGraphNode["reason"],
      isRoot: n.id === rootId,
    }));
    const seeded = seedPositions(graphNodes, positionsRef.current);
    graphNodesRef.current = graphNodes;

    const graphEdges: ForceGraphEdge[] = edges.map((e) => ({
      source: e.source,
      target: e.target,
      edge_type: e.edge_type as ForceGraphEdge["edge_type"],
    }));

    const container = svg.append("g");

    // Gestures survive graph rebuilds, so the shared zoom listener must use the new container.
    zoomRef.current ??= zoom<SVGSVGElement, unknown>().scaleExtent(SCALE_EXTENT);
    const zoomBehavior = zoomRef.current.on("zoom", (event) => {
      if (event.sourceEvent) userMovedRef.current = true;
      if (userMovedRef.current) userTransformRef.current = event.transform;
      container.attr("transform", event.transform);
    });

    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);
    svg.call(zoomBehavior.transform, userTransformRef.current ?? zoomIdentity.translate(width / 2, height / 2));

    const simulation = forceSimulation<ForceGraphNode>(graphNodes)
      .force("link", forceLink<ForceGraphNode, ForceGraphEdge>(graphEdges)
        .id((d) => d.id)
        .distance(80))
      .force("charge", forceManyBody().strength(-300))
      .force("center", forceCenter(0, 0))
      .force("collision", forceCollide().radius(30));

    // Mostly-known layouts start cooler so persisting nodes stay near where the reader left them.
    if (seeded > graphNodes.length / 2) simulation.alpha(0.3);

    simulationRef.current = simulation;

    const defs = svg.append("defs");
    defs.append("marker")
      .attr("id", "arrowhead")
      .attr("viewBox", "-0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("orient", "auto")
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .append("path")
      .attr("d", "M 0,-5 L 10,0 L 0,5")
      .attr("fill", "#6a6e73");

    const link = container.append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(graphEdges)
      .join("line")
      .attr("stroke", "#6a6e73")
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", (d) =>
        d.edge_type === "optdepends" || d.edge_type === "optional_for" ? "4,4" : null
      )
      .attr("marker-end", "url(#arrowhead)");

    const dragBehavior = drag<SVGGElement, ForceGraphNode>()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    const node = container.append("g")
      .attr("class", "nodes")
      .selectAll<SVGGElement, ForceGraphNode>("g")
      .data(graphNodes)
      .join("g")
      .call(dragBehavior);

    node.append("circle")
      .attr("class", "selection-ring")
      .attr("r", (d) => (d.isRoot ? 12 : 8) + SELECTION_RING_GAP)
      .attr("fill", "none")
      .attr("stroke", "var(--pf-t--global--border--color--clicked)")
      .attr("stroke-width", 3)
      .attr("display", (d) => d.id === selectedIdRef.current ? null : "none");

    node.append("circle")
      .attr("r", (d) => d.isRoot ? 12 : 8)
      .attr("fill", (d) => {
        if (d.isRoot) return NODE_COLORS.root;
        if (!d.installed) return NODE_COLORS.notInstalled;
        if (d.reason === "explicit") return NODE_COLORS.explicit;
        return NODE_COLORS.dependency;
      })
      .attr("stroke", "#fff")
      .attr("stroke-width", 2);

    node.append("text")
      .text((d) => d.name)
      .attr("x", 14)
      .attr("y", 4)
      .attr("font-size", "11px")
      .attr("fill", "var(--pf-t--global--text--color--regular)");

    let clickTimer: ReturnType<typeof setTimeout> | null = null;

    node.on("click", (_event, d) => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        onNodeClick?.(d);
      }, 250);
    });

    node.on("dblclick", (_event, d) => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      onNodeDoubleClick?.(d);
    });

    node.append("title")
      .text((d) => `${d.name} ${d.version}\n${d.repository || "unknown"}\n${d.installed ? (d.reason || "installed") : "not installed"}`);

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as ForceGraphNode).x || 0)
        .attr("y1", (d) => (d.source as ForceGraphNode).y || 0)
        .attr("x2", (d) => (d.target as ForceGraphNode).x || 0)
        .attr("y2", (d) => (d.target as ForceGraphNode).y || 0);

      node.attr("transform", (d) => `translate(${d.x || 0},${d.y || 0})`);
    });

    let fitted = false;
    simulation.on("end", () => {
      if (fitted || userMovedRef.current || !zoomRef.current) return;
      fitted = true;
      const t = computeFitTransform(graphNodes, sizeRef.current.width, sizeRef.current.height);
      if (!t || !svgRef.current) return;
      zoomTo(svgRef.current, zoomBehavior, zoomIdentity.translate(t.x, t.y).scale(t.k), 500);
    });

    return () => {
      if (clickTimer) clearTimeout(clickTimer);
      simulation.stop();
      const positions = new Map<string, { x: number; y: number }>();
      for (const n of graphNodes) {
        if (n.x !== undefined && n.y !== undefined) positions.set(n.id, { x: n.x, y: n.y });
      }
      positionsRef.current = positions;
    };
  }, [nodes, edges, rootId, viewKey, onNodeClick, onNodeDoubleClick]);

  return { svgRef, resetView, fitToContent, focusNode, keepNodeInView };
}

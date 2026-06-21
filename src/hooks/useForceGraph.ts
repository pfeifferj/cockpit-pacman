import React, { useEffect, useRef, useCallback } from "react";
import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide,
  type Simulation, type SimulationNodeDatum, type SimulationLinkDatum,
} from "d3-force";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { drag } from "d3-drag";
import { DependencyNode, DependencyEdge } from "../api";

/* global SVGSVGElement, SVGGElement */

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
}

export interface ForceGraphResult {
  svgRef: React.RefObject<SVGSVGElement>;
  resetView: () => void;
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
  const svgRef = useRef<SVGSVGElement>(null!);
  const simulationRef = useRef<Simulation<ForceGraphNode, ForceGraphEdge> | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const resetView = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = select(svgRef.current);
    svg.transition().duration(750).call(
      zoomRef.current.transform,
      zoomIdentity.translate(options.width / 2, options.height / 2)
    );
  }, [options.width, options.height]);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = select(svgRef.current);
    svg.selectAll("*").remove();

    // The backend only emits the documented reason/edge_type literals; the
    // generated wire types widen them to string, so narrow back here.
    const graphNodes: ForceGraphNode[] = nodes.map((n) => ({
      ...n,
      reason: n.reason as ForceGraphNode["reason"],
      isRoot: n.id === rootId,
    }));

    const graphEdges: ForceGraphEdge[] = edges.map((e) => ({
      source: e.source,
      target: e.target,
      edge_type: e.edge_type as ForceGraphEdge["edge_type"],
    }));

    const container = svg.append("g");

    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        container.attr("transform", event.transform);
      });

    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);
    svg.call(zoomBehavior.transform, zoomIdentity.translate(options.width / 2, options.height / 2));

    const simulation = forceSimulation<ForceGraphNode>(graphNodes)
      .force("link", forceLink<ForceGraphNode, ForceGraphEdge>(graphEdges)
        .id((d) => d.id)
        .distance(80))
      .force("charge", forceManyBody().strength(-300))
      .force("center", forceCenter(0, 0))
      .force("collision", forceCollide().radius(30));

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
        options.onNodeClick?.(d);
      }, 250);
    });

    node.on("dblclick", (_event, d) => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      options.onNodeDoubleClick?.(d);
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

    return () => {
      if (clickTimer) clearTimeout(clickTimer);
      simulation.stop();
    };
  }, [nodes, edges, rootId, options]);

  return { svgRef, resetView };
}

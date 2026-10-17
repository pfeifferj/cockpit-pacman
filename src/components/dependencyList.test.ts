import { describe, it, expect } from "vitest";
import { buildDependencyList } from "./DependencyView";
import type { DependencyEdge, DependencyNode } from "../api";

function node(name: string, over: Partial<DependencyNode> = {}): DependencyNode {
  return { id: name, name, version: "1-1", depth: 0, installed: true, reason: "dependency", repository: "extra", ...over };
}

const edge = (source: string, target: string, edge_type = "depends"): DependencyEdge => ({ source, target, edge_type });

type Tree = ReturnType<typeof buildDependencyList>;
const outline = (item: Tree): unknown => (item ? [item.label, ...item.children.map(outline)] : null);

describe("buildDependencyList", () => {
  it("returns null when the root is not among the nodes", () => {
    expect(buildDependencyList([node("a")], [], "missing")).toBeNull();
  });

  it("labels each package with its version, relation to its parent and install state", () => {
    const nodes = [node("vim", { version: "9.1-1" }), node("gpm"), node("python", { installed: false })];
    const edges = [edge("vim", "gpm"), edge("vim", "python", "optdepends")];
    expect(outline(buildDependencyList(nodes, edges, "vim"))).toEqual([
      "vim 9.1-1, centre package",
      ["gpm 1-1, dependency of vim"],
      ["python 1-1, optional dependency of vim, not installed"],
    ]);
  });

  it("walks reverse edges from target to source", () => {
    const nodes = [node("glibc"), node("bash"), node("vim")];
    const edges = [edge("bash", "glibc", "required_by"), edge("vim", "glibc", "optional_for")];
    expect(outline(buildDependencyList(nodes, edges, "glibc"))).toEqual([
      "glibc 1-1, centre package",
      ["bash 1-1, requires glibc"],
      ["vim 1-1, optionally requires glibc"],
    ]);
  });

  it("places a shared dependency once, at its shortest distance", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("c", "d")];
    expect(outline(buildDependencyList(nodes, edges, "a"))).toEqual([
      "a 1-1, centre package",
      ["b 1-1, dependency of a"],
      ["c 1-1, dependency of a", ["d 1-1, dependency of c"]],
    ]);
  });

  it("terminates on cycles and skips edges to unknown nodes", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b"), edge("b", "a"), edge("a", "ghost")];
    expect(outline(buildDependencyList(nodes, edges, "a"))).toEqual([
      "a 1-1, centre package",
      ["b 1-1, dependency of a"],
    ]);
  });

  it("reads an unknown edge type as a dependency", () => {
    const tree = buildDependencyList([node("a"), node("b")], [edge("a", "b", "makedepends")], "a");
    expect(tree?.children[0].label).toBe("b 1-1, dependency of a");
  });

  it("keeps the node objects so a list item can open details", () => {
    const b = node("b", { repository: null });
    const tree = buildDependencyList([node("a"), b], [edge("a", "b")], "a");
    expect(tree?.children[0].node).toBe(b);
  });
});

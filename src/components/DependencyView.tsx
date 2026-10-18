import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import {
  Card,
  CardBody,
  Spinner,
  Alert,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarToggleGroup,
  EmptyState,
  EmptyStateBody,
  Button,
  Slider,
  SliderOnChangeEvent,
  ToggleGroup,
  ToggleGroupItem,
  Flex,
  FlexItem,
  Label,
  Select,
  SelectOption,
  SelectList,
  MenuToggle,
  MenuToggleElement,
  TextInputGroup,
  TextInputGroupMain,
  TextInputGroupUtilities,
  TreeView,
  TreeViewDataItem,
} from "@patternfly/react-core";
import { TopologyIcon, SyncAltIcon, TimesIcon, ExpandIcon, FilterIcon } from "@patternfly/react-icons";
import {
  DependencyNode,
  DependencyEdge,
  DependencyDirection,
  DependencyTreeResponse,
  getDependencyTree,
  searchPackages,
  SearchResult,
} from "../api";
import { plural, sanitizeSearchInput } from "../utils";
import { useForceGraph, ForceGraphNode } from "../hooks/useForceGraph";
import { useDebouncedValue } from "../hooks/useDebounce";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { useDetailsInline } from "./PackageDetailsDrawer";
import { LoadErrorState, RefreshFailedAlert, toLoadFailure, type LoadFailure } from "./LoadErrorState";
import { SEARCH_DEBOUNCE_MS } from "../constants";

const GRAPH_HEIGHT = 600;

const Legend: React.FC = () => (
  <Flex gap={{ default: "gapMd" }} className="pf-v6-u-mt-sm">
    <FlexItem>
      <Flex gap={{ default: "gapSm" }} alignItems={{ default: "alignItemsCenter" }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#0066cc", display: "inline-block" }} />
        <span style={{ fontSize: "0.875rem" }}>Root package</span>
      </Flex>
    </FlexItem>
    <FlexItem>
      <Flex gap={{ default: "gapSm" }} alignItems={{ default: "alignItemsCenter" }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#3e8635", display: "inline-block" }} />
        <span style={{ fontSize: "0.875rem" }}>Explicit</span>
      </Flex>
    </FlexItem>
    <FlexItem>
      <Flex gap={{ default: "gapSm" }} alignItems={{ default: "alignItemsCenter" }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#f0ab00", display: "inline-block" }} />
        <span style={{ fontSize: "0.875rem" }}>Dependency</span>
      </Flex>
    </FlexItem>
    <FlexItem>
      <Flex gap={{ default: "gapSm" }} alignItems={{ default: "alignItemsCenter" }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#6a6e73", display: "inline-block" }} />
        <span style={{ fontSize: "0.875rem" }}>Not installed</span>
      </Flex>
    </FlexItem>
    <FlexItem>
      <Flex gap={{ default: "gapSm" }} alignItems={{ default: "alignItemsCenter" }}>
        <span style={{ width: 24, height: 2, backgroundColor: "#6a6e73", display: "inline-block" }} />
        <span style={{ fontSize: "0.875rem" }}>Required</span>
      </Flex>
    </FlexItem>
    <FlexItem>
      <Flex gap={{ default: "gapSm" }} alignItems={{ default: "alignItemsCenter" }}>
        <span style={{ width: 24, height: 0, borderTop: "2px dashed #6a6e73", display: "inline-block" }} />
        <span style={{ fontSize: "0.875rem" }}>Optional</span>
      </Flex>
    </FlexItem>
  </Flex>
);

type GraphViewMode = "graph" | "list";

const RELATION_TEXT: Record<string, (parent: string) => string> = {
  depends: (parent) => `dependency of ${parent}`,
  optdepends: (parent) => `optional dependency of ${parent}`,
  required_by: (parent) => `requires ${parent}`,
  optional_for: (parent) => `optionally requires ${parent}`,
};

const REVERSE_EDGE_TYPES = new Set(["required_by", "optional_for"]);

interface ListNode {
  node: DependencyNode;
  label: string;
  children: ListNode[];
}

/** Builds a breadth-first dependency tree with each node at its shortest distance. */
export function buildDependencyList(nodes: DependencyNode[], edges: DependencyEdge[], rootId: string): ListNode | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(rootId);
  if (!root) return null;
  const outgoing = new Map<string, { child: string; edgeType: string }[]>();
  for (const e of edges) {
    const [from, to] = REVERSE_EDGE_TYPES.has(e.edge_type) ? [e.target, e.source] : [e.source, e.target];
    const list = outgoing.get(from) ?? [];
    list.push({ child: to, edgeType: e.edge_type });
    outgoing.set(from, list);
  }
  const describe = (n: DependencyNode, relation: string) =>
    [`${n.name} ${n.version}`, relation, n.installed ? null : "not installed"].filter(Boolean).join(", ");
  const rootItem: ListNode = { node: root, label: describe(root, "centre package"), children: [] };
  const seen = new Set([rootId]);
  const queue = [rootItem];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const { child, edgeType } of outgoing.get(current.node.id) ?? []) {
      const childNode = byId.get(child);
      if (!childNode || seen.has(child)) continue;
      seen.add(child);
      const relation = (RELATION_TEXT[edgeType] ?? RELATION_TEXT.depends)(current.node.name);
      const item: ListNode = { node: childNode, label: describe(childNode, relation), children: [] };
      current.children.push(item);
      queue.push(item);
    }
  }
  return rootItem;
}

/** A request to centre the graph on name; a new seq repeats it for the same name. */
export interface GraphRequest {
  name: string;
  seq: number;
}

export type GraphNodeRef = Pick<DependencyNode, "name" | "installed" | "repository">;

interface DependencyViewProps {
  request?: GraphRequest;
  onShowDetails: (node: GraphNodeRef) => void;
  detailsOpen?: boolean;
}

export const DependencyView: React.FC<DependencyViewProps> = ({ request, onShowDetails, detailsOpen = false }) => {
  const [nodes, setNodes] = useState<DependencyNode[]>([]);
  const [edges, setEdges] = useState<DependencyEdge[]>([]);
  const [rootId, setRootId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<{ name: string; depth: number; direction: DependencyDirection; optionalDepth: number; failure: LoadFailure } | null>(null);
  const [refreshError, setRefreshError] = useState<LoadFailure | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState(request?.name ?? "");
  const [hasSearched, setHasSearched] = useState(false);
  const [depth, setDepth] = useState(1);
  const [optionalDepth, setOptionalDepth] = useState(0);
  const [direction, setDirection] = useState<DependencyDirection>("forward");
  const [graphWidth, setGraphWidth] = useState(800);
  const [viewMode, setViewMode] = useState<GraphViewMode>("graph");
  const [listFocusId, setListFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shownId = detailsOpen ? selectedId : null;
  // Bumped by explicit loads only, so a background refresh keeps the user's pan and zoom.
  const [graphViewKey, setGraphViewKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const focusListAfterLoadRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);
  const lastRequestRef = useRef<GraphRequest | null>(null);
  const requestIdRef = useRef(0);
  const requestedPackageRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const shownGraphRef = useRef("");
  const paramsRef = useRef({ depth: 1, direction: "forward" as DependencyDirection, optionalDepth: 0 });

  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const optionsToggleRef = useRef<ToolbarToggleGroup>(null);
  // PatternFly hardcodes the collapsed toggle's name as "Show Filters".
  useLayoutEffect(() => {
    optionsToggleRef.current?.toggleRef.current?.setAttribute("aria-label", "Show graph options");
  });
  const debouncedSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);

  const showTree = useCallback((response: DependencyTreeResponse, depthVal: number) => {
    shownGraphRef.current = JSON.stringify([response.root, response.nodes, response.edges]);
    setNodes(response.nodes);
    setEdges(response.edges);
    setRootId(response.root);
    setWarnings(response.max_depth_reached && depthVal >= 5
      ? [...response.warnings, "Maximum depth reached. Some dependencies may not be shown."]
      : response.warnings);
  }, []);

  const fetchDependencyTree = useCallback(async (name: string, depthVal: number, dir: DependencyDirection, optionalDepthVal: number) => {
    const requestId = ++requestIdRef.current;
    requestedPackageRef.current = name;
    loadingRef.current = true;
    setLoading(true);
    setInputError(null);
    setLoadError(null);
    setRefreshError(null);
    setWarnings([]);
    setHasSearched(true);
    try {
      const response = await getDependencyTree({ name, depth: depthVal, direction: dir, optionalDepth: optionalDepthVal });
      if (!isMountedRef.current || requestId !== requestIdRef.current) return;
      setGraphViewKey((k) => k + 1);
      showTree(response, depthVal);
    } catch (ex) {
      if (!isMountedRef.current || requestId !== requestIdRef.current) return;
      setLoadError({ name, depth: depthVal, direction: dir, optionalDepth: optionalDepthVal, failure: toLoadFailure(ex) });
      shownGraphRef.current = "";
      setNodes([]);
      setEdges([]);
      setRootId("");
    } finally {
      if (isMountedRef.current && requestId === requestIdRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [showTree]);

  useEffect(() => {
    paramsRef.current = { depth, direction, optionalDepth };
  }, [depth, direction, optionalDepth]);

  const refreshTree = useCallback(async () => {
    const name = requestedPackageRef.current;
    if (!name || loadingRef.current) return;
    const requestId = requestIdRef.current;
    const { depth: depthVal, direction: dir, optionalDepth: optionalDepthVal } = paramsRef.current;
    try {
      const response = await getDependencyTree({ name, depth: depthVal, direction: dir, optionalDepth: optionalDepthVal });
      if (!isMountedRef.current || requestId !== requestIdRef.current) return;
      setLoadError(null);
      setRefreshError(null);
      if (JSON.stringify([response.root, response.nodes, response.edges]) === shownGraphRef.current) return;
      showTree(response, depthVal);
    } catch (ex) {
      if (!isMountedRef.current || requestId !== requestIdRef.current) return;
      setRefreshError(toLoadFailure(ex));
    }
  }, [showTree]);

  useRefreshOnActivate(() => {
    void refreshTree();
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const last = lastRequestRef.current;
    if (!request || (last && last.name === request.name && last.seq === request.seq)) return;
    lastRequestRef.current = request;
    const { name } = request;
    Promise.resolve().then(() => {
      setSearchInput(name);
      void fetchDependencyTree(name, depth, direction, optionalDepth);
    });
  }, [request, depth, direction, optionalDepth, fetchDependencyTree]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      // A hidden graph (List view) reports 0; keep the last real width so the layout survives.
      if (containerRef.current && containerRef.current.offsetWidth > 0) {
        setGraphWidth(containerRef.current.offsetWidth);
      }
    };

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [nodes.length]);

  useEffect(() => {
    if (!debouncedSearch || debouncedSearch.length < 2) {
      Promise.resolve().then(() => setSuggestions([]));
      return;
    }
    let cancelled = false;
    searchPackages({
      query: debouncedSearch,
      limit: 15,
      installed: "all",
    })
      .then((response) => {
        if (cancelled || !isMountedRef.current) return;
        setSuggestions(response.results);
        setLoadingSuggestions(false);
      })
      .catch(() => {
        if (cancelled || !isMountedRef.current) return;
        setSuggestions([]);
        setLoadingSuggestions(false);
      });
    return () => { cancelled = true; };
  }, [debouncedSearch]);

  const onShowDetailsRef = useRef(onShowDetails);
  useEffect(() => {
    onShowDetailsRef.current = onShowDetails;
  });
  const handleNodeClick = useCallback((node: GraphNodeRef & Pick<DependencyNode, "id">) => {
    setSelectedId(node.id);
    onShowDetailsRef.current({ name: node.name, installed: node.installed, repository: node.repository });
  }, []);

  const handleNodeDoubleClick = useCallback((node: Pick<ForceGraphNode, "name">) => {
    setSearchInput(node.name);
    void fetchDependencyTree(node.name, depth, direction, optionalDepth);
  }, [depth, direction, optionalDepth, fetchDependencyTree]);

  const { svgRef, resetView, fitToContent, focusNode, keepNodeInView } = useForceGraph(nodes, edges, rootId, {
    width: graphWidth,
    height: GRAPH_HEIGHT,
    onNodeClick: handleNodeClick,
    onNodeDoubleClick: handleNodeDoubleClick,
    viewKey: graphViewKey,
    selectedId: shownId,
  });

  const listTree = useMemo(() => buildDependencyList(nodes, edges, rootId), [nodes, edges, rootId]);

  const listData = useMemo<TreeViewDataItem[]>(() => {
    const toItem = (item: ListNode): TreeViewDataItem => ({
      id: `dependency-list-${item.node.id}`,
      name: item.label,
      defaultExpanded: true,
      action: item.node.id === rootId ? undefined : (
        <Button
          variant="link"
          isInline
          tabIndex={-1}
          data-centre-on={item.node.name}
          onClick={() => {
            focusListAfterLoadRef.current = true;
            handleNodeDoubleClick(item.node);
          }}
        >
          Centre on {item.node.name}
        </Button>
      ),
      children: item.children.length > 0 ? item.children.map(toItem) : undefined,
    });
    return listTree ? [toItem(listTree)] : [];
  }, [listTree, rootId, handleNodeDoubleClick]);

  const listNodeById = useMemo(() => new Map(nodes.map((n) => [`dependency-list-${n.id}`, n])), [nodes]);

  const handleListSelect = (_event: React.MouseEvent, item: TreeViewDataItem) => {
    const node = item.id ? listNodeById.get(item.id) : undefined;
    if (!node) return;
    setListFocusId(node.id);
    handleNodeClick(node);
  };

  // Wait for ResizeObserver before panning around an inline details panel.
  const detailsInline = useDetailsInline();
  const pendingKeepRef = useRef<string | null>(null);
  const wasDetailsOpenRef = useRef(detailsOpen);
  useLayoutEffect(() => {
    if (wasDetailsOpenRef.current === detailsOpen) return;
    wasDetailsOpenRef.current = detailsOpen;
    if (!detailsOpen || !selectedId || !detailsInline || nodes.length === 0 || viewMode !== "graph") return;
    const measured = containerRef.current?.offsetWidth ?? 0;
    if (measured > 0 && measured !== graphWidth) {
      pendingKeepRef.current = selectedId;
    } else {
      keepNodeInView(selectedId);
    }
  }, [detailsOpen, selectedId, detailsInline, nodes.length, viewMode, graphWidth, keepNodeInView]);
  useEffect(() => {
    const id = pendingKeepRef.current;
    if (!id) return;
    pendingKeepRef.current = null;
    keepNodeInView(id);
  }, [graphWidth, keepNodeInView]);

  // PF TreeView has no aria-current prop and drops collapsed rows, so the mark is
  // reapplied after every list render and expansion.
  const [listExpansions, bumpListExpansions] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (viewMode !== "list") return;
    for (const li of listRef.current?.querySelectorAll("li[role=treeitem]") ?? []) {
      if (shownId && li.id === `dependency-list-${shownId}`) li.setAttribute("aria-current", "true");
      else li.removeAttribute("aria-current");
    }
  }, [shownId, viewMode, listData, listExpansions]);

  useEffect(() => {
    if (detailsOpen || viewMode !== "list" || !listFocusId) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const item = Array.from(listRef.current?.querySelectorAll("li") ?? []).find((li) => li.id === `dependency-list-${listFocusId}`);
    item?.querySelector<HTMLElement>(":scope > div .pf-v6-c-tree-view__node-text")?.focus();
  }, [detailsOpen, viewMode, listFocusId]);

  // Extend PF TreeView arrow navigation to the row action without adding a Tab stop.
  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const target = event.target as HTMLElement;
    const row = target.closest("li");
    if (!row) return;
    const text = row.querySelector<HTMLElement>(":scope > div .pf-v6-c-tree-view__node-text");
    const action = row.querySelector<HTMLElement>(":scope > div .pf-v6-c-tree-view__action button");
    if (event.key === "ArrowRight" && target === text && action) {
      action.focus();
    } else if (event.key === "ArrowLeft" && target === action && text) {
      text.focus();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    if (loading || !focusListAfterLoadRef.current || viewMode !== "list") return;
    focusListAfterLoadRef.current = false;
    listRef.current?.querySelector<HTMLElement>(".pf-v6-c-tree-view__node-text")?.focus();
  }, [loading, viewMode, listData]);

  const handleViewModeChange = (mode: GraphViewMode) => {
    setViewMode(mode);
    if (mode === "graph" && listFocusId) {
      focusNode(listFocusId);
    }
  };

  const handleSearch = () => {
    const query = sanitizeSearchInput(searchInput);
    if (!query) {
      setInputError("Please enter a package name");
      return;
    }
    setTypeaheadOpen(false);
    fetchDependencyTree(query, depth, direction, optionalDepth);
  };

  const handleSearchClear = () => {
    requestIdRef.current++;
    requestedPackageRef.current = null;
    loadingRef.current = false;
    shownGraphRef.current = "";
    setRefreshError(null);
    setLoading(false);
    setSearchInput("");
    setSuggestions([]);
    setNodes([]);
    setEdges([]);
    setRootId("");
    setInputError(null);
    setLoadError(null);
    setWarnings([]);
    setHasSearched(false);
    textInputRef.current?.focus();
  };

  const handleTypeaheadSelect = (
    _event: React.MouseEvent<Element, MouseEvent> | undefined,
    value: string | number | undefined
  ) => {
    if (typeof value === "string") {
      setSearchInput(value);
      setTypeaheadOpen(false);
      setSuggestions([]);
      fetchDependencyTree(value, depth, direction, optionalDepth);
    }
  };

  const handleDepthChange = (_event: SliderOnChangeEvent, value: number) => {
    setDepth(value);
    if (requestedPackageRef.current) {
      fetchDependencyTree(requestedPackageRef.current, value, direction, optionalDepth);
    }
  };

  const handleOptionalDepthChange = (_event: SliderOnChangeEvent, value: number) => {
    setOptionalDepth(value);
    if (requestedPackageRef.current) {
      fetchDependencyTree(requestedPackageRef.current, depth, direction, value);
    }
  };

  const handleDirectionChange = (newDirection: DependencyDirection) => {
    setDirection(newDirection);
    if (requestedPackageRef.current) {
      fetchDependencyTree(requestedPackageRef.current, depth, newDirection, optionalDepth);
    }
  };

  return (
    <>
      {inputError && (
        <Alert
          variant="danger"
          isInline
          title={inputError}
          className="pf-v6-u-mb-md"
        />
      )}
      {refreshError && !loadError && (
        <RefreshFailedAlert
          what="dependency graph"
          error={refreshError.message}
          details={refreshError.details}
          onRetry={() => { void refreshTree(); }}
          onClose={() => setRefreshError(null)}
        />
      )}
      {warnings.length > 0 && (
        <Alert
          variant="warning"
          title="Warnings"
          className="pf-v6-u-mb-md"
        >
          <ul style={{ margin: 0, paddingLeft: "1.5em" }}>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Card>
      <CardBody>
        <Toolbar>
          <ToolbarContent alignItems="center">
            <ToolbarItem style={{ flex: "1 1 300px", minWidth: 0 }}>
              <Select
                id="dependency-package-search"
                isOpen={typeaheadOpen && (suggestions.length > 0 || loadingSuggestions)}
                selected={searchInput}
                onSelect={handleTypeaheadSelect}
                onOpenChange={setTypeaheadOpen}
                toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                  <MenuToggle
                    ref={toggleRef}
                    variant="typeahead"
                    onClick={() => setTypeaheadOpen(!typeaheadOpen)}
                    isExpanded={typeaheadOpen}
                    isFullWidth
                  >
                    <TextInputGroup isPlain>
                      <TextInputGroupMain
                        value={searchInput}
                        onClick={() => suggestions.length > 0 && setTypeaheadOpen(true)}
                        onChange={(_event, value) => {
                          setSearchInput(value);
                          if (value.length >= 2 && !typeaheadOpen) {
                            setTypeaheadOpen(true);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleSearch();
                          }
                        }}
                        autoComplete="off"
                        innerRef={textInputRef}
                        placeholder="Search packages…"
                        role="combobox"
                        isExpanded={typeaheadOpen}
                        aria-controls="dependency-package-search"
                      />
                      {searchInput && (
                        <TextInputGroupUtilities>
                          <Button
                            variant="plain"
                            onClick={handleSearchClear}
                            aria-label="Clear input"
                          >
                            <TimesIcon />
                          </Button>
                        </TextInputGroupUtilities>
                      )}
                    </TextInputGroup>
                  </MenuToggle>
                )}
              >
                <SelectList>
                  {loadingSuggestions ? (
                    <SelectOption isDisabled>
                      <Spinner size="sm" /> Searching…
                    </SelectOption>
                  ) : (
                    suggestions.map((pkg) => (
                      <SelectOption key={pkg.name} value={pkg.name}>
                        <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} style={{ width: "100%" }}>
                          <FlexItem>
                            <span style={{ fontWeight: 500 }}>{pkg.name}</span>
                            {pkg.installed && (
                              <Label color="green" isCompact style={{ marginLeft: 8 }}>installed</Label>
                            )}
                          </FlexItem>
                          <FlexItem>
                            <span style={{ color: "var(--pf-t--global--text--color--subtle)", fontSize: "0.875rem" }}>
                              {pkg.repository}
                            </span>
                          </FlexItem>
                        </Flex>
                      </SelectOption>
                    ))
                  )}
                </SelectList>
              </Select>
            </ToolbarItem>
            <ToolbarToggleGroup ref={optionsToggleRef} toggleIcon={<FilterIcon />} breakpoint="md">
              <ToolbarItem>
                <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapMd" }}>
                  <span style={{ whiteSpace: "nowrap" }}>Depth</span>
                  <div style={{ width: "12rem", maxWidth: "100%", flexShrink: 0 }}>
                    <Slider
                      value={depth}
                      min={1}
                      max={5}
                      step={1}
                      onChange={handleDepthChange}
                      showBoundaries={false}
                      hasTooltipOverThumb
                      thumbAriaLabel="Depth"
                    />
                  </div>
                </Flex>
              </ToolbarItem>
              <ToolbarItem>
                <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapMd" }}>
                  <span style={{ whiteSpace: "nowrap" }}>Optional depth</span>
                  <div style={{ width: "12rem", maxWidth: "100%", flexShrink: 0 }}>
                    <Slider
                      value={optionalDepth}
                      min={0}
                      max={5}
                      step={1}
                      onChange={handleOptionalDepthChange}
                      showBoundaries={false}
                      hasTooltipOverThumb
                      thumbAriaLabel="Optional dependency depth"
                    />
                  </div>
                </Flex>
              </ToolbarItem>
              <ToolbarItem>
                <ToggleGroup aria-label="Direction">
                  <ToggleGroupItem
                    text="Forward"
                    isSelected={direction === "forward"}
                    onChange={() => handleDirectionChange("forward")}
                  />
                  <ToggleGroupItem
                    text="Reverse"
                    isSelected={direction === "reverse"}
                    onChange={() => handleDirectionChange("reverse")}
                  />
                  <ToggleGroupItem
                    text="Both"
                    isSelected={direction === "both"}
                    onChange={() => handleDirectionChange("both")}
                  />
                </ToggleGroup>
              </ToolbarItem>
            </ToolbarToggleGroup>
            <ToolbarItem>
              <ToggleGroup aria-label="View">
                <ToggleGroupItem
                  text="Graph"
                  isSelected={viewMode === "graph"}
                  onChange={() => handleViewModeChange("graph")}
                />
                <ToggleGroupItem
                  text="List"
                  isSelected={viewMode === "list"}
                  onChange={() => handleViewModeChange("list")}
                />
              </ToggleGroup>
            </ToolbarItem>
            {nodes.length > 0 && viewMode === "graph" && (
              <>
                <ToolbarItem>
                  <Button variant="secondary" icon={<ExpandIcon />} onClick={() => fitToContent()}>
                    Fit
                  </Button>
                </ToolbarItem>
                <ToolbarItem>
                  <Button variant="secondary" icon={<SyncAltIcon />} onClick={resetView}>
                    Reset View
                  </Button>
                </ToolbarItem>
              </>
            )}
          </ToolbarContent>
        </Toolbar>

        {loading ? (
          <div className="pf-v6-u-p-xl pf-v6-u-text-align-center">
            <Spinner /> Loading dependency tree…
          </div>
        ) : loadError ? (
          <LoadErrorState
            what={`dependencies of ${loadError.name}`}
            error={loadError.failure.message}
            code={loadError.failure.code}
            details={loadError.failure.details}
            onRetry={() => { void fetchDependencyTree(loadError.name, loadError.depth, loadError.direction, loadError.optionalDepth); }}
            headingLevel="h3"
          />
        ) : !hasSearched ? null : nodes.length === 0 ? (
          <EmptyState headingLevel="h3" titleText="Package not found" icon={TopologyIcon}>
            <EmptyStateBody>
              The package was not found in the local or sync databases.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <Flex gap={{ default: "gapMd" }}>
                    <FlexItem>
                      <Label color="blue">{nodes.length} nodes</Label>
                    </FlexItem>
                    <FlexItem>
                      <Label color="grey">{edges.length} edges</Label>
                    </FlexItem>
                  </Flex>
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
            {viewMode === "list" && (
              <div ref={listRef} onKeyDown={handleListKeyDown}>
                <TreeView
                  aria-label={`Dependencies of ${rootId}`}
                  data={listData}
                  hasSelectableNodes
                  hasGuides
                  onSelect={handleListSelect}
                  onExpand={bumpListExpansions}
                  activeItems={shownId ? [{ id: `dependency-list-${shownId}`, name: "" }] : []}
                />
                <p style={{ fontSize: "0.875rem", color: "var(--pf-t--global--text--color--subtle)", marginTop: "0.5rem" }}>
                  Arrow keys move between packages. Enter opens details. Right arrow reaches &quot;Centre on&quot; to explore from that package.
                </p>
              </div>
            )}
            <div hidden={viewMode !== "graph"}>
            <div
              ref={containerRef}
              style={{
                width: "100%",
                border: "1px solid var(--pf-t--global--border--color--default)",
                borderRadius: "var(--pf-t--global--border--radius--small)",
                overflow: "hidden",
                backgroundColor: "var(--pf-t--global--background--color--primary--default)",
              }}
            >
              <svg
                ref={svgRef}
                width={graphWidth}
                height={GRAPH_HEIGHT}
                style={{ display: "block" }}
                role="group"
                aria-label={`Dependency graph for ${rootId}, ${plural(nodes.length, "package")}`}
                aria-describedby="dependency-graph-help"
              />
            </div>
            <Legend />
            <p id="dependency-graph-help" style={{ fontSize: "0.875rem", color: "var(--pf-t--global--text--color--subtle)", marginTop: "0.5rem" }}>
              Drag nodes to reposition. Scroll to zoom. Click a node for details, including packages that are not installed. Double-click to re-center on that package.
              To explore with the keyboard, switch to List.
            </p>
            </div>
          </>
        )}
      </CardBody>
    </Card>
    </>
  );
};

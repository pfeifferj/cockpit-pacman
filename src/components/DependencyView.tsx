import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  Card,
  CardBody,
  Spinner,
  Alert,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarGroup,
  EmptyState,
  EmptyStateBody,
  Title,
  Button,
  Slider,
  SliderOnChangeEvent,
  ToggleGroup,
  ToggleGroupItem,
  Flex,
  FlexItem,
  Label,
} from "@patternfly/react-core";
import { TopologyIcon, SyncAltIcon } from "@patternfly/react-icons";
import {
  DependencyNode,
  DependencyEdge,
  DependencyDirection,
  getDependencyTree,
  getPackageInfo,
  PackageDetails,
} from "../api";
import { sanitizeSearchInput } from "../utils";
import { useForceGraph, ForceGraphNode } from "../hooks/useForceGraph";
import { PackageDetailsModal } from "./PackageDetailsModal";

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

export const DependencyView: React.FC = () => {
  const [nodes, setNodes] = useState<DependencyNode[]>([]);
  const [edges, setEdges] = useState<DependencyEdge[]>([]);
  const [rootId, setRootId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [depth, setDepth] = useState(3);
  const [direction, setDirection] = useState<DependencyDirection>("forward");
  const [selectedPackage, setSelectedPackage] = useState<PackageDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [graphWidth, setGraphWidth] = useState(800);
  const containerRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setGraphWidth(containerRef.current.offsetWidth);
      }
    };
    updateWidth();
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  const handleNodeClick = useCallback(async (node: ForceGraphNode) => {
    if (!node.installed) return;
    setDetailsLoading(true);
    try {
      const details = await getPackageInfo(node.name);
      if (!isMountedRef.current) return;
      setSelectedPackage(details);
    } catch (ex) {
      if (!isMountedRef.current) return;
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      if (isMountedRef.current) {
        setDetailsLoading(false);
      }
    }
  }, []);

  const handleNodeDoubleClick = useCallback((node: ForceGraphNode) => {
    setSearchInput(node.name);
    fetchDependencyTree(node.name, depth, direction);
  }, [depth, direction]);

  const { svgRef, resetView } = useForceGraph(nodes, edges, rootId, {
    width: graphWidth,
    height: GRAPH_HEIGHT,
    onNodeClick: handleNodeClick,
    onNodeDoubleClick: handleNodeDoubleClick,
  });

  const fetchDependencyTree = async (name: string, depthVal: number, dir: DependencyDirection) => {
    setLoading(true);
    setError(null);
    setWarnings([]);
    setHasSearched(true);
    try {
      const response = await getDependencyTree({ name, depth: depthVal, direction: dir });
      if (!isMountedRef.current) return;
      setNodes(response.nodes);
      setEdges(response.edges);
      setRootId(response.root);
      setWarnings(response.warnings);
      if (response.max_depth_reached) {
        setWarnings((prev) => [...prev, "Maximum depth reached. Some dependencies may not be shown."]);
      }
    } catch (ex) {
      if (!isMountedRef.current) return;
      setError(ex instanceof Error ? ex.message : String(ex));
      setNodes([]);
      setEdges([]);
      setRootId("");
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  };

  const handleSearch = () => {
    const query = sanitizeSearchInput(searchInput);
    if (!query) {
      setError("Please enter a package name");
      return;
    }
    fetchDependencyTree(query, depth, direction);
  };

  const handleSearchClear = () => {
    setSearchInput("");
    setNodes([]);
    setEdges([]);
    setRootId("");
    setError(null);
    setWarnings([]);
    setHasSearched(false);
  };

  const handleDepthChange = (_event: SliderOnChangeEvent, value: number) => {
    setDepth(value);
    if (rootId && rootId.length > 0) {
      fetchDependencyTree(rootId, value, direction);
    }
  };

  const handleDirectionChange = (newDirection: DependencyDirection) => {
    setDirection(newDirection);
    if (rootId && rootId.length > 0) {
      fetchDependencyTree(rootId, depth, newDirection);
    }
  };

  return (
    <Card>
      <CardBody>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                placeholder="Enter package name..."
                value={searchInput}
                onChange={(_event, value) => setSearchInput(value)}
                onClear={handleSearchClear}
                onSearch={handleSearch}
                aria-label="Package name"
              />
            </ToolbarItem>
            <ToolbarGroup>
              <ToolbarItem>
                <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
                  <span style={{ whiteSpace: "nowrap" }}>Depth: {depth}</span>
                  <div style={{ width: 150 }}>
                    <Slider
                      value={depth}
                      min={1}
                      max={5}
                      step={1}
                      onChange={handleDepthChange}
                      showTicks
                      aria-label="Depth"
                    />
                  </div>
                </Flex>
              </ToolbarItem>
            </ToolbarGroup>
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
            {nodes.length > 0 && (
              <ToolbarItem>
                <Button variant="secondary" icon={<SyncAltIcon />} onClick={resetView}>
                  Reset View
                </Button>
              </ToolbarItem>
            )}
          </ToolbarContent>
        </Toolbar>

        {error && (
          <Alert
            variant="danger"
            title="Failed to load dependencies"
            isInline
            className="pf-v6-u-mb-md"
          >
            {error}
          </Alert>
        )}

        {warnings.length > 0 && (
          <Alert
            variant="warning"
            title="Warnings"
            isInline
            className="pf-v6-u-mb-md"
          >
            <ul style={{ margin: 0, paddingLeft: "1.5em" }}>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Alert>
        )}

        {loading ? (
          <div className="pf-v6-u-p-xl pf-v6-u-text-align-center">
            <Spinner /> Loading dependency tree...
          </div>
        ) : !hasSearched ? (
          <EmptyState
            titleText={
              <Title headingLevel="h4" size="lg">
                Explore package dependencies
              </Title>
            }
            icon={TopologyIcon}
          >
            <EmptyStateBody>
              Enter a package name to visualize its dependency tree. You can adjust the depth
              and direction to explore dependencies (what it needs) or reverse dependencies
              (what needs it).
            </EmptyStateBody>
          </EmptyState>
        ) : nodes.length === 0 ? (
          <EmptyState
            titleText={
              <Title headingLevel="h4" size="lg">
                Package not found
              </Title>
            }
            icon={TopologyIcon}
          >
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
            <div
              ref={containerRef}
              style={{
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
              />
            </div>
            <Legend />
            <p style={{ fontSize: "0.875rem", color: "var(--pf-t--global--text--color--subtle)", marginTop: "0.5rem" }}>
              Drag nodes to reposition. Scroll to zoom. Click a node for details. Double-click to re-center on that package.
            </p>
          </>
        )}

        <PackageDetailsModal
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={() => setSelectedPackage(null)}
        />
      </CardBody>
    </Card>
  );
};

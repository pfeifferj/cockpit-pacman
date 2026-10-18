import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { PackageList } from "./PackageList";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import * as api from "../api";
import { mockSpawn } from "../test/setup";
import { createMockStreamingProcess, mockPackageDetails, mockSyncPackageDetails } from "../test/mocks";
import { useForceGraph, type ForceGraphNode } from "../hooks/useForceGraph";
import React from "react";
import { LockErrorBody } from "./LockErrorBody";
import { sweepA11y } from "../test/a11ySweep";

vi.mock("./LockErrorBody", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./LockErrorBody")>()),
  LockErrorBody: vi.fn(() => <div data-testid="lock-recovery" />),
}));

const completeUpgrade = () => {
  const proc = createMockStreamingProcess();
  mockSpawn.mockReturnValue(proc);
  api.runUpgrade({ onComplete: () => {}, onError: () => {} });
  proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
  proc._complete();
};

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listInstalled: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
    getDependencyTree: vi.fn(),
    setInstallReason: vi.fn(),
    previewRemove: vi.fn(),
    listIgnoredPackages: vi.fn(async () => ({ packages: [], total: 0 })),
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

const mockListInstalled = vi.mocked(api.listInstalled);
const mockGetPackageInfo = vi.mocked(api.getPackageInfo);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);
const mockGetDependencyTree = vi.mocked(api.getDependencyTree);
const mockSetInstallReason = vi.mocked(api.setInstallReason);
const mockPreviewRemove = vi.mocked(api.previewRemove);
const mockUseForceGraph = vi.mocked(useForceGraph);

const mockPackageListResponse: api.PackageListResponse = {
  packages: [
    {
      name: "linux",
      version: "6.7.0-arch1-1",
      description: "The Linux kernel and modules",
      installed_size: 142000000,
      install_date: 1704067200,
      reason: "explicit",
      repository: "core",
    },
    {
      name: "glibc",
      version: "2.39-1",
      description: "GNU C Library",
      installed_size: 45000000,
      install_date: 1704067200,
      reason: "dependency",
      repository: "core",
    },
  ],
  total: 2,
  total_explicit: 1,
  total_dependency: 1,
  repositories: ["core", "extra"],
  warnings: [],
};

describe("PackageList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInstalled.mockResolvedValue(mockPackageListResponse);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders loading spinner initially", async () => {
    mockListInstalled.mockImplementation(() => new Promise(() => {}));
    render(<PackageList />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("renders packages after loading", async () => {
    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    expect(screen.getByText("glibc")).toBeInTheDocument();
    expect(screen.getByText("6.7.0-arch1-1")).toBeInTheDocument();
    expect(screen.getByText("2.39-1")).toBeInTheDocument();
  });

  it("displays error message on API failure", async () => {
    mockListInstalled.mockRejectedValue(new api.BackendError("Cannot read installed packages", "internal_error", "The local database has an invalid entry"));

    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText("Cannot read installed packages")).toBeInTheDocument();
    });
    expect(screen.getByText("The local database has an invalid entry")).toBeInTheDocument();
  });

  it("shows refresh diagnostics while retaining the loaded packages", async () => {
    render(<PackageList />);
    await screen.findByText("linux");
    mockListInstalled.mockRejectedValueOnce(new api.BackendError("Cannot read installed packages", "internal_error", "The local database is unavailable"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Explicit/i })); });
    expect(screen.getByText("The local database is unavailable")).toBeInTheDocument();
    expect(screen.getByText("linux")).toBeInTheDocument();
  });

  it("passes package lookup diagnostics into the details modal", async () => {
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("Cannot read package", "internal_error", "The package metadata is damaged"));
    render(<PackageList />);
    fireEvent.click(await screen.findByText("linux"));
    expect(await screen.findByText("The package metadata is damaged")).toBeInTheDocument();
    expect(screen.getByText("Could not load package details")).toBeInTheDocument();
  });

  it("shows package count badges", async () => {
    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    const allBadges = screen.getAllByText("2");
    expect(allBadges.length).toBeGreaterThan(0);
  });

  it("filters by explicit packages when clicking filter", async () => {
    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    const explicitButton = screen.getByRole("button", { name: /Explicit/i });
    await act(async () => {
      fireEvent.click(explicitButton);
    });

    await waitFor(() => {
      expect(mockListInstalled).toHaveBeenCalledWith(
        expect.objectContaining({ filter: "explicit" })
      );
    });
  });

  it("explains the filters through one named help button that does not change the filter", async () => {
    render(<PackageList />);
    await screen.findByText("linux");
    sweepA11y();
    const help = screen.getAllByRole("button", { name: /^More information about/ });
    expect(help).toHaveLength(1);
    mockListInstalled.mockClear();
    await act(async () => {
      fireEvent.click(help[0]);
    });
    expect(await screen.findByText(/installed automatically to satisfy/)).toBeInTheDocument();
    expect(screen.getByText("pacman -D --asexplicit")).toBeInTheDocument();
    const explicitHelp = screen.getByText(/later marked explicit/);
    expect(explicitHelp).toHaveTextContent('"Mark package as explicitly installed" in their row\'s actions menu or their details');
    expect(mockListInstalled).not.toHaveBeenCalled();
  });

  it("announces the count after a filter change but not on first load", async () => {
    render(<AnnouncerProvider><PackageList /></AnnouncerProvider>);
    await screen.findByText("linux");
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent("");

    mockListInstalled.mockResolvedValue({ ...mockPackageListResponse, packages: mockPackageListResponse.packages.slice(0, 1), total: 1 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Explicit/ }));
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 package"));
  });

  it("groups thousands in the announced count", async () => {
    render(<AnnouncerProvider><PackageList /></AnnouncerProvider>);
    await screen.findByText("linux");
    mockListInstalled.mockResolvedValue({ ...mockPackageListResponse, total: 1000 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Explicit/ }));
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1,000 packages"));
  });

  it("calls API with correct pagination params", async () => {
    mockListInstalled.mockResolvedValue({
      ...mockPackageListResponse,
      total: 100,
    });

    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    expect(mockListInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, limit: 50 })
    );
  });

  it("calls getPackageInfo when clicking a package name", async () => {
    const mockDetails: api.PackageDetails = {
      name: "linux",
      version: "6.7.0-arch1-1",
      description: "The Linux kernel and modules",
      url: "https://kernel.org/",
      licenses: ["GPL-2.0-only"],
      groups: [],
      provides: [],
      depends: ["coreutils"],
      optdepends: [],
      conflicts: [],
      replaces: [],
      required_by: [],
      optional_for: [],
      installed_size: 142000000,
      packager: "heftig",
      architecture: "x86_64",
      build_date: 1704067200,
      install_date: 1704067200,
      reason: "explicit",
      validation: ["pgp"],
      repository: "core",
      update_stats: null,
    };
    mockGetPackageInfo.mockResolvedValue(mockDetails);

    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    const linuxCell = screen.getByText("linux");
    await act(async () => {
      fireEvent.click(linuxCell);
    });

    await waitFor(() => {
      expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    });
  });

  it("renders table with correct headers", async () => {
    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
  });

  it("displays install reason labels", async () => {
    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    expect(screen.getByText("explicit")).toBeInTheDocument();
    expect(screen.getByText("dependency")).toBeInTheDocument();
  });

  describe("narrow toolbar", () => {
    const filtersToggle = () => screen.getByRole("button", { name: "Show filters" });
    const toggleGroup = () => filtersToggle().closest(".pf-m-toggle-group") as HTMLElement;

    it("puts the filters, not the search field, in a named toggle group", async () => {
      render(<PackageList />);
      await screen.findByText("linux");

      const group = toggleGroup();
      expect(within(group).getByRole("group", { name: "Package filter" })).toBeInTheDocument();
      expect(within(group).getByRole("button", { name: "Filter by repository" })).toBeInTheDocument();
      expect(within(group).queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Search installed packages" })).toBeInTheDocument();

      fireEvent.click(filtersToggle());
      expect(filtersToggle()).toHaveAttribute("aria-expanded", "true");
      const expanded = document.getElementById(filtersToggle().getAttribute("aria-controls")!)!;
      expect(within(expanded).getByRole("group", { name: "Package filter" })).toBeInTheDocument();
    });

    it("shows active filters as chips that clear the filter and return focus to the search field", async () => {
      render(<PackageList />);
      await screen.findByText("linux");
      expect(screen.queryByRole("list", { name: "Show" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /^Explicit/ }));
      fireEvent.click(screen.getByRole("button", { name: "Filter by repository" }));
      fireEvent.click(await screen.findByRole("option", { name: "extra" }));

      const shown = await screen.findByRole("list", { name: "Show" });
      expect(within(shown).getByText("Explicit")).toBeInTheDocument();
      expect(within(screen.getByRole("list", { name: "Repository" })).getByText("extra")).toBeInTheDocument();

      fireEvent.click(within(shown).getByRole("button", { name: "Close Explicit" }));
      await waitFor(() => expect(screen.queryByRole("list", { name: "Show" })).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("list", { name: "Repository" })).toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search installed packages" }));

      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      await waitFor(() => expect(screen.queryByRole("list", { name: "Repository" })).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Filter by repository" })).toHaveTextContent("All repositories");
    });

    it("shows Graph as a view without a redundant filter chip", async () => {
      mockGetDependencyTree.mockResolvedValue({ nodes: [], edges: [], root: "", max_depth_reached: false, warnings: [] });
      render(<PackageList />);
      await screen.findByText("linux");

      fireEvent.click(screen.getByRole("button", { name: /Graph/ }));
      expect(within(screen.getByRole("group", { name: "Package filter" })).getByRole("button", { name: /Graph/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("list", { name: "Show" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /^All/ }));
      expect(await screen.findByRole("textbox", { name: "Search installed packages" })).toBeInTheDocument();
    });
  });

  describe("zero-result next actions", () => {
    const emptyResponse: api.PackageListResponse = {
      ...mockPackageListResponse,
      packages: [],
      total: 0,
    };

    it("shows an example query in the placeholder", async () => {
      render(<PackageList />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText(/e\.g\./)).toBeInTheDocument();
    });

    it("resets search, reason and repository to the initial request", async () => {
      const onSearchRepositories = vi.fn();
      render(<PackageList onSearchRepositories={onSearchRepositories} />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      const initialArgs = mockListInstalled.mock.calls[0][0];

      mockListInstalled.mockResolvedValue(emptyResponse);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Explicit/ }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Filter by repository" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: "extra" }));
      });
      const input = screen.getByPlaceholderText(/Search installed packages/);
      await act(async () => {
        fireEvent.change(input, { target: { value: "zzz" } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Search" }));
      });

      await screen.findByText("No installed packages match");
      expect(screen.getByRole("button", { name: "Search the repositories for zzz" })).toBeInTheDocument();

      mockListInstalled.mockResolvedValue(mockPackageListResponse);
      mockListInstalled.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
      });

      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      expect(mockListInstalled).toHaveBeenLastCalledWith(initialArgs);
      expect(input).toHaveValue("");
      expect(document.activeElement).toBe(input);
    });

    it("hands the query to the repository search", async () => {
      mockListInstalled.mockResolvedValue(emptyResponse);
      const onSearchRepositories = vi.fn();
      render(<PackageList onSearchRepositories={onSearchRepositories} routeOptions={{ q: "neovim" }} />);

      const button = await screen.findByRole("button", { name: "Search the repositories for neovim" });
      await act(async () => {
        fireEvent.click(button);
      });

      expect(onSearchRepositories).toHaveBeenCalledWith("neovim");
      expect(mockListInstalled).toHaveBeenLastCalledWith(expect.objectContaining({ search: "neovim" }));
    });

    it("does not offer a reset when nothing narrows the list", async () => {
      mockListInstalled.mockResolvedValue(emptyResponse);
      render(<PackageList />);

      await screen.findByText("No installed packages");
      expect(screen.queryByRole("button", { name: "Clear search and filters" })).not.toBeInTheDocument();
    });
  });

  describe("fresh data", () => {
    it("keeps the filter and page across a system change without the full spinner", async () => {
      mockListInstalled.mockResolvedValue({ ...mockPackageListResponse, total: 120 });
      render(<PackageList />);
      await screen.findByText("linux");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Explicit/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: /next page/i })[0]);
      });
      await waitFor(() => {
        expect(mockListInstalled).toHaveBeenLastCalledWith(
          expect.objectContaining({ filter: "explicit", offset: 50 }),
        );
      });
      await screen.findByText("linux");

      let resolve: (value: api.PackageListResponse) => void = () => {};
      mockListInstalled.mockClear();
      mockListInstalled.mockImplementation(() => new Promise((r) => { resolve = r; }));
      await act(async () => {
        completeUpgrade();
      });

      expect(mockListInstalled).toHaveBeenCalledTimes(1);
      expect(mockListInstalled).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: "explicit", offset: 50 }),
      );
      expect(screen.getByText("linux")).toBeInTheDocument();
      expect(screen.queryByText("Loading packages")).not.toBeInTheDocument();

      await act(async () => {
        resolve({ ...mockPackageListResponse, total: 120 });
      });
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    it("offers Try again on a load error and re-spawns the list", async () => {
      mockListInstalled.mockRejectedValueOnce(new Error("backend exploded"));
      render(<PackageList />);
      await screen.findByText(/backend exploded/);
      expect(screen.getByRole("heading", { name: /Could not load installed packages/ })).toBeInTheDocument();

      mockListInstalled.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });

      expect(mockListInstalled).toHaveBeenCalledTimes(1);
      await screen.findByText("linux");
    });

    it("renders lock recovery for a locked database", async () => {
      mockListInstalled.mockRejectedValueOnce(new api.BackendError("unable to lock database", "database_locked"));
      render(<PackageList />);

      expect(await screen.findByTestId("lock-recovery")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Could not load installed packages/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      const calls = vi.mocked(LockErrorBody).mock.calls;
      const props = calls[calls.length - 1][0];
      expect(props.retryKey).toBeDefined();
      act(() => props.onStateChange?.("stopped"));
      mockListInstalled.mockResolvedValueOnce(mockPackageListResponse);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(mockListInstalled).toHaveBeenCalledTimes(2));
    });
  });

  describe("route options", () => {
    beforeEach(() => {
      mockListInstalled.mockResolvedValue(mockPackageListResponse);
    });

    it("opens with the routed query", async () => {
      render(<PackageList routeOptions={{ q: "linux" }} />);
      await waitFor(() =>
        expect(mockListInstalled).toHaveBeenCalledWith(expect.objectContaining({ search: "linux" })),
      );
      expect(screen.getByRole("textbox", { name: "Search installed packages" })).toHaveValue("linux");
    });

    it("falls back to all packages on an invalid filter and rewrites it", async () => {
      const onRouteChange = vi.fn();
      render(<PackageList routeOptions={{ filter: "bogus" }} onRouteChange={onRouteChange} />);
      await waitFor(() =>
        expect(mockListInstalled).toHaveBeenCalledWith(expect.objectContaining({ filter: "all" })),
      );
      expect(onRouteChange).toHaveBeenCalledWith({});
    });

    it("writes a filter change back to the route", async () => {
      const onRouteChange = vi.fn();
      const { rerender } = render(<PackageList routeOptions={{}} onRouteChange={onRouteChange} />);
      await screen.findByText("linux");
      fireEvent.click(screen.getByRole("button", { name: /Explicit/ }));
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ filter: "explicit" }));

      rerender(<PackageList routeOptions={{ filter: "explicit" }} onRouteChange={onRouteChange} />);
      await waitFor(() =>
        expect(mockListInstalled).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "explicit" })),
      );
      expect(onRouteChange).toHaveBeenCalledTimes(1);
    });

    it("applies a carried query and focuses the search field", async () => {
      const { rerender } = render(<PackageList routeOptions={{}} />);
      await screen.findByText("linux");
      rerender(<PackageList routeOptions={{ q: "glibc" }} />);
      const input = screen.getByRole("textbox", { name: "Search installed packages" });
      await waitFor(() => expect(input).toHaveValue("glibc"));
      expect(input).toHaveFocus();
      await waitFor(() =>
        expect(mockListInstalled).toHaveBeenLastCalledWith(expect.objectContaining({ search: "glibc" })),
      );
    });

    it("leaves the view alone while the tab is not routed", async () => {
      const onRouteChange = vi.fn();
      const { rerender } = render(<PackageList routeOptions={{ q: "linux" }} onRouteChange={onRouteChange} />);
      await screen.findByText("linux");
      rerender(<PackageList routeOptions={undefined} onRouteChange={onRouteChange} />);
      expect(screen.getByRole("textbox", { name: "Search installed packages" })).toHaveValue("linux");
      expect(onRouteChange).not.toHaveBeenCalled();
    });

    it("opens details for pkg and drops pkg when closed", async () => {
      mockGetPackageInfo.mockResolvedValue({ ...mockPackageDetails, name: "bash" });
      const onRouteChange = vi.fn();
      render(<PackageList routeOptions={{ pkg: "bash" }} onRouteChange={onRouteChange} />);
      await waitFor(() => expect(mockGetPackageInfo).toHaveBeenCalledWith("bash"));
      const panel = await screen.findByRole("region", { name: /^bash/ });
      fireEvent.click(within(panel).getByRole("button", { name: "Close package details" }));
      await waitFor(() => expect(onRouteChange).toHaveBeenCalledWith({}));
    });
  });

  describe("details drawer", () => {
    const nameButton = (name: string) =>
      within(screen.getByRole("grid", { name: "Installed packages" })).getByRole("button", { name });

    beforeEach(() => {
      mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
    });

    it("replaces the panel in place, keeps the list and returns focus to the invoking row", async () => {
      render(<PackageList />);
      await screen.findByText("glibc");
      fireEvent.click(screen.getByRole("button", { name: /Dependencies/ }));
      await waitFor(() => expect(mockListInstalled).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "dependency" })));
      const listCalls = mockListInstalled.mock.calls.length;

      fireEvent.click(nameButton("linux"));
      expect(await screen.findByRole("region", { name: /^linux/ })).toBeInTheDocument();
      nameButton("glibc").focus();
      fireEvent.click(nameButton("glibc"));
      const panel = await screen.findByRole("region", { name: /^glibc/ });

      expect(screen.queryByRole("region", { name: /^linux/ })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Close package details" })).toHaveLength(1);
      expect(screen.queryAllByRole("dialog")).toHaveLength(0);
      expect(nameButton("glibc").closest("tr")).toHaveAttribute("aria-current", "true");
      expect(nameButton("linux").closest("tr")).not.toHaveAttribute("aria-current");
      sweepA11y();

      const close = within(panel).getByRole("button", { name: "Close package details" });
      close.focus();
      fireEvent.click(close);
      await waitFor(() => expect(screen.queryByRole("region", { name: /^glibc/ })).not.toBeInTheDocument());
      expect(document.activeElement).toBe(nameButton("glibc"));
      expect(screen.getByRole("button", { name: /^Dependencies/ })).toHaveAttribute("aria-pressed", "true");
      expect(mockListInstalled.mock.calls.length).toBe(listCalls);
    });

    it("moves focus into the panel on open and closes on Escape", async () => {
      render(<PackageList />);
      await screen.findByText("linux");
      nameButton("linux").focus();
      fireEvent.click(nameButton("linux"));
      const panel = await screen.findByRole("region", { name: /^linux/ });
      await waitFor(() => expect(within(panel).getByRole("heading", { level: 2 })).toHaveFocus());

      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("region", { name: /^linux/ })).not.toBeInTheDocument());
      expect(document.activeElement).toBe(nameButton("linux"));
    });

    const openLinux = async () => {
      await screen.findByText("linux");
      nameButton("linux").focus();
      fireEvent.click(nameButton("linux"));
      return screen.findByRole("region", { name: /^linux/ });
    };

    it("does not re-read the package when its open row is clicked again", async () => {
      render(<PackageList />);
      await openLinux();
      fireEvent.click(nameButton("linux"));
      await act(async () => {});
      expect(mockGetPackageInfo).toHaveBeenCalledTimes(1);
    });

    it("keeps the previous details busy during a row switch and shows the spinner only after a second", async () => {
      render(<PackageList />);
      const panel = await openLinux();
      await within(panel).findByRole("button", { name: "Actions" });
      let resolve!: (details: api.PackageDetails) => void;
      mockGetPackageInfo.mockReturnValueOnce(new Promise((r) => { resolve = r; }));

      fireEvent.click(nameButton("glibc"));
      const busy = screen.getByRole("region", { name: /^linux/ });
      expect(busy).toHaveAttribute("aria-busy", "true");
      expect(within(busy).queryByRole("progressbar", { name: "Contents" })).not.toBeInTheDocument();
      expect(within(busy).getByText("Description")).toBeInTheDocument();
      expect(await within(busy).findByRole("progressbar", { name: "Contents" }, { timeout: 2000 })).toBeInTheDocument();

      await act(async () => resolve({ ...mockPackageDetails, name: "glibc" }));
      const replaced = await screen.findByRole("region", { name: /^glibc/ });
      expect(replaced).not.toHaveAttribute("aria-busy");
    });

    it("puts the actions above the body sections", async () => {
      render(<PackageList />);
      const panel = await openLinux();
      const actions = await within(panel).findByRole("button", { name: "Actions" });
      const description = within(panel).getByText("Description");
      expect(actions.compareDocumentPosition(description) & document.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("marks the open row with aria-current and an outline instead of row selection", async () => {
      render(<PackageList />);
      await openLinux();
      const row = nameButton("linux").closest("tr")!;
      expect(row).toHaveAttribute("aria-current", "true");
      expect(row.style.outline).not.toBe("");
      expect(row).not.toHaveClass("pf-m-selected");
      expect(nameButton("glibc").closest("tr")!.style.outline).toBe("");
    });

    it("closes on Escape from a row but not from the search field", async () => {
      render(<PackageList />);
      await openLinux();
      const input = screen.getByRole("textbox", { name: "Search installed packages" });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.getByRole("region", { name: /^linux/ })).toBeInTheDocument();

      nameButton("glibc").focus();
      fireEvent.keyDown(nameButton("glibc"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("region", { name: /^linux/ })).not.toBeInTheDocument());
    });

    it("moves through rows with the arrow keys and announces the replaced details", async () => {
      render(<AnnouncerProvider><PackageList /></AnnouncerProvider>);
      await openLinux();
      nameButton("linux").focus();

      fireEvent.keyDown(nameButton("linux"), { key: "ArrowDown" });
      expect(nameButton("glibc")).toHaveFocus();
      await screen.findByRole("region", { name: /^glibc/ });
      expect(nameButton("glibc").closest("tr")).toHaveAttribute("aria-current", "true");
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Details: glibc"));

      fireEvent.keyDown(nameButton("glibc"), { key: "ArrowDown" });
      expect(nameButton("glibc")).toHaveFocus();
      fireEvent.keyDown(nameButton("glibc"), { key: "ArrowUp" });
      expect(nameButton("linux")).toHaveFocus();
      await screen.findByRole("region", { name: /^linux/ });
    });

    it("focuses the inline panel title without scrolling the page", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      try {
        render(<PackageList />);
        const panel = await openLinux();
        const title = within(panel).getByRole("heading", { level: 2 });
        await waitFor(() => expect(title).toHaveFocus());
        expect(focus.mock.contexts.indexOf(title)).toBeGreaterThanOrEqual(0);
        expect(focus.mock.calls[focus.mock.contexts.indexOf(title)][0]).toEqual({ preventScroll: true });
      } finally {
        focus.mockRestore();
      }
    });

    it("re-reads the open package after a system change, keeping it shown until the reply", async () => {
      render(<PackageList />);
      const panel = await openLinux();
      await within(panel).findByText("Description");
      let resolve!: (details: api.PackageDetails) => void;
      mockGetPackageInfo.mockReturnValueOnce(new Promise((r) => { resolve = r; }));

      await act(async () => completeUpgrade());
      await waitFor(() => expect(mockGetPackageInfo).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("region", { name: /^linux/ })).not.toHaveAttribute("aria-busy");
      expect(within(panel).getByText("Description")).toBeInTheDocument();

      await act(async () => resolve({ ...mockPackageDetails, name: "linux", version: "9.9-1" }));
      expect(await within(screen.getByRole("region", { name: /^linux/ })).findByText("9.9-1")).toBeInTheDocument();
    });

    it("says when the open package was removed outside this page and closes from there", async () => {
      render(<PackageList />);
      const panel = await openLinux();
      await within(panel).findByText("Description");
      mockGetPackageInfo.mockRejectedValueOnce(new api.BackendError("Package 'linux' not found", "not_found"));

      await act(async () => completeUpgrade());
      const gone = await screen.findByRole("heading", { name: "linux was removed outside this page" });
      const region = gone.closest<HTMLElement>('[role="region"]')!;
      fireEvent.click(within(region).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByText("linux was removed outside this page")).not.toBeInTheDocument());
    });

    it("is inline at wide widths and an overlay at narrow widths", async () => {
      const original = window.matchMedia;
      try {
        for (const wide of [true, false]) {
          window.matchMedia = vi.fn().mockReturnValue({
            matches: wide,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          }) as unknown as typeof window.matchMedia;
          const { container, unmount } = render(<PackageList />);
          await screen.findByText("linux");
          fireEvent.click(nameButton("linux"));
          const panel = await screen.findByRole(wide ? "region" : "dialog", { name: /^linux/ });
          const drawer = container.querySelector(".pf-v6-c-drawer");
          expect(drawer).toHaveClass("pf-m-expanded");
          if (wide) {
            expect(drawer).toHaveClass("pf-m-inline");
            expect(panel).toHaveStyle({ position: "sticky", top: "0px" });
            expect(screen.queryAllByRole("dialog")).toHaveLength(0);
          } else {
            expect(drawer).not.toHaveClass("pf-m-inline");
            expect(panel).toHaveAttribute("aria-modal", "true");
            expect(panel).not.toHaveStyle({ position: "sticky" });
          }
          unmount();
        }
      } finally {
        window.matchMedia = original;
      }
    });
  });
  describe("dependency graph details", () => {
    const tree: api.DependencyTreeResponse = {
      nodes: [
        { id: "linux", name: "linux", version: "6.7.0-arch1-1", depth: 0, installed: true, reason: "explicit", repository: "core" },
        { id: "tool", name: "tool", version: "1-1", depth: 1, installed: false, reason: null, repository: "extra" },
      ],
      edges: [{ source: "linux", target: "tool", edge_type: "optdepends" }],
      root: "linux",
      max_depth_reached: false,
      warnings: [],
    };
    const clickNode = (node: Pick<ForceGraphNode, "name" | "installed" | "repository">) => {
      const options = mockUseForceGraph.mock.calls[mockUseForceGraph.mock.calls.length - 1][3];
      act(() => options.onNodeClick!({ id: node.name, version: "1-1", depth: 1, reason: null, ...node }));
    };

    beforeEach(() => {
      mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
      mockGetDependencyTree.mockResolvedValue(tree);
    });

    const openGraphFor = async (name: string) => {
      const panel = await screen.findByRole("region", { name: new RegExp(`^${name}`) });
      fireEvent.click(within(panel).getByRole("button", { name: `View ${name} dependencies` }));
    };

    it("opens Graph for the selected row, replacing the previous graph while details load", async () => {
      const onRouteChange = vi.fn();
      render(<PackageList routeOptions={{}} onRouteChange={onRouteChange} />);
      const filters = screen.getByRole("group", { name: "Package filter" });
      fireEvent.click(await screen.findByRole("button", { name: "linux" }));
      await screen.findByRole("region", { name: /^linux/ });
      fireEvent.click(within(filters).getByRole("button", { name: "Graph" }));
      await waitFor(() => expect(mockGetDependencyTree).toHaveBeenLastCalledWith(expect.objectContaining({ name: "linux" })));
      expect(screen.getByRole("combobox")).toHaveValue("linux");
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ graph: "linux", pkg: "linux" }));

      fireEvent.click(within(filters).getByRole("button", { name: /^All/ }));
      const list = await screen.findByRole("grid", { name: "Installed packages" });
      mockGetPackageInfo.mockImplementationOnce(() => new Promise(() => {}));
      fireEvent.click(within(list).getByRole("button", { name: "glibc" }));
      fireEvent.click(within(filters).getByRole("button", { name: "Graph" }));
      await waitFor(() => expect(mockGetDependencyTree).toHaveBeenLastCalledWith(expect.objectContaining({ name: "glibc" })));
      expect(screen.getByRole("combobox")).toHaveValue("glibc");
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ graph: "glibc", pkg: "glibc" }));
    });

    it("re-centres when View dependencies repeats the package already shown", async () => {
      render(<PackageList />);
      await screen.findByText("linux");
      fireEvent.click(within(screen.getByRole("grid", { name: "Installed packages" })).getByRole("button", { name: "linux" }));
      await openGraphFor("linux");
      await waitFor(() => expect(mockGetDependencyTree).toHaveBeenCalledTimes(1));
      await screen.findByText("2 nodes");

      clickNode({ name: "linux", installed: true, repository: "core" });
      await openGraphFor("linux");
      await waitFor(() => expect(mockGetDependencyTree).toHaveBeenCalledTimes(2));
      expect(mockGetDependencyTree.mock.calls.map(([req]) => req.name)).toEqual(["linux", "linux"]);
    });

    it("opens a not-installed node's sync details with Install beside the graph", async () => {
      mockGetSyncPackageInfo.mockResolvedValue({ ...mockSyncPackageDetails, name: "tool", repository: "extra" });
      render(<PackageList routeOptions={{ graph: "linux" }} />);
      await screen.findByText("2 nodes");

      clickNode({ name: "tool", installed: false, repository: "extra" });
      const panel = await screen.findByRole("region", { name: /^tool/ });
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("tool", "extra");
      expect(mockGetPackageInfo).not.toHaveBeenCalled();
      expect(within(panel).getByRole("button", { name: "Install tool" })).toBeInTheDocument();
      expect(screen.queryAllByRole("dialog")).toHaveLength(0);
      sweepA11y();

      clickNode({ name: "linux", installed: true, repository: "core" });
      await screen.findByRole("region", { name: /^linux/ });
      expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    });

    it("says when a node is in no configured repository", async () => {
      mockGetSyncPackageInfo.mockRejectedValue(new api.BackendError("Package 'ghost' not found in any sync database", "not_found"));
      render(<PackageList routeOptions={{ graph: "linux" }} />);
      await screen.findByText("2 nodes");

      clickNode({ name: "ghost", installed: false, repository: null });
      expect(await screen.findByText("ghost is not in any configured repository")).toBeInTheDocument();
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("ghost", undefined);
    });
  });

  describe("row actions", () => {
    it("puts a named kebab on every row that opens without opening details", async () => {
      render(<PackageList />);
      const table = await screen.findByRole("grid", { name: "Installed packages" });
      await within(table).findByText("linux");
      for (const name of ["linux", "glibc"]) {
        expect(within(table).getByRole("button", { name: `Actions for ${name}` })).toBeInTheDocument();
      }
      fireEvent.click(within(table).getByRole("button", { name: "Actions for linux" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Remove linux" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Close package details" })).not.toBeInTheDocument();
    });

    it("shows the row's dependency graph from its kebab", async () => {
      mockGetDependencyTree.mockResolvedValue({ nodes: [], edges: [], root: "glibc", max_depth_reached: false, warnings: [] });
      render(<PackageList />);
      await screen.findByText("glibc");
      fireEvent.click(screen.getByRole("button", { name: "Actions for glibc" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "View glibc dependencies" }));
      await waitFor(() => expect(mockGetDependencyTree).toHaveBeenCalled());
      expect(mockGetDependencyTree.mock.calls[0][0].name).toBe("glibc");
      expect(screen.queryByRole("button", { name: "Close package details" })).not.toBeInTheDocument();
    });

    it("reloads the list after Mark and after its Undo, so the Reason column follows", async () => {
      mockSetInstallReason
        .mockResolvedValueOnce({ success: true, name: "glibc", reason: "explicit", previous: "dependency" })
        .mockResolvedValueOnce({ success: true, name: "glibc", reason: "dependency", previous: "explicit" });
      act(() => completeUpgrade());
      render(<PackageList />);
      const table = await screen.findByRole("grid", { name: "Installed packages" });
      await within(table).findByText("glibc");
      const reasonCell = () => within(within(table).getByText("glibc").closest("tr")!).getByText(/^(explicit|dependency)$/);
      expect(reasonCell()).toHaveTextContent("dependency");
      const explicitGlibc = mockPackageListResponse.packages.map(p => (p.name === "glibc" ? { ...p, reason: "explicit" } : p));
      mockListInstalled.mockResolvedValue({ ...mockPackageListResponse, packages: explicitGlibc, total_explicit: 2, total_dependency: 0 });
      const loads = mockListInstalled.mock.calls.length;

      fireEvent.click(within(table).getByRole("button", { name: "Actions for glibc" }));
      await act(async () => {
        fireEvent.click(await screen.findByRole("menuitem", { name: "Mark glibc as explicitly installed" }));
      });
      expect(mockSetInstallReason).toHaveBeenCalledWith("glibc", "explicit");
      await waitFor(() => expect(reasonCell()).toHaveTextContent("explicit"));
      expect(mockListInstalled.mock.calls.length).toBe(loads + 1);

      mockListInstalled.mockResolvedValue(mockPackageListResponse);
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
      });
      await waitFor(() => expect(reasonCell()).toHaveTextContent("dependency"));
      expect(mockListInstalled.mock.calls.length).toBe(loads + 2);
    });

    describe("focus after a kebab Remove takes the row out of the list", () => {
      const bash = { ...mockPackageListResponse.packages[1], name: "bash", version: "5.2-1" };
      const three = { ...mockPackageListResponse, packages: [...mockPackageListResponse.packages, bash], total: 3 };
      const withoutGlibc = { ...three, packages: three.packages.filter((p) => p.name !== "glibc"), total: 2 };

      const removeGlibc = async () => {
        mockListInstalled.mockResolvedValue(three);
        mockPreviewRemove.mockResolvedValue({
          success: true, add: [], conflicts: [], replacements: [], providers: [], import_keys: [], warnings: [], blocked_by: [],
          remove: [{ name: "glibc", version: "2.39-1", installed_size: 45000000, reason: "target" }],
          total_download_size: 0, net_installed_size: -45000000,
        } as api.TransactionPreview);
        act(() => completeUpgrade());
        render(<PackageList />, { wrapper: AnnouncerProvider });
        const table = await screen.findByRole("grid", { name: "Installed packages" });
        await within(table).findByText("bash");
        const toggle = within(table).getByRole("button", { name: "Actions for glibc" });
        toggle.focus();
        fireEvent.click(toggle);
        fireEvent.click(await screen.findByRole("menuitem", { name: "Remove glibc" }));
        const dialog = await screen.findByRole("dialog", { name: "Remove glibc" });
        const proc = createMockStreamingProcess();
        mockSpawn.mockReturnValue(proc);
        fireEvent.click(await within(dialog).findByRole("button", { name: "Remove glibc" }));
        return { table, dialog, proc };
      };

      const finish = (proc: ReturnType<typeof createMockStreamingProcess>) =>
        act(async () => {
          proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
          proc._complete();
        });

      const closeButton = (dialog: HTMLElement) => {
        const footer = within(dialog).getAllByRole("button", { name: "Close" }).find((b) => !b.hasAttribute("aria-label"));
        if (!footer) throw new Error("no footer Close yet");
        return footer;
      };

      const politeRegion = () => screen.getAllByRole("status").find((el) => el.getAttribute("aria-live") === "polite")!;

      it("lands on the next row's kebab when the reload finishes before Close", async () => {
        const { table, dialog, proc } = await removeGlibc();
        mockListInstalled.mockResolvedValue(withoutGlibc);
        await finish(proc);
        await waitFor(() => expect(within(table).queryByText("glibc")).not.toBeInTheDocument());

        fireEvent.click(await waitFor(() => closeButton(dialog)));
        await waitFor(() => expect(within(table).getByRole("button", { name: "Actions for bash" })).toHaveFocus());
        expect(document.activeElement).not.toBe(document.body);
        await waitFor(() => expect(politeRegion()).toHaveTextContent("glibc is no longer in the list"));
      });

      it("lands on the next row's kebab when the reload finishes after Close", async () => {
        const { table, dialog, proc } = await removeGlibc();
        let resolve: (value: api.PackageListResponse) => void = () => {};
        mockListInstalled.mockImplementation(() => new Promise((r) => { resolve = r; }));
        await finish(proc);

        fireEvent.click(await waitFor(() => closeButton(dialog)));
        await waitFor(() => expect(within(table).getByRole("button", { name: "Actions for glibc" })).toHaveFocus());
        await new Promise((r) => setTimeout(r, 50));
        await act(async () => resolve(withoutGlibc));
        await waitFor(() => expect(within(table).queryByText("glibc")).not.toBeInTheDocument());

        await waitFor(() => expect(within(table).getByRole("button", { name: "Actions for bash" })).toHaveFocus());
        await waitFor(() => expect(politeRegion()).toHaveTextContent("glibc is no longer in the list"));
      });
    });
  });
});

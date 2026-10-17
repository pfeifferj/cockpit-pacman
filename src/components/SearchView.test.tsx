import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { SearchView } from "./SearchView";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import * as api from "../api";
import { mockPackageDetails, mockSyncPackageDetails, createMockStreamingProcess } from "../test/mocks";
import { sweepA11y } from "../test/a11ySweep";
import { mockSpawn } from "../test/setup";

const completeStream = (run: (cb: api.UpgradeCallbacks) => void) => {
  const proc = createMockStreamingProcess();
  mockSpawn.mockReturnValue(proc);
  run({ onComplete: () => {}, onError: () => {} });
  proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
  proc._complete();
};

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    searchPackages: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
    checkLock: vi.fn(),
    listIgnoredPackages: vi.fn(async () => ({ packages: [], total: 0 })),
    previewInstall: vi.fn(() => new Promise(() => {})),
  };
});

const mockSearchPackages = vi.mocked(api.searchPackages);
const mockCheckLock = vi.mocked(api.checkLock);

function recordAnnouncements(): string[] {
  const region = screen.getByRole("status");
  const seen: string[] = [];
  new MutationObserver(() => {
    if (region.textContent) seen.push(region.textContent);
  }).observe(region, { childList: true, characterData: true, subtree: true });
  return seen;
}
const mockGetPackageInfo = vi.mocked(api.getPackageInfo);

const mockSearchResponse: api.SearchResponse = {
  results: [
    {
      name: "linux",
      version: "6.7.1-arch1-1",
      description: "The Linux kernel and modules",
      repository: "core",
      installed: true,
      installed_version: "6.7.0-arch1-1",
    },
    {
      name: "linux-lts",
      version: "6.6.10-1",
      description: "The LTS Linux kernel and modules",
      repository: "core",
      installed: false,
      installed_version: null,
    },
    {
      name: "linux-zen",
      version: "6.7.1.zen1-1",
      description: "The Linux ZEN kernel and modules",
      repository: "extra",
      installed: false,
      installed_version: null,
    },
  ],
  total: 3,
  total_installed: 1,
  total_not_installed: 2,
  repositories: ["core", "extra"],
  repository_counts: [{ name: "core", count: 2 }, { name: "extra", count: 1 }],
};

describe("SearchView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchPackages.mockResolvedValue(mockSearchResponse);
    mockCheckLock.mockResolvedValue({ locked: false, stale: false, holder_unknown: false } as api.LockStatus);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders initial empty state", async () => {
    render(<SearchView />);

    expect(screen.getByText(/Search for packages/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search Arch repositories/i)).toBeInTheDocument();
  });

  it("shows minimum length error for short queries", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Search query must be at least/i)).toBeInTheDocument();
    });
  });

  it("displays search results after manual search", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    expect(screen.getByText("linux-lts")).toBeInTheDocument();
    expect(screen.getByText("linux-zen")).toBeInTheDocument();
    expect(screen.getByText("6.7.1-arch1-1")).toBeInTheDocument();
  });

  it("shows installed status labels", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    const installedLabels = screen.getAllByText(/Installed/);
    expect(installedLabels.length).toBeGreaterThan(0);

    const notInstalledLabels = screen.getAllByText(/Not installed/);
    expect(notInstalledLabels.length).toBeGreaterThan(0);
  });

  it("shows repository labels", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    const coreLabels = screen.getAllByText("core");
    expect(coreLabels.length).toBeGreaterThan(0);
    expect(screen.getByText("extra")).toBeInTheDocument();
  });

  it("displays error message on API failure", async () => {
    mockSearchPackages.mockRejectedValue(new api.BackendError("Cannot read repositories", "internal_error", "The extra database is damaged"));

    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Search failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText("The extra database is damaged")).toBeInTheDocument();
  });

  it("preserves debounced search diagnostics and clears them after a successful search", async () => {
    mockSearchPackages.mockRejectedValueOnce(new api.BackendError("Cannot read repositories", "internal_error", "The core database is damaged"));
    render(<SearchView />);
    const input = screen.getByPlaceholderText(/Search Arch repositories/i);
    fireEvent.change(input, { target: { value: "linux" } });
    expect(await screen.findByText("The core database is damaged")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "glibc" } });
    expect(await screen.findByText("linux")).toBeInTheDocument();
    expect(screen.queryByText("The core database is damaged")).not.toBeInTheDocument();
  });

  it("passes sync package lookup diagnostics into the details modal", async () => {
    vi.mocked(api.getSyncPackageInfo).mockRejectedValue(new api.BackendError("Cannot read package", "internal_error", "The repository entry is damaged"));
    render(<SearchView />);
    fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
    fireEvent.click(await screen.findByText("linux-lts"));
    expect(await screen.findByText("The repository entry is damaged")).toBeInTheDocument();
  });

  it("shows database locked warning", async () => {
    mockSearchPackages.mockRejectedValue(new Error("unable to lock database"));

    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Database is locked/i)).toBeInTheDocument();
    });
  });

  it("retries the search once the lock holder exits", async () => {
    vi.useFakeTimers();
    try {
      mockSearchPackages.mockRejectedValueOnce(new Error("unable to lock database"));
      mockCheckLock
        .mockResolvedValueOnce({ locked: true, stale: false, blocking_process: "pacman", holder_unknown: false } as api.LockStatus)
        .mockResolvedValue({ locked: false, stale: false, holder_unknown: false } as api.LockStatus);

      render(<SearchView />);
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Search/i }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/Waiting for/)).toBeInTheDocument();
      const searches = mockSearchPackages.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(mockSearchPackages).toHaveBeenCalledTimes(searches + 1);
      expect(mockSearchPackages).toHaveBeenLastCalledWith(expect.objectContaining({ query: "linux" }));
      expect(screen.queryByText(/Database is locked/i)).not.toBeInTheDocument();
      expect(screen.getByText("linux-lts")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders table with correct headers", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
  });

  it("shows installed filter toggle group", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /All/ })).toBeInTheDocument();
  });

  it("filters by installed status", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    mockSearchPackages.mockClear();

    const installedToggle = screen.getByRole("button", { name: /^Installed/ });
    await act(async () => {
      fireEvent.click(installedToggle);
    });

    await waitFor(() => {
      expect(mockSearchPackages).toHaveBeenCalledWith(
        expect.objectContaining({ installed: "installed" })
      );
    });
  });

  it("keeps the filtered rows when the search it replaced answers last", async () => {
    const installedOnly: api.SearchResponse = {
      results: [mockSearchResponse.results[0]],
      total: 1,
      total_installed: 1,
      total_not_installed: 2,
      repositories: ["core"],
    };

    let releaseAll: () => void = () => {};
    const allLanded = new Promise<void>((resolve) => { releaseAll = resolve; });

    mockSearchPackages.mockImplementation(async (args: { installed?: string }) => {
      if (args.installed === "installed") return installedOnly;
      await allLanded;
      return mockSearchResponse;
    });

    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Installed/ }));
    });
    await waitFor(() => {
      expect(screen.queryByText("linux-zen")).not.toBeInTheDocument();
    });

    await act(async () => {
      releaseAll();
      await allLanded;
    });

    expect(screen.getByText("linux")).toBeInTheDocument();
    expect(screen.queryByText("linux-zen")).not.toBeInTheDocument();
  });

  it("shows no results message when empty", async () => {
    mockSearchPackages.mockResolvedValue({
      results: [],
      total: 0,
      total_installed: 0,
      total_not_installed: 0,
      repositories: [],
    });

    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "nonexistent" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/No packages found/i)).toBeInTheDocument();
    });
  });

  it("clears results when clearing search", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    const clearButton = screen.getByLabelText(/Reset/i);
    await act(async () => {
      fireEvent.click(clearButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Search for packages/i)).toBeInTheDocument();
    });
  });

  it("opens local details for an installed row whose build matches the repository", async () => {
    mockGetPackageInfo.mockResolvedValue(mockPackageDetails);
    mockSearchPackages.mockResolvedValue({
      ...mockSearchResponse,
      results: mockSearchResponse.results.map((r) => (r.name === "linux" ? { ...r, installed_version: r.version } : r)),
    });

    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    const linuxButton = screen.getByRole("button", { name: "linux" });
    await act(async () => {
      fireEvent.click(linuxButton);
    });

    await waitFor(() => {
      expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    });
  });

  it("shows total count in results", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Found 3 packages/i)).toBeInTheDocument();
    });
  });

  it("supports manual search with Enter key", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    await act(async () => {
      fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
    });

    await waitFor(() => {
      expect(mockSearchPackages).toHaveBeenCalled();
    });
  });

  it("handles pagination display", async () => {
    mockSearchPackages.mockResolvedValue({
      ...mockSearchResponse,
      total: 100,
    });

    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Found 100 packages/i)).toBeInTheDocument();
    });
  });

  it("groups thousands in the result count", async () => {
    mockSearchPackages.mockResolvedValue({ ...mockSearchResponse, total: 1000 });
    render(<SearchView />);
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Search/i }));
    });
    expect(await screen.findByText("Found 1,000 packages")).toBeInTheDocument();
  });

  it("sorts by name when clicking Name header", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    mockSearchPackages.mockClear();

    const nameHeader = screen.getByText("Name");
    await act(async () => {
      fireEvent.click(nameHeader);
    });

    await waitFor(() => {
      expect(mockSearchPackages).toHaveBeenCalledWith(
        expect.objectContaining({
          sortBy: "name",
          sortDir: "asc",
        })
      );
    });
  });

  it("sorts by repository when clicking Repository header", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    mockSearchPackages.mockClear();

    const repoHeader = screen.getByText("Repository");
    await act(async () => {
      fireEvent.click(repoHeader);
    });

    await waitFor(() => {
      expect(mockSearchPackages).toHaveBeenCalledWith(
        expect.objectContaining({
          sortBy: "repository",
        })
      );
    });
  });

  it("shows loading spinner while searching", async () => {
    let resolveSearch: (value: api.SearchResponse) => void;
    mockSearchPackages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );

    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/Searching repositories/i)).toBeInTheDocument();
    });

    await act(async () => {
      resolveSearch!(mockSearchResponse);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });
  });

  it("shows installed version when different from repo version", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });

    expect(screen.getByText(/6.7.0-arch1-1/)).toBeInTheDocument();
  });

  it("calls searchPackages with correct params", async () => {
    render(<SearchView />);

    const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "linux" } });
    });

    const searchButton = screen.getByRole("button", { name: /Search/i });
    await act(async () => {
      fireEvent.click(searchButton);
    });

    await waitFor(() => {
      expect(mockSearchPackages).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "linux",
          installed: "all",
        })
      );
    });
  });

  describe("zero-result next actions", () => {
    const runSearch = async (query: string) => {
      const searchInput = screen.getByPlaceholderText(/Search Arch repositories/i);
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: query } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Search" }));
      });
    };

    it("shows an example query in the placeholder", () => {
      render(<SearchView />);
      expect(screen.getByPlaceholderText(/e\.g\./)).toBeInTheDocument();
    });

    it("offers to clear a repository filter that matches nothing", async () => {
      render(<SearchView />);
      await runSearch("linux");
      await screen.findByText("linux-lts");

      mockSearchPackages.mockResolvedValueOnce({
        ...mockSearchResponse,
        results: [],
        total: 0,
        total_installed: 0,
        total_not_installed: 0,
        repository_counts: [...mockSearchResponse.repository_counts!, { name: "multilib", count: 0 }],
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Filter by repository" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: "extra (1)" }));
      });
      await screen.findByText(/No results in extra/);
      expect(screen.getByText(/2 packages in other repositories match linux/)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Clear repository filter" }));
      });

      await screen.findByText("linux-lts");
      expect(mockSearchPackages).toHaveBeenLastCalledWith(expect.objectContaining({ repo: "all", offset: 0 }));
      expect(document.activeElement).toBe(screen.getByPlaceholderText(/Search Arch repositories/i));
    });

    it("routes an empty result to the installed packages search with the query", async () => {
      mockSearchPackages.mockResolvedValue({
        results: [],
        total: 0,
        total_installed: 0,
        total_not_installed: 0,
        repositories: [],
      });
      const onSearchInstalled = vi.fn();
      render(<SearchView onSearchInstalled={onSearchInstalled} />);
      await runSearch("my-aur-pkg");

      const button = await screen.findByRole("button", { name: "Search installed packages" });
      await act(async () => {
        fireEvent.click(button);
      });

      expect(onSearchInstalled).toHaveBeenCalledWith("my-aur-pkg");
    });

    it("hides the installed-packages action without a navigation handler", async () => {
      mockSearchPackages.mockResolvedValue({
        results: [],
        total: 0,
        total_installed: 0,
        total_not_installed: 0,
        repositories: [],
      });
      render(<SearchView />);
      await runSearch("nothing");

      await screen.findByText(/No packages found/);
      expect(screen.queryByRole("button", { name: "Search installed packages" })).not.toBeInTheDocument();
    });

    it("offers to show all results when the installed filter empties the page", async () => {
      render(<SearchView />);
      await runSearch("linux");
      await waitFor(() => {
        expect(screen.getByText("linux-lts")).toBeInTheDocument();
      });

      mockSearchPackages.mockResolvedValueOnce({ ...mockSearchResponse, results: [], total: 0 });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Installed/ }));
      });

      const showAll = await screen.findByRole("button", { name: "Show all results" });
      await act(async () => {
        fireEvent.click(showAll);
      });

      await waitFor(() => {
        expect(screen.getByText("linux-lts")).toBeInTheDocument();
      });
      expect(mockSearchPackages).toHaveBeenLastCalledWith(expect.objectContaining({ installed: "all", repo: "all" }));
      expect(document.activeElement).toBe(screen.getByPlaceholderText(/Search Arch repositories/i));
    });

    it("runs a search for a query handed in from another tab", async () => {
      render(<SearchView routeOptions={{ q: "linux" }} />);

      await waitFor(() => {
        expect(mockSearchPackages).toHaveBeenCalledWith(expect.objectContaining({ query: "linux" }));
      });
      expect(screen.getByPlaceholderText(/Search Arch repositories/i)).toHaveValue("linux");
    });
  });

  describe("result announcements", () => {
    it("announces one settled count per debounced search, and nothing on mount", async () => {
      mockSearchPackages.mockResolvedValue({ ...mockSearchResponse, results: mockSearchResponse.results.slice(0, 2), total: 2 });
      render(<AnnouncerProvider><SearchView /></AnnouncerProvider>);
      const seen = recordAnnouncements();
      const input = screen.getByPlaceholderText(/Search Arch repositories/i);
      fireEvent.change(input, { target: { value: "l" } });
      fireEvent.change(input, { target: { value: "li" } });
      fireEvent.change(input, { target: { value: "lin" } });

      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 packages found"));
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(mockSearchPackages).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(["2 packages found"]);
    });

    it("names the query when nothing matches", async () => {
      mockSearchPackages.mockResolvedValue({ results: [], total: 0, total_installed: 0, total_not_installed: 0, repositories: [] });
      render(<AnnouncerProvider><SearchView /></AnnouncerProvider>);
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "nope" } });
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No packages found for nope"));
    });
  });

  describe("fresh data", () => {
    it("does nothing on a system change before any search", async () => {
      render(<SearchView />);
      await act(async () => {
        completeStream((cb) => api.runUpgrade(cb));
      });
      expect(mockSearchPackages).not.toHaveBeenCalled();
    });

    it("re-runs the current query and filter after an install or a sync", async () => {
      render(<SearchView />);
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Search/i }));
      });
      await screen.findByText("linux-lts");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Not installed/ }));
      });
      await waitFor(() => {
        expect(mockSearchPackages).toHaveBeenLastCalledWith(expect.objectContaining({ installed: "not-installed" }));
      });

      mockSearchPackages.mockClear();
      await act(async () => {
        completeStream((cb) => api.installPackage(cb, "linux-lts"));
      });
      expect(mockSearchPackages).toHaveBeenCalledTimes(1);
      expect(mockSearchPackages).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "linux", installed: "not-installed", offset: 0 }),
      );
      expect(screen.getByPlaceholderText(/Search Arch repositories/i)).toHaveValue("linux");

      mockSearchPackages.mockClear();
      await act(async () => {
        completeStream((cb) => api.syncDatabase(cb));
      });
      expect(mockSearchPackages).toHaveBeenCalledTimes(1);
    });
  });

  describe("narrow toolbar", () => {
    const filtersToggle = () => screen.getByRole("button", { name: "Show filters" });
    const searchField = () => screen.getByRole("textbox", { name: "Search Arch repositories" });

    const search = async () => {
      render(<SearchView />);
      fireEvent.change(searchField(), { target: { value: "linux" } });
      await screen.findByText("linux-zen");
    };

    it("offers no filters toggle before the first search", () => {
      render(<SearchView />);
      expect(screen.queryByRole("button", { name: "Show filters" })).not.toBeInTheDocument();
      expect(document.querySelector(".pf-m-toggle-group")).toBeNull();
    });

    it("puts the filters, not the search field, in a named toggle group", async () => {
      await search();
      const group = filtersToggle().closest(".pf-m-toggle-group") as HTMLElement;
      expect(within(group).getByRole("group", { name: "Installed filter" })).toBeInTheDocument();
      expect(within(group).getByRole("button", { name: "Filter by repository" })).toBeInTheDocument();
      expect(within(group).queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("shows active filters as chips; removing one searches again without it", async () => {
      await search();
      expect(screen.queryByRole("list", { name: "Show" })).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Not installed/ }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Filter by repository" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: /^core/ }));
      });

      const shown = await screen.findByRole("list", { name: "Show" });
      expect(within(shown).getByText("Not installed")).toBeInTheDocument();
      const repo = screen.getByRole("list", { name: "Repository" });
      expect(within(repo).getByText("core")).toBeInTheDocument();

      mockSearchPackages.mockClear();
      await act(async () => {
        fireEvent.click(within(repo).getByRole("button", { name: "Close core" }));
      });
      expect(mockSearchPackages).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "linux", repo: "all", installed: "not-installed", offset: 0 }),
      );
      expect(screen.queryByRole("list", { name: "Repository" })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(searchField());

      mockSearchPackages.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      });
      expect(mockSearchPackages).toHaveBeenCalledTimes(1);
      expect(mockSearchPackages).toHaveBeenLastCalledWith(expect.objectContaining({ installed: "all", repo: "all" }));
      expect(screen.queryByRole("list", { name: "Show" })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(searchField());
    });
  });

  describe("repository filter", () => {
    const coreOnly: api.SearchResponse = {
      ...mockSearchResponse,
      results: mockSearchResponse.results.filter((r) => r.repository === "core"),
      total: 2,
    };

    it("asks the backend for the chosen repository from page 1 and shows per-repository counts", async () => {
      mockSearchPackages.mockResolvedValue({ ...mockSearchResponse, total: 120 });
      const onRouteChange = vi.fn();
      render(<AnnouncerProvider><SearchView routeOptions={{}} onRouteChange={onRouteChange} /></AnnouncerProvider>);
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      await screen.findByText("linux-zen");
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: /Go to next page/i })[0]);
      });
      expect(mockSearchPackages).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }));

      mockSearchPackages.mockResolvedValue(coreOnly);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Filter by repository" }));
      });
      expect(screen.getByRole("option", { name: "All repositories (3)" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "extra (1)" })).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: "core (2)" }));
      });

      expect(mockSearchPackages).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "linux", repo: "core", offset: 0, installed: "all" }),
      );
      await waitFor(() => expect(screen.queryByText("linux-zen")).not.toBeInTheDocument());
      expect(screen.getByText("Found 2 packages in core")).toBeInTheDocument();
      expect(screen.queryByText(/on this page/)).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 packages found in core"));
      expect(onRouteChange).toHaveBeenLastCalledWith({ q: "linux", in: "core" });
    });

    it("keeps the repository filter when the installed filter or page changes", async () => {
      render(<SearchView routeOptions={{ q: "linux", in: "core" }} />);
      await waitFor(() =>
        expect(mockSearchPackages).toHaveBeenCalledWith(expect.objectContaining({ query: "linux", repo: "core" })),
      );
      await screen.findByText("linux-lts");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Not installed/ }));
      });
      expect(mockSearchPackages).toHaveBeenLastCalledWith(
        expect.objectContaining({ installed: "not-installed", repo: "core", offset: 0 }),
      );
    });

    it("offers Search all repositories when the routed repository does not exist", async () => {
      const onRouteChange = vi.fn();
      mockSearchPackages.mockImplementation(async (params) => {
        if (params.repo === "nope") {
          throw new api.BackendError("Invalid repository 'nope'. Valid repositories: core, extra", "validation_error");
        }
        return mockSearchResponse;
      });
      render(<SearchView routeOptions={{ q: "linux", in: "nope" }} onRouteChange={onRouteChange} />);
      const alert = await screen.findByText(/Invalid repository 'nope'/);
      fireEvent.click(within(alert.closest<HTMLElement>(".pf-v6-c-alert")!).getByRole("button", { name: "Search all repositories" }));

      await waitFor(() =>
        expect(mockSearchPackages).toHaveBeenLastCalledWith(expect.objectContaining({ query: "linux", repo: "all" })),
      );
      expect(await screen.findByText("linux-zen")).toBeInTheDocument();
      expect(screen.queryByText(/Invalid repository/)).not.toBeInTheDocument();
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ q: "linux" }));
    });

    it.each(["../core", "extra+x"])("refuses a malformed routed repository (%s)", async (repo) => {
      const onRouteChange = vi.fn();
      render(<SearchView routeOptions={{ q: "linux", in: repo }} onRouteChange={onRouteChange} />);
      await waitFor(() =>
        expect(mockSearchPackages).toHaveBeenCalledWith(expect.objectContaining({ query: "linux", repo: "all" })),
      );
      expect(onRouteChange).toHaveBeenCalledWith({ q: "linux" });
    });
  });

  describe("installed rows with another repository build", () => {
    const testing: api.SearchResponse = {
      results: [
        { name: "linux", version: "6.11.1.arch1-1", description: "The Linux kernel", repository: "core", installed: true, installed_version: "6.11.1.arch1-1" },
        { name: "linux", version: "6.12rc3-1", description: "The Linux kernel", repository: "core-testing", installed: true, installed_version: "6.11.1.arch1-1" },
      ],
      total: 2,
      total_installed: 2,
      total_not_installed: 0,
      repositories: ["core", "core-testing"],
      repository_counts: [{ name: "core", count: 1 }, { name: "core-testing", count: 1 }],
    };
    const rows = () => within(screen.getByRole("grid", { name: "Search results" })).getAllByRole("button", { name: "linux" });

    beforeEach(() => {
      mockSearchPackages.mockResolvedValue(testing);
      vi.mocked(api.getSyncPackageInfo).mockImplementation(async (name: string, repo?: string) =>
        ({ ...mockSyncPackageDetails, name, version: "6.12rc3-1", repository: repo ?? "core", installed_version: "6.11.1.arch1-1" }));
      mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
    });

    it("opens the testing build's sync details and the matching build's local details", async () => {
      const onRouteChange = vi.fn();
      render(<SearchView routeOptions={{}} onRouteChange={onRouteChange} />);
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      await waitFor(() => expect(rows()).toHaveLength(2));

      fireEvent.click(rows()[1]);
      const panel = await screen.findByRole("region", { name: /^linux 6\.12rc3-1 core-testing/ });
      expect(within(panel).getByText("Installed: 6.11.1.arch1-1")).toBeInTheDocument();
      expect(vi.mocked(api.getSyncPackageInfo)).toHaveBeenLastCalledWith("linux", "core-testing");
      expect(mockGetPackageInfo).not.toHaveBeenCalled();
      expect(rows()[1].closest("tr")).toHaveAttribute("aria-current", "true");
      await waitFor(() =>
        expect(onRouteChange).toHaveBeenLastCalledWith({ q: "linux", pkg: "linux", repo: "core-testing" }),
      );

      fireEvent.click(rows()[0]);
      await waitFor(() => expect(mockGetPackageInfo).toHaveBeenCalledWith("linux"));
      expect(rows()[0].closest("tr")).toHaveAttribute("aria-current", "true");
      await waitFor(() => expect(screen.queryByText(/^Installed: /)).not.toBeInTheDocument());
    });

    it("omits the installed version when sync details show the installed build", async () => {
      vi.mocked(api.getSyncPackageInfo).mockImplementation(async (name: string, repo?: string) =>
        ({ ...mockSyncPackageDetails, name, version: "6.12rc3-1", repository: repo ?? "core", installed_version: "6.12rc3-1" }));
      render(<SearchView />);
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.click(rows()[1]);
      await screen.findByRole("region", { name: /^linux 6\.12rc3-1 core-testing/ });
      expect(screen.queryByText(/^Installed: /)).not.toBeInTheDocument();
    });

    it("opens sync details for an installed row whose repository version differs", async () => {
      mockSearchPackages.mockResolvedValue({ ...testing, results: [{ ...testing.results[0], version: "6.11.2.arch1-1" }] });
      render(<SearchView />);
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      await waitFor(() => expect(rows()).toHaveLength(1));
      fireEvent.click(rows()[0]);
      await waitFor(() => expect(vi.mocked(api.getSyncPackageInfo)).toHaveBeenCalledWith("linux", "core"));
      expect(mockGetPackageInfo).not.toHaveBeenCalled();
    });
  });

  describe("route options", () => {
    const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);

    it("writes the settled query and an opened repository package to the route", async () => {
      mockSearchPackages.mockResolvedValue(mockSearchResponse);
      mockGetSyncPackageInfo.mockResolvedValue({ ...mockPackageDetails, name: "linux-lts" } as unknown as api.SyncPackageDetails);
      const onRouteChange = vi.fn();
      const { rerender } = render(<SearchView routeOptions={{}} onRouteChange={onRouteChange} />);
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ q: "linux" }));
      rerender(<SearchView routeOptions={{ q: "linux" }} onRouteChange={onRouteChange} />);

      fireEvent.click(await screen.findByRole("button", { name: "linux-lts" }));
      await waitFor(() =>
        expect(onRouteChange).toHaveBeenLastCalledWith({ q: "linux", pkg: "linux-lts", repo: "core" }),
      );
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux-lts", "core");
    });

    it("opens details for a routed repository package", async () => {
      mockGetSyncPackageInfo.mockResolvedValue({ ...mockPackageDetails, name: "linux-lts" } as unknown as api.SyncPackageDetails);
      render(<SearchView routeOptions={{ pkg: "linux-lts", repo: "core" }} />);
      await waitFor(() => expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux-lts", "core"));
    });

    it("focuses the search field for a carried query", async () => {
      mockSearchPackages.mockResolvedValue(mockSearchResponse);
      const { rerender } = render(<SearchView routeOptions={{}} />);
      rerender(<SearchView routeOptions={{ q: "linux" }} />);
      const input = screen.getByPlaceholderText(/Search Arch repositories/i);
      await waitFor(() => expect(input).toHaveValue("linux"));
      expect(input).toHaveFocus();
      await waitFor(() =>
        expect(mockSearchPackages).toHaveBeenCalledWith(expect.objectContaining({ query: "linux" })),
      );
    });
  });

  describe("details drawer", () => {
    const nameButton = (name: string) =>
      within(screen.getByRole("grid", { name: "Search results" })).getByRole("button", { name });

    const search = async () => {
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Search/i }));
      });
      await screen.findByText("linux-zen");
    };

    beforeEach(() => {
      vi.mocked(api.getSyncPackageInfo).mockImplementation(async (name: string, repo?: string) =>
        ({ ...mockSyncPackageDetails, name, repository: repo ?? "core" }));
      mockGetPackageInfo.mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
    });

    it("replaces the panel in place, keeps the results and returns focus to the invoking row", async () => {
      render(<SearchView />);
      await search();
      fireEvent.click(screen.getByRole("button", { name: /Not installed/ }));
      await waitFor(() => expect(mockSearchPackages).toHaveBeenLastCalledWith(expect.objectContaining({ installed: "not-installed" })));
      await screen.findByText("linux-zen");
      const searchCalls = mockSearchPackages.mock.calls.length;

      fireEvent.click(nameButton("linux-lts"));
      expect(await screen.findByRole("region", { name: /^linux-lts/ })).toBeInTheDocument();
      nameButton("linux-zen").focus();
      fireEvent.click(nameButton("linux-zen"));
      const panel = await screen.findByRole("region", { name: /^linux-zen/ });

      expect(vi.mocked(api.getSyncPackageInfo)).toHaveBeenLastCalledWith("linux-zen", "extra");
      expect(screen.queryByRole("region", { name: /^linux-lts/ })).not.toBeInTheDocument();
      expect(screen.queryAllByRole("dialog")).toHaveLength(0);
      expect(nameButton("linux-zen").closest("tr")).toHaveAttribute("aria-current", "true");
      expect(nameButton("linux-lts").closest("tr")).not.toHaveAttribute("aria-current");
      sweepA11y();

      const close = within(panel).getByRole("button", { name: "Close package details" });
      close.focus();
      fireEvent.click(close);
      await waitFor(() => expect(screen.queryByRole("region", { name: /^linux-zen/ })).not.toBeInTheDocument());
      expect(document.activeElement).toBe(nameButton("linux-zen"));
      expect(screen.getByPlaceholderText(/Search Arch repositories/i)).toHaveValue("linux");
      expect(screen.getByRole("button", { name: /^Not installed/ })).toHaveAttribute("aria-pressed", "true");
      expect(mockSearchPackages.mock.calls.length).toBe(searchCalls);
    });

    it("does not re-read the package when its open row is clicked again and marks the row with an outline", async () => {
      render(<SearchView />);
      await search();
      fireEvent.click(nameButton("linux-lts"));
      await screen.findByRole("region", { name: /^linux-lts/ });
      fireEvent.click(nameButton("linux-lts"));
      await act(async () => {});
      expect(vi.mocked(api.getSyncPackageInfo)).toHaveBeenCalledTimes(1);
      const row = nameButton("linux-lts").closest("tr")!;
      expect(row).toHaveAttribute("aria-current", "true");
      expect(row.style.outline).not.toBe("");
      expect(row).not.toHaveClass("pf-m-selected");
    });

    it("re-reads the open package after a sync", async () => {
      render(<SearchView />);
      await search();
      fireEvent.click(nameButton("linux-lts"));
      await screen.findByRole("region", { name: /^linux-lts/ });
      vi.mocked(api.getSyncPackageInfo).mockResolvedValueOnce({ ...mockSyncPackageDetails, name: "linux-lts", version: "6.6.11-1" });

      await act(async () => completeStream((cb) => api.syncDatabase(cb)));
      expect(await within(screen.getByRole("region", { name: /^linux-lts/ })).findByText("6.6.11-1")).toBeInTheDocument();
      expect(vi.mocked(api.getSyncPackageInfo)).toHaveBeenLastCalledWith("linux-lts", "core");
    });

    it("overlays the results at narrow widths", async () => {
      const original = window.matchMedia;
      window.matchMedia = vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as typeof window.matchMedia;
      try {
        const { container } = render(<SearchView />);
        await search();
        fireEvent.click(nameButton("linux-lts"));
        const panel = await screen.findByRole("dialog", { name: /^linux-lts/ });
        expect(panel).toHaveAttribute("aria-modal", "true");
        const drawer = container.querySelector(".pf-v6-c-drawer");
        expect(drawer).toHaveClass("pf-m-expanded");
        expect(drawer).not.toHaveClass("pf-m-inline");
      } finally {
        window.matchMedia = original;
      }
    });
  });

  describe("row actions", () => {
    const search = async () => {
      render(<SearchView />);
      fireEvent.change(screen.getByPlaceholderText(/Search Arch repositories/i), { target: { value: "linux" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Search/i }));
      });
      return screen.findByRole("grid", { name: "Search results" });
    };

    it("puts a named kebab on every row that opens without opening details", async () => {
      const table = await search();
      for (const name of ["linux", "linux-lts", "linux-zen"]) {
        expect(within(table).getByRole("button", { name: `Actions for ${name}` })).toBeInTheDocument();
      }
      fireEvent.click(within(table).getByRole("button", { name: "Actions for linux" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Remove linux" })).toBeInTheDocument();
      expect(within(menu).queryByRole("menuitem", { name: "Install linux" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Close package details" })).not.toBeInTheDocument();
    });

    it("offers no runnable Reinstall on a row whose repository version differs from the installed one", async () => {
      const table = await search();
      fireEvent.click(within(table).getByRole("button", { name: "Actions for linux" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Ignore linux" })).toBeInTheDocument();
      const reinstall = within(menu).getByRole("menuitem", { name: "Reinstall linux" });
      expect(reinstall).toHaveAttribute("aria-disabled", "true");
      expect(reinstall).toHaveAccessibleDescription(/reinstalling would upgrade linux alone/);
      fireEvent.click(reinstall);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.getSyncPackageInfo).not.toHaveBeenCalled();
    });

    it("offers Reinstall on a row whose repository version is the installed one", async () => {
      mockSearchPackages.mockResolvedValue({
        ...mockSearchResponse,
        results: mockSearchResponse.results.map((r) => (r.name === "linux" ? { ...r, installed_version: r.version } : r)),
      });
      const table = await search();
      fireEvent.click(within(table).getByRole("button", { name: "Actions for linux" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Reinstall linux" })).toBeInTheDocument();
    });

    it("offers Install for a repository-only row and opens its previewed install", async () => {
      const table = await search();
      fireEvent.click(within(table).getByRole("button", { name: "Actions for linux-lts" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).queryByRole("menuitem", { name: "Remove linux-lts" })).not.toBeInTheDocument();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Install linux-lts" }));
      expect(await screen.findByRole("dialog", { name: "Install linux-lts" })).toBeInTheDocument();
      expect(api.previewInstall).toHaveBeenCalledWith("linux-lts", { repo: "core", version: "6.6.10-1", reinstall: undefined });
      expect(mockGetPackageInfo).not.toHaveBeenCalled();
    });
  });
});


describe("SearchView abort signals", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("aborts superseded requests and the last request on unmount", async () => {
    mockSearchPackages.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<SearchView />);
    const input = screen.getByPlaceholderText(/Search Arch repositories/);
    fireEvent.change(input, { target: { value: "linux" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mockSearchPackages).toHaveBeenCalled());
    const firstSignal = mockSearchPackages.mock.lastCall![0].signal!;
    expect(firstSignal.aborted).toBe(false);
    fireEvent.change(input, { target: { value: "bash" } });
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(mockSearchPackages.mock.lastCall![0].query).toBe("bash"));
    const lastSignal = mockSearchPackages.mock.lastCall![0].signal!;
    expect(lastSignal.aborted).toBe(false);
    unmount();
    expect(lastSignal.aborted).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { SearchView } from "./SearchView";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    searchPackages: vi.fn(),
    getSyncPackageInfo: vi.fn(),
  };
});

const mockSearchPackages = vi.mocked(api.searchPackages);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);

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
};

const mockSyncPackageDetails: api.SyncPackageDetails = {
  name: "linux",
  version: "6.7.1-arch1-1",
  description: "The Linux kernel and modules",
  url: "https://kernel.org/",
  licenses: ["GPL-2.0-only"],
  groups: [],
  provides: [],
  depends: ["coreutils"],
  optdepends: [],
  conflicts: [],
  replaces: [],
  download_size: 150000000,
  installed_size: 145000000,
  packager: "heftig",
  architecture: "x86_64",
  build_date: 1704067200,
  repository: "core",
};

describe("SearchView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchPackages.mockResolvedValue(mockSearchResponse);
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
    mockSearchPackages.mockRejectedValue(new Error("Network error"));

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

  it("opens package details modal when clicking a row", async () => {
    mockGetSyncPackageInfo.mockResolvedValue(mockSyncPackageDetails);

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
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux", "core");
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
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { PackageList } from "./PackageList";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listInstalled: vi.fn(),
    getPackageInfo: vi.fn(),
  };
});

const mockListInstalled = vi.mocked(api.listInstalled);
const mockGetPackageInfo = vi.mocked(api.getPackageInfo);

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
    mockListInstalled.mockRejectedValue(new Error("Network error"));

    render(<PackageList />);

    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });
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
      installed_size: 142000000,
      packager: "heftig",
      architecture: "x86_64",
      build_date: 1704067200,
      install_date: 1704067200,
      reason: "explicit",
      validation: ["pgp"],
      repository: "core",
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
});

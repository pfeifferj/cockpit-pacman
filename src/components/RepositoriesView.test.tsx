import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { RepositoriesView } from "./RepositoriesView";
import * as api from "../api";
import type { ListReposResponse } from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listRepos: vi.fn(),
    saveRepos: vi.fn(),
  };
});

const mockListRepos = vi.mocked(api.listRepos);
const mockSaveRepos = vi.mocked(api.saveRepos);

const mockRepoResponse: ListReposResponse = {
  repos: [
    {
      name: "core",
      enabled: true,
      sig_level: "Required DatabaseOptional",
      directives: [
        { directive_type: "Include", value: "/etc/pacman.d/mirrorlist", enabled: true },
      ],
    },
    {
      name: "extra",
      enabled: true,
      sig_level: "Required DatabaseOptional",
      directives: [
        { directive_type: "Server", value: "https://geo.mirror.pkgbuild.com/$repo/os/$arch", enabled: true },
      ],
    },
  ],
};

describe("RepositoriesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListRepos.mockResolvedValue(mockRepoResponse);
    mockSaveRepos.mockResolvedValue({ success: true, backup_path: null, message: "Saved" });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading state initially", () => {
    mockListRepos.mockImplementation(() => new Promise(() => {}));
    render(<RepositoriesView />);
    expect(screen.getByText(/Loading repositories/i)).toBeInTheDocument();
  });

  it("renders repo table with repo name in monospace brackets", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    const coreEl = screen.getByText("[core]");
    expect(coreEl).toHaveStyle({ fontFamily: "var(--pf-t--global--font--family--mono)" });
  });

  it("stat boxes show Total and Enabled counts", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    expect(screen.getByText("Total")).toBeInTheDocument();
    // "Enabled" appears both as StatBox label and table header; pick the StatBox
    expect(screen.getAllByText("Enabled").length).toBeGreaterThanOrEqual(1);
    // Both repos are enabled: total=2, enabled=2
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
  });

  it("shows error state on API failure", async () => {
    mockListRepos.mockRejectedValue(new Error("Permission denied"));
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText(/Error loading repositories/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when repos array is empty", async () => {
    mockListRepos.mockResolvedValue({ repos: [] });
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText(/No repositories found/i)).toBeInTheDocument();
    });
  });

  it("enable/disable Switch enables the save button", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    expect(saveButton).toBeDisabled();
    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[0]);
    });
    expect(saveButton).not.toBeDisabled();
  });

  it("SigLevel column contains a select", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThan(0);
  });

  it("search filter hides non-matching repo rows", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    const searchInput = screen.getByPlaceholderText("Search repositories...");
    fireEvent.change(searchInput, { target: { value: "core" } });
    expect(screen.getByText("[core]")).toBeInTheDocument();
    expect(screen.queryByText("[extra]")).not.toBeInTheDocument();
  });

  it("Move Up disabled for first repo, Move Down disabled for last", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    const moveUpButtons = screen.getAllByRole("button", { name: /Move up/i });
    const moveDownButtons = screen.getAllByRole("button", { name: /Move down/i });
    expect(moveUpButtons[0]).toBeDisabled();
    expect(moveDownButtons[moveDownButtons.length - 1]).toBeDisabled();
  });

  it("expanding a row shows its directives", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    const expandButtons = screen.getAllByRole("button", { name: /expand/i });
    await act(async () => {
      fireEvent.click(expandButtons[0]);
    });
    await waitFor(() => {
      expect(screen.getByText("/etc/pacman.d/mirrorlist")).toBeInTheDocument();
    });
  });

  it("calls saveRepos with updated payload on save", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });

    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(mockSaveRepos).toHaveBeenCalledTimes(1);
    });

    const savedRepos = mockSaveRepos.mock.calls[0][0];
    expect(savedRepos).toHaveLength(2);
    expect(savedRepos[0].name).toBe("core");
    expect(savedRepos[0].enabled).toBe(false);
    expect(savedRepos[1].name).toBe("extra");
    expect(savedRepos[1].enabled).toBe(true);
  });
});

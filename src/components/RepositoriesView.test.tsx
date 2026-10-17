import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { RepositoriesView } from "./RepositoriesView";
import * as api from "../api";
import type { ListReposResponse } from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listRepos: vi.fn(),
    saveRepos: vi.fn(),
    listRepoBackups: vi.fn(),
    restoreRepoBackup: vi.fn(),
    deleteRepoBackup: vi.fn(),
  };
});

const mockListRepos = vi.mocked(api.listRepos);
const mockSaveRepos = vi.mocked(api.saveRepos);
const mockListRepoBackups = vi.mocked(api.listRepoBackups);
const mockRestoreRepoBackup = vi.mocked(api.restoreRepoBackup);
const mockDeleteRepoBackup = vi.mocked(api.deleteRepoBackup);

const mockRepoResponse: ListReposResponse = {
  revision: "loaded-revision",
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
    mockSaveRepos.mockResolvedValue({ success: true, backup_path: null, message: "Saved", revision: "saved-revision", warnings: [] });
    mockListRepoBackups.mockResolvedValue({ backups: [], warnings: [] });
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
    mockListRepos.mockRejectedValue(new api.BackendError("Permission denied", "permission_denied", "Could not read /etc/pacman.conf"));
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText(/Error loading repositories/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Could not read /etc/pacman.conf")).toBeInTheDocument();
  });

  it("shows empty state when repos array is empty", async () => {
    mockListRepos.mockResolvedValue({ repos: [], revision: "empty-revision" });
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
    expect(mockSaveRepos.mock.calls[0][1]).toBe("loaded-revision");
    expect(savedRepos).toHaveLength(2);
    expect(savedRepos[0].name).toBe("core");
    expect(savedRepos[0].enabled).toBe(false);
    expect(savedRepos[1].name).toBe("extra");
    expect(savedRepos[1].enabled).toBe(true);
  });

  it("keeps edits after a stale save until the user confirms reloading", async () => {
    mockSaveRepos.mockRejectedValueOnce(new api.BackendError("Repository configuration changed since it was loaded. Reload repositories before saving.", "validation_error", "Loaded revision differs from /etc/pacman.conf"));
    render(<RepositoriesView />);
    const core = await screen.findByLabelText("Enable repository core");
    fireEvent.click(core);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save Changes" })); });
    expect(screen.getByText(/configuration changed since it was loaded/)).toBeInTheDocument();
    expect(screen.getByText("Loaded revision differs from /etc/pacman.conf")).toBeInTheDocument();
    expect(screen.getByLabelText("Enable repository core")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
    expect(mockListRepos).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reload repositories" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Enable repository core")).not.toBeChecked();
    expect(mockListRepos).toHaveBeenCalledTimes(1);

    mockListRepos.mockResolvedValue({ ...mockRepoResponse, revision: "fresh-revision" });
    fireEvent.click(screen.getByRole("button", { name: "Reload repositories" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard edits and reload" })); });
    expect(screen.getByLabelText("Enable repository core")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Enable repository core"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save Changes" })); });
    expect(mockSaveRepos.mock.lastCall?.[1]).toBe("fresh-revision");
    expect(screen.queryByText("Loaded revision differs from /etc/pacman.conf")).not.toBeInTheDocument();
  });

  it("preserves backend details when backup history fails", async () => {
    mockListRepoBackups.mockRejectedValue(new api.BackendError("Backups could not be read", "permission_denied", "Directory /etc is not readable"));
    render(<RepositoriesView />);
    await screen.findByLabelText("Enable repository core");
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    expect(screen.getByText("Directory /etc is not readable")).toBeInTheDocument();
  });

  it("shows maintenance warnings alongside a successful repository save", async () => {
    mockSaveRepos.mockResolvedValue({ success: true, backup_path: null, message: "Saved", revision: "saved-revision", warnings: ["Backup provenance could not be saved"] });
    render(<RepositoriesView />);
    fireEvent.click(await screen.findByLabelText("Enable repository core"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save Changes" })); });
    expect(screen.getByRole("heading", { name: "Repositories saved" })).toBeInTheDocument();
    expect(screen.getByText("Backup provenance could not be saved")).toBeInTheDocument();
  });

  it("retains restore and listing warnings and reloads the repository revision", async () => {
    mockListRepoBackups.mockResolvedValue({
      backups: [{ timestamp: 100, date: "1970-01-01", repo_count: 2, enabled_count: 2, size: 200, source: "manual" }],
      warnings: ["One backup could not be read"],
    });
    mockRestoreRepoBackup.mockResolvedValue({ success: true, backup_path: "/etc/pacman.conf.backup.101", message: "Restored", warnings: ["Old backup could not be pruned"] });
    mockListRepos.mockResolvedValueOnce(mockRepoResponse).mockResolvedValue({ ...mockRepoResponse, revision: "restored-revision" });
    render(<RepositoriesView />);
    await screen.findByLabelText("Enable repository core");
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    expect(screen.getByText("One backup could not be read")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = screen.getByRole("dialog", { name: "Restore pacman.conf backup" });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Restore" })); });
    expect(screen.getByText("Old backup could not be pruned")).toBeInTheDocument();
    expect(screen.getByText("One backup could not be read")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Enable repository core"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save Changes" })); });
    expect(mockSaveRepos.mock.lastCall?.[1]).toBe("restored-revision");
  });

  it("shows backup deletion warnings after reloading the history", async () => {
    mockListRepoBackups.mockResolvedValue({ backups: [{ timestamp: 100, date: "1970-01-01", repo_count: 2, enabled_count: 2, size: 200, source: "manual" }], warnings: [] });
    mockDeleteRepoBackup.mockResolvedValue({ success: true, backup_path: null, message: "Deleted", warnings: ["Backup provenance could not be saved"] });
    render(<RepositoriesView />);
    await screen.findByLabelText("Enable repository core");
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    await act(async () => { fireEvent.click(screen.getByLabelText("Delete backup from 1970-01-01")); });
    expect(mockDeleteRepoBackup).toHaveBeenCalledWith(100);
    expect(screen.getByText("Backup provenance could not be saved")).toBeInTheDocument();
  });

  it("selecting SigLevel Never prompts and does not apply until confirmed", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[extra]")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("SigLevel for extra"), {
        target: { value: "Never" },
      });
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The open modal makes the page inert, so query the (hidden) Save button.
    expect(
      screen.getByRole("button", { name: /Save Changes/i, hidden: true }),
    ).toBeDisabled();
  });

  it("confirming SigLevel Never applies it and saves", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[extra]")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("SigLevel for extra"), {
        target: { value: "Never" },
      });
    });

    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use Never anyway" }));
    });

    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    expect(saveButton).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(mockSaveRepos).toHaveBeenCalledTimes(1);
    });
    const savedRepos = mockSaveRepos.mock.calls[0][0];
    expect(savedRepos.find((r) => r.name === "extra")?.sig_level).toBe("Never");
  });

  it("cancelling the SigLevel Never prompt leaves the prior value", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[extra]")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("SigLevel for extra"), {
        target: { value: "Never" },
      });
    });

    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Changes/i })).toBeDisabled();
  });

  it("typing in search with no unsaved changes applies filter immediately without a modal", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search repositories...");
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "core" } });
    });

    expect(screen.getByText("[core]")).toBeInTheDocument();
    expect(screen.queryByText("[extra]")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("typing in search when unsaved changes exist opens a confirmation modal without applying the filter", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });

    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[0]);
    });
    expect(screen.getByRole("button", { name: /Save Changes/i })).not.toBeDisabled();

    const searchInput = screen.getByPlaceholderText("Search repositories...");
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "core" } });
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByText("[extra]")).toBeInTheDocument();
  });

  it("clicking Cancel in the filter-change modal leaves filter and unsaved changes intact", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });

    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    const searchInput = screen.getByPlaceholderText("Search repositories...");
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "core" } });
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("[core]")).toBeInTheDocument();
    expect(screen.getByText("[extra]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Changes/i })).not.toBeDisabled();
  });

  it("clicking 'Discard and switch filter' applies pending filter and clears unsaved changes", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });

    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[0]);
    });

    const searchInput = screen.getByPlaceholderText("Search repositories...");
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "core" } });
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    const discardButton = within(dialog).getByRole("button", { name: /discard and switch filter/i });
    await act(async () => {
      fireEvent.click(discardButton);
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("[extra]")).not.toBeInTheDocument();
    });
    expect(screen.getByText("[core]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Changes/i })).toBeDisabled();
  });
});

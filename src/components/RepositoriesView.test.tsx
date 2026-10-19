import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { RepositoriesView, addInsertion } from "./RepositoriesView";
import * as api from "../api";
import type { ListReposResponse } from "../api";
import { mockLocationGo, mockPermission } from "../test/setup";
import { sweepA11y } from "../test/a11ySweep";
import { TabActiveContext } from "../hooks/useRefreshOnActivate";


function configurationResult<T extends { backup_path: string | null }>(result: T) {
  return { warnings: [] as string[], revision: "saved-revision", backup_timestamp: result.backup_path ? Number(result.backup_path.split(".").slice(-1)[0]) : null, ...result };
}

const fileWatchers = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../systemWatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../systemWatch")>()),
  watchFile: vi.fn((path: string, onChange: () => void) => {
    fileWatchers.set(path, onChange);
    return { close: () => fileWatchers.delete(path) };
  }),
}));

const announceSpy = vi.hoisted(() => vi.fn());
vi.mock("../contexts/AnnouncerContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contexts/AnnouncerContext")>()),
  useAnnounce: () => announceSpy,
}));

const changeOutside = (path = "/etc/pacman.conf") => act(async () => {
  fileWatchers.get(path)?.();
});

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listRepos: vi.fn(),
    saveRepos: vi.fn(),
    listRepoBackups: vi.fn(),
    deleteRepoBackup: vi.fn(),
    restoreRepoBackup: vi.fn(),
    undoRepoSave: vi.fn(),
    listInstalled: vi.fn(),
    receiveKey: vi.fn(),
    lsignKey: vi.fn(),
    getActiveTransaction: vi.fn(() => null),
    onActiveTransactionChanged: vi.fn(() => () => {}),
  };
});

const mockListRepos = vi.mocked(api.listRepos);
const mockSaveRepos = vi.mocked(api.saveRepos);
const mockListRepoBackups = vi.mocked(api.listRepoBackups);
const mockDeleteRepoBackup = vi.mocked(api.deleteRepoBackup);
const mockUndoRepoSave = vi.mocked(api.undoRepoSave);
const mockRestoreRepoBackup = vi.mocked(api.restoreRepoBackup);
const mockGetActiveTransaction = vi.mocked(api.getActiveTransaction);
const mockListInstalled = vi.mocked(api.listInstalled);
const mockReceiveKey = vi.mocked(api.receiveKey);
const mockLsignKey = vi.mocked(api.lsignKey);

const mockRepoResponse: ListReposResponse = { not_synced: [],
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
  revision: "rev-1",
};

describe("RepositoriesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUndoRepoSave.mockResolvedValue({ success: true, revision: "undo-revision", backup_timestamp: null, backup_path: null, warnings: [] });
    mockListRepos.mockResolvedValue(mockRepoResponse);
    mockSaveRepos.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Saved" }));
    mockGetActiveTransaction.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    mockPermission.mockReset();
    vi.mocked(api.onActiveTransactionChanged).mockReset();
  });

  it("preserves backend details when backup history fails", async () => {
    mockListRepoBackups.mockRejectedValue(new api.BackendError("Backups could not be read", "permission_denied", "Directory /etc is not readable"));
    render(<RepositoriesView />);
    await screen.findByLabelText("Enable repository core");
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    expect(screen.getByText("Directory /etc is not readable")).toBeInTheDocument();
  });

  it("keeps backup maintenance warnings visible after a successful save", async () => {
    mockSaveRepos.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Saved", warnings: ["Backup provenance could not be saved"] }));
    render(<RepositoriesView />);
    fireEvent.click(await screen.findByLabelText("Enable repository core"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Save changes/i })); });
    expect(screen.getByRole("heading", { name: /Saved \/etc\/pacman.conf/ })).toBeInTheDocument();
    expect(screen.getByText("Backup provenance could not be saved")).toBeInTheDocument();
  });

  it("preserves restore and listing warnings and checks Undo against the restored revision", async () => {
    mockListRepoBackups.mockResolvedValue({ backups: [{ timestamp: 100, date: "1970-01-01", repo_count: 2, enabled_count: 2, size: 200, source: "manual" }], warnings: ["One backup could not be read"] });
    mockRestoreRepoBackup.mockResolvedValue(configurationResult({ success: true, backup_path: "/etc/pacman.conf.backup.101", message: "Restored", revision: "restored-revision", warnings: ["Old backup could not be pruned"] }));
    render(<RepositoriesView />);
    await screen.findByLabelText("Enable repository core");
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restore" })); });
    expect(screen.getByText("Old backup could not be pruned")).toBeInTheDocument();
    expect(screen.getByText("One backup could not be read")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(mockUndoRepoSave).toHaveBeenCalledWith(101, "restored-revision");
  });

  it("keeps deletion warnings after the backup history reloads", async () => {
    mockListRepoBackups.mockResolvedValue({ backups: [{ timestamp: 100, date: "1970-01-01", repo_count: 2, enabled_count: 2, size: 200, source: "manual" }], warnings: [] });
    mockDeleteRepoBackup.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Deleted", warnings: ["Backup provenance could not be saved"] }));
    render(<RepositoriesView />);
    await screen.findByLabelText("Enable repository core");
    await act(async () => { fireEvent.click(screen.getByText("Backup history")); });
    fireEvent.click(screen.getByRole("button", { name: "Delete backup from 1970-01-01" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete backup from 1970-01-01" })); });
    expect(mockDeleteRepoBackup).toHaveBeenCalledWith(100);
    expect(screen.getByText("Backup provenance could not be saved")).toBeInTheDocument();
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

  it("offers SigLevel help as a named button", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    expect(screen.getAllByRole("button", { name: /^More information about/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "More information about signature levels" }));
    expect(await screen.findByText(/TrustedOnly: must be signed by a key in the local keyring/)).toBeInTheDocument();
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
      expect(screen.getByText(/Could not load repositories/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when repos array is empty", async () => {
    mockListRepos.mockResolvedValue({ not_synced: [], repos: [], revision: "rev-1" });
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
    expect(saveButton).toHaveAttribute("aria-disabled", "true");
    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[0]);
    });
    expect(saveButton).not.toHaveAttribute("aria-disabled", "true");
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
    const searchInput = screen.getByPlaceholderText("Search repositories…");
    fireEvent.change(searchInput, { target: { value: "core" } });
    expect(screen.getByText("[core]")).toBeInTheDocument();
    expect(screen.queryByText("[extra]")).not.toBeInTheDocument();
  });

  it("names Move up and Move down by repository, disabled at the ends", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Move [core] up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move [extra] down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move [core] down" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move [extra] up" })).toBeEnabled();
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

  it("passes the a11y sweep on the repository list", async () => {
    render(<RepositoriesView />);
    await screen.findByText("[extra]");
    sweepA11y();
  });

  it("selecting SigLevel Never shows the inline acknowledgement and blocks Save until it is ticked", async () => {
    render(<RepositoriesView />);
    await screen.findByText("[extra]");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("SigLevel for extra"), {
        target: { value: "Never" },
      });
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Disable signature verification\?/ })).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /Save changes/i });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAccessibleDescription("Confirm SigLevel = Never for [extra] first");
    sweepA11y();

    fireEvent.click(screen.getByRole("checkbox", { name: "Use Never for [extra] anyway" }));
    expect(save).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(1));
    expect(mockSaveRepos.mock.calls[0][0].find((r) => r.name === "extra")?.sig_level).toBe("Never");
  });

  it("a different insecure value needs its own acknowledgement, and a safe value needs none", async () => {
    render(<RepositoriesView />);
    await screen.findByText("[extra]");
    const select = screen.getByLabelText("SigLevel for extra");

    await act(async () => {
      fireEvent.change(select, { target: { value: "Never" } });
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use Never for [extra] anyway" }));
    await act(async () => {
      fireEvent.change(select, { target: { value: "__custom__" } });
    });
    const input = screen.getByLabelText("Custom SigLevel for extra");
    fireEvent.change(input, { target: { value: "TrustAll" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByRole("checkbox", { name: "Use TrustAll for [extra] anyway" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /Save changes/i })).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("SigLevel for extra"), { target: { value: "Required" } });
    });
    expect(screen.queryByRole("heading", { name: /Disable signature verification\?/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/i })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("typing in search with no unsaved changes applies filter immediately without a modal", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search repositories…");
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "core" } });
    });

    expect(screen.getByText("[core]")).toBeInTheDocument();
    expect(screen.queryByText("[extra]")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("filtering while dirty opens no dialog, and hidden dirty rows are still saved", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });

    const switches = screen.getAllByRole("switch");
    await act(async () => {
      fireEvent.click(switches[1]);
    });

    const searchInput = screen.getByPlaceholderText("Search repositories…");
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "core" } });
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("[extra]")).not.toBeInTheDocument();
    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    expect(saveButton).not.toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      fireEvent.click(saveButton);
    });
    await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(1));
    const saved = mockSaveRepos.mock.calls[0][0];
    expect(saved.find((r) => r.name === "extra")?.enabled).toBe(false);
  });

  it("a saveRepos rejection keeps the table and the edits and offers Try again", async () => {
    mockSaveRepos.mockRejectedValueOnce(new Error("disk full"));
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getAllByRole("switch")[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });

    const tryAgain = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("heading", { name: /Repositories not saved/ })).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Repository list" })).toBeInTheDocument();
    expect(screen.getAllByRole("switch")[0]).not.toBeChecked();
    expect(screen.getByRole("button", { name: /Save Changes/i })).not.toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      fireEvent.click(tryAgain);
    });
    await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(2));
    expect(mockSaveRepos.mock.calls[1][0][0].enabled).toBe(false);
  });

  it("an invalid new Server value shows helper text and cannot be added", async () => {
    render(<RepositoriesView />);
    await waitFor(() => {
      expect(screen.getByText("[core]")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expand extra" }));
    });

    const input = screen.getByRole("textbox", { name: "New directive value" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "mirror.example.org/extra" } });
    });

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/URL/);
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();

    await act(async () => {
      fireEvent.change(input, { target: { value: "https://mirror.example.org/$repo/os/$arch" } });
    });
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled();
  });

  describe("saving", () => {
    const loaded = async () => {
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());
    };
    const toggleCore = () => act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Enable repository core" }));
    });
    const save = () => act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });

    it("sends the loaded revision and returns to the table with a success alert and Undo", async () => {
      mockSaveRepos.mockResolvedValue(configurationResult({
        success: true,
        backup_path: "/etc/pacman.conf.backup.1704067200",
        backup_timestamp: 1704067200,
        message: "Saved",
        revision: "rev-2",
      }));
      mockRestoreRepoBackup.mockResolvedValue(configurationResult({ success: true, backup_path: "/etc/pacman.conf.backup.1704067300", message: "Restored" }));
      await loaded();
      await toggleCore();
      await save();

      await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(1));
      expect(mockSaveRepos.mock.calls[0][1]).toEqual("rev-1");
      expect(await screen.findByRole("heading", { name: /Saved \/etc\/pacman.conf/ })).toBeInTheDocument();
      expect(screen.getByRole("grid", { name: "Repository list" })).toBeInTheDocument();
      expect(mockListRepos).toHaveBeenCalledTimes(2);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      await waitFor(() => expect(mockUndoRepoSave).toHaveBeenCalledWith(1704067200, "rev-2"));
      expect(await screen.findByRole("heading", { name: /Undid the \/etc\/pacman.conf change/ })).toBeInTheDocument();
    });

    it("a second save sends the revision the first save reloaded", async () => {
      mockListRepos
        .mockResolvedValueOnce(mockRepoResponse)
        .mockResolvedValue({ ...mockRepoResponse, revision: "rev-2" });
      await loaded();
      await toggleCore();
      await save();
      await screen.findByRole("heading", { name: /Saved \/etc\/pacman.conf/ });

      await toggleCore();
      await save();
      await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(2));
      expect(mockSaveRepos.mock.calls[1][1]).toEqual("rev-2");
    });

    it("lists up to five pending changes expanded, and Discard can be undone without a read", async () => {
      await loaded();
      await toggleCore();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Move [core] down" }));
      });

      expect(screen.getByRole("button", { name: "Pending changes (2)" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Disable [core]")).toBeVisible();
      expect(screen.getByText(/^Move \[(core|extra)\] (above|below) \[(core|extra)\]$/)).toBeVisible();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
      });
      expect(mockListRepos).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: /Pending changes/ })).not.toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Enable repository core" })).toBeChecked();
      expect(screen.getByRole("button", { name: /Save Changes/i })).toHaveAttribute("aria-disabled", "true");
      const discarded = screen.getByRole("heading", { name: /Changes discarded/ });
      expect(discarded.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      expect(screen.getByRole("switch", { name: "Enable repository core" })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Pending changes (2)" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Changes discarded/ })).not.toBeInTheDocument();
    });

    it("marks an edited row and reverts that row alone", async () => {
      await loaded();
      await toggleCore();
      await act(async () => {
        fireEvent.click(screen.getByRole("switch", { name: "Enable repository extra" }));
      });
      expect(screen.getAllByText("Edited")).toHaveLength(2);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Revert changes to [core]" }));
      });
      expect(screen.getByRole("switch", { name: "Enable repository core" })).toBeChecked();
      expect(screen.getByRole("switch", { name: "Enable repository extra" })).not.toBeChecked();
      expect(screen.getAllByText("Edited")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Pending changes (1)" })).toBeInTheDocument();
    });

    it("shows the changed section as text before saving", async () => {
      await loaded();
      await toggleCore();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "View result as text" }));
      });
      const code = document.querySelector(".pf-v6-c-code-block__code");
      expect(code?.textContent).toBe(
        "#[core]\n#SigLevel = Required DatabaseOptional\n#Include = /etc/pacman.d/mirrorlist",
      );
    });

    it("locks the table while the save is in flight", async () => {
      let finish: (() => void) | undefined;
      mockSaveRepos.mockImplementationOnce(() => new Promise((resolve) => {
        finish = () => resolve(configurationResult({ success: true, backup_path: null, message: "Saved" }));
      }));
      await loaded();
      await toggleCore();
      await save();

      const extra = screen.getByRole("switch", { name: "Enable repository extra" });
      expect(extra).toHaveAttribute("aria-disabled", "true");
      expect(extra).toHaveAccessibleDescription("/etc/pacman.conf is being written");
      expect(screen.getByRole("combobox", { name: "SigLevel for core" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: "Move [core] down" })).toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        fireEvent.click(extra);
      });
      expect(extra).toBeChecked();

      await act(async () => {
        finish?.();
      });
      await screen.findByRole("heading", { name: /Saved \/etc\/pacman.conf/ });
      expect(screen.getByRole("switch", { name: "Enable repository extra" })).not.toHaveAttribute("aria-disabled");
    });

    it("toggling a repo back clears the pending state", async () => {
      await loaded();
      await toggleCore();
      await toggleCore();
      expect(screen.queryByRole("button", { name: /Pending changes/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Save Changes/i })).toHaveAttribute("aria-disabled", "true");
    });

    it("blocks Save with a reason when no enabled repository has a source", async () => {
      await loaded();
      await toggleCore();
      await act(async () => {
        fireEvent.click(screen.getByRole("switch", { name: "Enable repository extra" }));
      });

      const button = screen.getByRole("button", { name: /Save Changes/i });
      expect(button).toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        fireEvent.click(button);
      });
      expect(mockSaveRepos).not.toHaveBeenCalled();
    });

    it("blocks Save while a package transaction runs", async () => {
      mockGetActiveTransaction.mockReturnValue({ command: "upgrade", startedAt: Date.now() });
      await loaded();
      await toggleCore();

      const button = screen.getByRole("button", { name: /Save Changes/i });
      expect(button).toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        fireEvent.focus(button);
        fireEvent.mouseEnter(button);
      });
      expect(await screen.findByRole("tooltip")).toHaveTextContent("An upgrade is running.");
    });

    it("keeps focus on Save while the registry and permission flip", async () => {
      let notifyTransaction: (() => void) | undefined;
      vi.mocked(api.onActiveTransactionChanged).mockImplementation((listener) => {
        notifyTransaction = () => listener(api.getActiveTransaction());
        return () => {};
      });
      const permission = {
        allowed: true as boolean | null,
        listener: null as (() => void) | null,
        addEventListener: vi.fn((_event: string, fn: () => void) => { permission.listener = fn; }),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      };
      mockPermission.mockImplementation(() => permission);
      await loaded();
      await toggleCore();
      const button = screen.getByRole("button", { name: /Save Changes/i });
      act(() => button.focus());
      expect(button).not.toHaveAttribute("aria-disabled", "true");

      mockGetActiveTransaction.mockReturnValue({ command: "upgrade", startedAt: Date.now() });
      act(() => notifyTransaction?.());
      expect(button).toHaveAccessibleDescription("An upgrade is running.");
      expect(document.activeElement).toBe(button);

      mockGetActiveTransaction.mockReturnValue(null);
      act(() => notifyTransaction?.());
      expect(button).not.toHaveAttribute("aria-disabled", "true");
      expect(document.activeElement).toBe(button);

      act(() => {
        permission.allowed = null;
        permission.listener?.();
      });
      expect(button).toHaveAccessibleDescription("Checking administrative access…");
      expect(document.activeElement).toBe(button);
      act(() => {
        permission.allowed = true;
        permission.listener?.();
      });
      expect(button).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: /Save Changes/i })).toBe(button);
      expect(document.activeElement).toBe(button);
    });

    it("gates backup delete on the mutation gate", async () => {
      mockGetActiveTransaction.mockReturnValue({ command: "upgrade", startedAt: Date.now() });
      mockListRepoBackups.mockResolvedValue({ warnings: [],
        backups: [{ timestamp: 1704067200, date: "2024-01-01 00:00:00", repo_count: 3, enabled_count: 2, size: 4096, source: "manual" as const }],
      });
      await loaded();
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      const del = await screen.findByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" });
      expect(del).toHaveAttribute("aria-disabled", "true");
      expect(del).toHaveAccessibleDescription("An upgrade is running.");
      await act(async () => { fireEvent.click(del); });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("dates backups with a focusable relative time under Date", async () => {
      mockListRepoBackups.mockResolvedValue({ warnings: [],
        backups: [{ timestamp: 1704067200, date: "2024-01-01 00:00:00", repo_count: 3, enabled_count: 2, size: 4096, source: "manual" as const }],
      });
      await loaded();
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      const del = await screen.findByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" });
      const table = del.closest("table")!;
      expect(within(table).getByRole("columnheader", { name: "Date" })).toBeInTheDocument();
      expect(within(table).queryByRole("columnheader", { name: "Created" })).not.toBeInTheDocument();
      const time = table.querySelector("time")!;
      expect(time).toHaveAttribute("datetime", new Date(1704067200 * 1000).toISOString());
      expect(time).toHaveAttribute("tabindex", "0");
      expect(within(table).queryByText("2024-01-01 00:00:00")).not.toBeInTheDocument();
    });

    const withMultilib: ListReposResponse = { not_synced: [],
      repos: [
        ...mockRepoResponse.repos,
        { name: "multilib", enabled: true, sig_level: null, directives: [{ directive_type: "Include", value: "/etc/pacman.d/mirrorlist", enabled: true }] },
      ],
      revision: "rev-2",
    };

    it("an outside edit keeps the edits and shows the outside change before an overwrite", async () => {
      mockSaveRepos.mockRejectedValueOnce(
        new api.BackendError("/etc/pacman.conf changed outside this editor", "config_changed"),
      );
      await loaded();
      await toggleCore();
      await save();

      expect(await screen.findByRole("heading", { name: /\/etc\/pacman.conf changed since you started editing/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Enable repository core" })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Reload and reapply my 1 change" })).toBeInTheDocument();

      mockListRepos.mockResolvedValueOnce(withMultilib);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save my version anyway" }));
      });
      const dialog = screen.getByRole("dialog", { name: /Replace pacman.conf\?/ });
      expect(await within(dialog).findByText("Add [multilib]")).toBeInTheDocument();
      expect(mockSaveRepos).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Replace pacman.conf" }));
      });
      await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(2));
      expect(mockSaveRepos.mock.calls[1][0][0].enabled).toBe(false);
      expect(mockSaveRepos.mock.calls[1][1]).toEqual("rev-2");
    });

    it("reapplies the edits on the reread file and saves against its revision", async () => {
      mockSaveRepos.mockRejectedValueOnce(new api.BackendError("changed", "config_changed"));
      await loaded();
      await toggleCore();
      await save();
      mockListRepos.mockResolvedValue({
        ...withMultilib,
        repos: withMultilib.repos.map((r) => (r.name === "extra" ? { ...r, sig_level: "Required" } : r)),
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Reload and reapply my 1 change" }));
      });

      expect(mockListRepos).toHaveBeenCalledTimes(2);
      expect(await screen.findByRole("heading", { name: /Reapplied 1 change to the current file/ })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /changed since you started editing/ })).not.toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Enable repository core" })).not.toBeChecked();
      expect(screen.getByText("[multilib]")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pending changes (1)" })).toBeInTheDocument();

      mockSaveRepos.mockResolvedValueOnce(configurationResult({ success: true, backup_path: null, message: "Saved" }));
      await save();
      await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(2));
      expect(mockSaveRepos.mock.calls[1][1]).toEqual("rev-2");
      expect(mockSaveRepos.mock.calls[1][0].map((r: api.RepoEntry) => [r.name, r.enabled, r.sig_level])).toEqual([
        ["core", false, "Required DatabaseOptional"],
        ["extra", true, "Required"],
        ["multilib", true, null],
      ]);
    });

    it("rebases a pending toggle on an outside change, keeps focus and saves against the new revision", async () => {
      await loaded();
      await toggleCore();
      const coreSwitch = screen.getByRole("switch", { name: "Enable repository core" });
      coreSwitch.focus();
      mockListRepos.mockResolvedValue(withMultilib);
      await changeOutside();

      expect(await screen.findByRole("heading", { name: /pacman.conf changed since you started editing/ })).toBeInTheDocument();
      expect(screen.getByText(/Your 1 change was reapplied/)).toBeInTheDocument();
      expect(screen.getByText("[multilib]")).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Enable repository core" })).not.toBeChecked();
      expect(document.activeElement).toBe(coreSwitch);
      expect(screen.getByRole("button", { name: "Pending changes (1)" })).toBeInTheDocument();

      await save();
      await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(1));
      expect(mockSaveRepos.mock.calls[0][1]).toEqual("rev-2");
      expect(mockSaveRepos.mock.calls[0][0].map((r: api.RepoEntry) => [r.name, r.enabled])).toEqual([
        ["core", false],
        ["extra", true],
        ["multilib", true],
      ]);
    });

    it("an echo of its own save leaves the view and later edits alone", async () => {
      const saved: ListReposResponse = { not_synced: [],
        repos: mockRepoResponse.repos.map((r) => (r.name === "core" ? { ...r, enabled: false } : r)),
        revision: "rev-2",
      };
      mockSaveRepos.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Saved", revision: "rev-2" }));
      await loaded();
      await toggleCore();
      mockListRepos.mockResolvedValue(saved);
      await save();
      expect(await screen.findByRole("heading", { name: /Saved \/etc\/pacman.conf/ })).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("switch", { name: "Enable repository extra" }));
      });

      await changeOutside();
      expect(screen.queryByRole("heading", { name: /changed since you started editing/ })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Saved \/etc\/pacman.conf/ })).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Enable repository extra" })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Pending changes (1)" })).toBeInTheDocument();
    });

    it("a failed outside reread keeps the table, the edit and the revision", async () => {
      await loaded();
      await toggleCore();
      mockListRepos.mockRejectedValueOnce(new Error("read failed"));
      await changeOutside();

      const heading = await screen.findByRole("heading", { name: /Could not refresh pacman.conf/ });
      expect(heading.closest(".pf-v6-c-alert")).toHaveTextContent("Your 1 unsaved change is still here");
      expect(screen.queryByText(/Could not load repositories/)).not.toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Enable repository core" })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Pending changes (1)" })).toBeInTheDocument();

      await save();
      expect(mockSaveRepos).toHaveBeenLastCalledWith(expect.any(Array), "rev-1");
    });

    it("Try again after a failed outside reread rebases the edit on the file as it is now", async () => {
      await loaded();
      await toggleCore();
      mockListRepos.mockRejectedValueOnce(new Error("read failed"));
      await changeOutside();
      mockListRepos.mockResolvedValue({ not_synced: [],
        repos: [...mockRepoResponse.repos, { name: "multilib", enabled: true, sig_level: null, directives: [
          { directive_type: "Include", value: "/etc/pacman.d/mirrorlist", enabled: true },
        ] }],
        revision: "rev-2",
      } as ListReposResponse);
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      });

      expect(await screen.findByRole("heading", { name: /pacman.conf changed since you started editing/ })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Could not refresh/ })).not.toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Enable repository core" })).not.toBeChecked();
      expect(screen.getByText("[multilib]")).toBeInTheDocument();
      await save();
      expect(mockSaveRepos).toHaveBeenLastCalledWith(expect.any(Array), "rev-2");
    });

    it("an outside change with no edits shows a notice naming possible sources, announced once", async () => {
      await loaded();
      mockListRepos.mockResolvedValue({ not_synced: [],
        repos: mockRepoResponse.repos.map((r) => (r.name === "extra" ? { ...r, enabled: false } : r)),
        revision: "rev-2",
      });
      announceSpy.mockClear();
      await changeOutside();

      const heading = await screen.findByRole("heading", { name: /pacman.conf changed at/ });
      const alert = heading.closest(".pf-v6-c-alert") as HTMLElement;
      expect(alert).toHaveTextContent("IgnorePkg from Updates");
      expect(announceSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("switch", { name: "Enable repository extra" })).not.toBeChecked();
      await act(async () => {
        fireEvent.click(within(alert).getByRole("button", { name: "Show changes" }));
      });
      expect(within(alert).getByText("Disable [extra]")).toBeVisible();
      expect(announceSpy).toHaveBeenCalledTimes(1);
    });

    it("an outside change after a save removes Undo", async () => {
      mockSaveRepos.mockResolvedValue(configurationResult({
        success: true,
        backup_path: "/etc/pacman.conf.backup.1704067200",
        backup_timestamp: 1704067200,
        message: "Saved",
      }));
      await loaded();
      await toggleCore();
      await save();
      expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();

      mockListRepos.mockResolvedValue({ ...mockRepoResponse, revision: "rev-3" });
      await changeOutside();
      await screen.findByRole("heading", { name: /pacman.conf changed at/ });
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
      expect(mockRestoreRepoBackup).not.toHaveBeenCalled();
    });

    it("names the edits that no longer apply after a reapply", async () => {
      mockSaveRepos.mockRejectedValueOnce(new api.BackendError("changed", "config_changed"));
      await loaded();
      await toggleCore();
      await save();
      mockListRepos.mockResolvedValue({ not_synced: [], repos: mockRepoResponse.repos.slice(1), revision: "rev-2" });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Reload and reapply my 1 change" }));
      });

      expect(await screen.findByRole("heading", { name: /1 change no longer applies/ })).toBeInTheDocument();
      expect(screen.getByText("Changes to [core]: it was removed since you started editing")).toBeInTheDocument();
      expect(screen.queryByText("[core]")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Pending changes/ })).not.toBeInTheDocument();
    });
  });

  describe("restore", () => {
    const backupList = { warnings: [],
      backups: [
        { timestamp: 1704067200, date: "2024-01-01 00:00:00", repo_count: 3, enabled_count: 2, size: 4096, source: "manual" as const },
      ],
    };

    const openBackups = async () => {
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      return screen.findByRole("button", { name: "Restore" });
    };

    beforeEach(() => {
      mockListRepoBackups.mockResolvedValue(backupList);
      mockRestoreRepoBackup.mockResolvedValue(configurationResult({
        success: true,
        backup_path: "/etc/pacman.conf.backup.1704067300",
        message: "Restored",
      }));
    });

    it("restores without a dialog when there are no edits and offers Undo", async () => {
      const restore = await openBackups();
      await act(async () => {
        fireEvent.click(restore);
      });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await waitFor(() => expect(mockRestoreRepoBackup).toHaveBeenCalledWith(1704067200));
      expect(await screen.findByRole("heading", { name: /Restored \/etc\/pacman.conf from 2024-01-01 00:00:00/ })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      await waitFor(() => expect(mockUndoRepoSave).toHaveBeenCalledWith(1704067300, "saved-revision"));
    });

    it("names the edits a restore would drop before running it", async () => {
      const restore = await openBackups();
      await act(async () => {
        fireEvent.click(screen.getByRole("switch", { name: "Enable repository core" }));
      });
      await act(async () => {
        fireEvent.click(restore);
      });

      const dialog = screen.getByRole("dialog", { name: /Restore pacman.conf backup\?/ });
      expect(within(dialog).getByText("Disable [core]")).toBeInTheDocument();
      expect(mockRestoreRepoBackup).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes and restore" }));
      });
      await waitFor(() => expect(mockRestoreRepoBackup).toHaveBeenCalledWith(1704067200));
    });
  });

  it("a failed restore shows above the table with Try again", async () => {
    mockListRepoBackups.mockResolvedValue({ warnings: [],
      backups: [{ timestamp: 1704067200, date: "2024-01-01 00:00:00", repo_count: 3, enabled_count: 2, size: 4096, source: "manual" as const }],
    });
    mockRestoreRepoBackup.mockRejectedValueOnce(new Error("backup is unreadable"));
    render(<RepositoriesView />);
    await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText("Backup history"));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    });

    const alert = (await screen.findByRole("heading", { name: /\/etc\/pacman.conf not restored/ })).closest(".pf-v6-c-alert") as HTMLElement;
    expect(alert).toHaveTextContent("backup is unreadable");
    mockRestoreRepoBackup.mockResolvedValueOnce(configurationResult({ success: true, backup_path: null, message: "Restored" }));
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    });
    expect(mockRestoreRepoBackup).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("heading", { name: /Restored \/etc\/pacman.conf from 2024-01-01/ })).toBeInTheDocument();
  });

  describe("backups", () => {
    const backupList = { warnings: [],
      backups: [
        { timestamp: 1704067200, date: "2024-01-01 00:00:00", repo_count: 3, enabled_count: 2, size: 4096, source: "manual" as const },
      ],
    };

    it("reloads quietly on activation and refreshes an open backup list", async () => {
      mockListRepoBackups.mockResolvedValue(backupList);
      const { rerender } = render(
        <TabActiveContext.Provider value={true}><RepositoriesView /></TabActiveContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      await screen.findByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" });
      expect(mockListRepoBackups).toHaveBeenCalledTimes(1);

      rerender(<TabActiveContext.Provider value={false}><RepositoriesView /></TabActiveContext.Provider>);
      expect(fileWatchers.has("/etc/pacman.conf")).toBe(false);
      mockListRepos.mockResolvedValue({ not_synced: [],
        repos: [...mockRepoResponse.repos, { name: "multilib", enabled: true, sig_level: null, directives: [] }],
        revision: "rev-2",
      });
      await act(async () => {
        rerender(<TabActiveContext.Provider value={true}><RepositoriesView /></TabActiveContext.Provider>);
      });

      expect(await screen.findByText("[multilib]")).toBeInTheDocument();
      expect(screen.queryByText(/Loading repositories/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /changed since you started editing/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Pending changes/ })).not.toBeInTheDocument();
      await waitFor(() => expect(mockListRepoBackups).toHaveBeenCalledTimes(2));
    });

    it("a backup delete spawns nothing until the named confirm button is pressed", async () => {
      mockListRepoBackups.mockResolvedValue(backupList);
      mockDeleteRepoBackup.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Deleted" }));
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      const trash = await screen.findByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" });
      await act(async () => {
        fireEvent.click(trash);
      });

      const dialog = screen.getByRole("dialog", { name: /Delete pacman.conf backup\?$/ });
      sweepA11y({ dialogs: [/Delete pacman.conf backup\?$/] });
      expect(mockDeleteRepoBackup).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" }));
      });
      await waitFor(() => expect(mockDeleteRepoBackup).toHaveBeenCalledWith(1704067200));
    });

    it("names each backup checkbox by its date", async () => {
      mockListRepoBackups.mockResolvedValue({ warnings: [],
        backups: [
          ...backupList.backups,
          { timestamp: 1704063600, date: "2023-12-31 23:00:00", repo_count: 3, enabled_count: 3, size: 4096, source: "auto" as const },
        ],
      });
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      const box = await screen.findByRole("checkbox", { name: "Select backup from 2023-12-31 23:00:00" });
      expect(screen.getAllByRole("checkbox", { name: "Select backup from 2024-01-01 00:00:00" })).toHaveLength(1);
      const rows = screen.getAllByRole("checkbox").filter((b) => b.closest("tbody"));
      expect(new Set(rows.map((b) => b.getAttribute("name"))).size).toBe(rows.length);
      expect(screen.queryAllByRole("checkbox", { name: /^Select row \d+$/ })).toHaveLength(0);
      await act(async () => {
        fireEvent.click(box);
      });
      expect(screen.getByRole("button", { name: "Delete (1)" })).toBeInTheDocument();
      sweepA11y();
    });

    it("bulk-selects backups and deletes them after a named confirm", async () => {
      mockListRepoBackups.mockResolvedValue({ warnings: [],
        backups: [
          ...backupList.backups,
          { timestamp: 1704063600, date: "2023-12-31 23:00:00", repo_count: 3, enabled_count: 3, size: 4096, source: "auto" as const },
        ],
      });
      mockDeleteRepoBackup.mockResolvedValue(configurationResult({ success: true, backup_path: null, message: "Deleted" }));
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      const bulk = await screen.findByRole("button", { name: "Delete selected" });
      expect(bulk).toHaveAccessibleDescription("Select at least one backup");
      await act(async () => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select all backups" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
      });
      expect(mockDeleteRepoBackup).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete 2 backups" }));
      });
      await waitFor(() => expect(mockDeleteRepoBackup).toHaveBeenCalledTimes(2));
    });

    it("cancelling the delete confirm spawns nothing", async () => {
      mockListRepoBackups.mockResolvedValue(backupList);
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" }));
      });
      await act(async () => {
        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockDeleteRepoBackup).not.toHaveBeenCalled();
    });
  });

  describe("without administrative access", () => {
    beforeEach(() => {
      mockPermission.mockImplementation(() => ({
        allowed: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      }));
    });

    afterEach(() => {
      mockPermission.mockReset();
      mockPermission.mockImplementation(() => ({
        allowed: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      }));
    });

    it("keeps edits allowed and aria-disables Save", async () => {
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getAllByRole("switch")[0]);
      });
      expect(screen.getAllByRole("switch")[0]).not.toBeChecked();

      const save = screen.getByRole("button", { name: /Save Changes/i });
      expect(save).toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        fireEvent.click(save);
      });
      expect(mockSaveRepos).not.toHaveBeenCalled();
    });

    it("lists backups with Restore and Delete gated by the access reason", async () => {
      mockListRepoBackups.mockResolvedValue({ warnings: [],
        backups: [{ timestamp: 1704067200, date: "2024-01-01 00:00:00", repo_count: 3, enabled_count: 2, size: 4096, source: "manual" as const }],
      });
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      expect(mockListRepoBackups).toHaveBeenCalledTimes(1);

      const restore = await screen.findByRole("button", { name: "Restore" });
      expect(restore).toHaveAttribute("aria-disabled", "true");
      expect(restore).toHaveAccessibleDescription("Turn on administrative access to restore pacman.conf");
      const del = screen.getByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" });
      expect(del).toHaveAttribute("aria-disabled", "true");
      expect(del).toHaveAccessibleDescription("Turn on administrative access to delete backups");
      expect(screen.getByRole("button", { name: /^Delete (selected|\()/ }))
        .toHaveAccessibleDescription("Turn on administrative access to delete backups");

      await act(async () => {
        fireEvent.click(restore);
        fireEvent.click(del);
      });
      expect(mockRestoreRepoBackup).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("keeps the listed backups without refetching when admin access is turned on", async () => {
      const permission = {
        allowed: false as boolean | null,
        listener: null as (() => void) | null,
        addEventListener: vi.fn((_event: string, fn: () => void) => { permission.listener = fn; }),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      };
      mockPermission.mockImplementation(() => permission);
      mockListRepoBackups.mockResolvedValue({ warnings: [],
        backups: [{ timestamp: 1704067200, date: "2024-01-01 00:00:00", repo_count: 3, enabled_count: 2, size: 4096, source: "manual" as const }],
      });
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByText("Backup history"));
      });
      const del = await screen.findByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" });
      expect(del).toHaveAttribute("aria-disabled", "true");
      expect(mockListRepoBackups).toHaveBeenCalledTimes(1);

      await act(async () => {
        permission.allowed = true;
        permission.listener?.();
      });
      expect(screen.getByRole("button", { name: "Delete backup from 2024-01-01 00:00:00" })).not.toHaveAttribute("aria-disabled", "true");
      expect(mockListRepoBackups).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/No backups yet/)).not.toBeInTheDocument();
    });
  });

  it("renders a parsed custom SigLevel as the selected value", async () => {
    mockListRepos.mockResolvedValue({ not_synced: [], revision: "rev-1",
      repos: [
        { name: "custom", enabled: true, sig_level: "PackageRequired DatabaseNever", directives: [] },
      ],
    });
    render(<RepositoriesView />);
    await waitFor(() => expect(screen.getByText("[custom]")).toBeInTheDocument());

    expect(screen.getByLabelText("SigLevel for custom")).toHaveDisplayValue(
      "Custom: PackageRequired DatabaseNever",
    );
  });

  it.each([
    "Never",
    "TrustAll",
    "PackageNever",
    "PackageTrustAll",
    "PackageNever DatabaseRequired",
    "PackageTrustAll DatabaseTrustedOnly",
  ])("custom SigLevel %s is held behind the acknowledgement before anything is saved", async (value) => {
    render(<RepositoriesView />);
    await waitFor(() => expect(screen.getByText("[extra]")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("SigLevel for extra"), {
        target: { value: "__custom__" },
      });
    });
    const input = screen.getByLabelText("Custom SigLevel for extra");
    await act(async () => {
      fireEvent.change(input, { target: { value } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(mockSaveRepos).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Save changes/i })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByRole("checkbox", { name: `Use ${value} for [extra] anyway` }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    });
    await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(1));
    expect(mockSaveRepos.mock.calls[0][0].find((r) => r.name === "extra")?.sig_level).toBe(value);
  });

  it.each([
    ["PackageRequired  DatabaseOptional", "PackageRequired DatabaseOptional"],
    ["PackageRequired DatabaseNever", "PackageRequired DatabaseNever"],
    ["PackageRequired DatabaseTrustAll", "PackageRequired DatabaseTrustAll"],
  ])("custom SigLevel %s keeps package verification and commits on blur without a guard", async (inputValue, savedValue) => {
    render(<RepositoriesView />);
    await waitFor(() => expect(screen.getByText("[extra]")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("SigLevel for extra"), {
        target: { value: "__custom__" },
      });
    });
    const input = screen.getByLabelText("Custom SigLevel for extra");
    await act(async () => {
      fireEvent.change(input, { target: { value: inputValue } });
    });
    await act(async () => {
      fireEvent.blur(input);
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("SigLevel for extra")).toHaveDisplayValue(
      `Custom: ${savedValue}`,
    );
    expect(screen.getByRole("button", { name: /Save Changes/i })).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });
    await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(1));
    expect(mockSaveRepos.mock.calls[0][0].find((r) => r.name === "extra")?.sig_level).toBe(savedValue);
  });

  it("'Move to top' on the fourth repo puts it first in the saved order", async () => {
    mockListRepos.mockResolvedValue({ not_synced: [], revision: "rev-1",
      repos: ["core", "extra", "testing", "multilib"].map((name) => ({
        name,
        enabled: true,
        sig_level: null,
        directives: [{ directive_type: "Include", value: "/etc/pacman.d/mirrorlist", enabled: true }],
      })),
    });
    render(<RepositoriesView />);
    await waitFor(() => expect(screen.getByText("[multilib]")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions for multilib" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to top" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    });

    await waitFor(() => expect(mockSaveRepos).toHaveBeenCalledTimes(1));
    expect(mockSaveRepos.mock.calls[0][0].map((r) => r.name)).toEqual([
      "multilib",
      "core",
      "extra",
      "testing",
    ]);
  });

  it("offers 'Clear search' when the search matches no repository", async () => {
    render(<RepositoriesView />);
    await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Search repositories…"), {
        target: { value: "nothing-matches-this" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    });

    expect(screen.getByText("[core]")).toBeInTheDocument();
    expect(screen.getByText("[extra]")).toBeInTheDocument();
  });

  it("'View as text' reads /etc/pacman.conf", async () => {
    const cockpitGlobal = globalThis as unknown as { cockpit: Record<string, unknown> };
    const fileMock = vi.fn(() => ({
      read: vi.fn().mockResolvedValue("[options]\nHoldPkg = pacman glibc\n"),
      close: vi.fn(),
    }));
    cockpitGlobal.cockpit.file = fileMock;
    try {
      render(<RepositoriesView />);
      await waitFor(() => expect(screen.getByText("[core]")).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "View as text" }));
      });
      await waitFor(() => expect(screen.getByText(/HoldPkg = pacman glibc/)).toBeInTheDocument());
      expect(fileMock).toHaveBeenCalledWith("/etc/pacman.conf");
      expect(screen.getByRole("button", { name: "Copy /etc/pacman.conf" })).toBeInTheDocument();
    } finally {
      delete cockpitGlobal.cockpit.file;
    }
  });

  describe("third-party repositories", () => {
    const FPR = "3B94A80E50A477C7C8E44F8A0FA8E1BCB1F1A2C0";
    const withCustom: ListReposResponse = { not_synced: [],
      repos: [
        ...mockRepoResponse.repos,
        {
          name: "chaotic-aur",
          enabled: true,
          sig_level: null,
          directives: [{ directive_type: "Include", value: "/etc/pacman.d/chaotic-mirrorlist", enabled: true }],
        },
        {
          name: "multilib",
          enabled: false,
          sig_level: null,
          directives: [{ directive_type: "Include", value: "/etc/pacman.d/mirrorlist", enabled: true }],
        },
      ],
      revision: "rev-1",
    };
    const saved = configurationResult({
      success: true,
      backup_path: "/etc/pacman.conf.backup.1704067200",
      backup_timestamp: 1704067200,
      message: "Saved",
      revision: "rev-2",
    });

    const openAdd = async () => {
      render(<RepositoriesView />);
      await screen.findByText("[core]");
      fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
      return screen.getByRole("dialog", { name: "Add repository" });
    };

    const fillRepo = (dialog: HTMLElement, name: string, server: string) => {
      fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), { target: { value: name } });
      fireEvent.change(within(dialog).getByRole("textbox", { name: /^Server/ }), { target: { value: server } });
    };

    it("adds a repository after the last enabled one in one save, with Undo", async () => {
      mockListRepos.mockResolvedValue(withCustom);
      mockSaveRepos.mockResolvedValue(saved);
      mockRestoreRepoBackup.mockResolvedValue(configurationResult({ success: true, backup_path: "/etc/pacman.conf.backup.1704067300", message: "Restored" }));
      const dialog = await openAdd();
      expect(within(dialog).getByRole("textbox", { name: /^Name/ })).toHaveFocus();
      expect(within(dialog).getByText(/^Packages from this repository will be trusted for installs and upgrades\./)).toBeInTheDocument();
      expect(within(dialog).queryByRole("heading", { name: /will be trusted/ })).not.toBeInTheDocument();
      sweepA11y({ dialogs: ["Add repository"] });

      fillRepo(dialog, "local-repo", "file:///srv/repo");
      expect(within(dialog).getByText(/after \[chaotic-aur\]/)).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Add [local-repo] to pacman.conf" }));
      });

      expect(mockSaveRepos).toHaveBeenCalledTimes(1);
      const [list, options] = mockSaveRepos.mock.calls[0];
      expect(list.map((r) => r.name)).toEqual(["core", "extra", "chaotic-aur", "local-repo", "multilib"]);
      expect(list[3]).toEqual({
        name: "local-repo",
        enabled: true,
        sig_level: null,
        directives: [{ directive_type: "Server", value: "file:///srv/repo", enabled: true }],
      });
      expect(options).toEqual("rev-1");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: /Added \[local-repo\]$/ })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      });
      await waitFor(() => expect(mockUndoRepoSave).toHaveBeenCalledWith(1704067200, "rev-2"));
    });

    it("previews and writes the same position with a search active and an enabled [repo-name]", async () => {
      mockListRepos.mockResolvedValue({
        ...withCustom,
        repos: [
          ...withCustom.repos.slice(0, 3),
          { name: "repo-name", enabled: true, sig_level: null, directives: [] },
          withCustom.repos[3],
        ],
      });
      mockSaveRepos.mockResolvedValue(saved);
      render(<RepositoriesView />);
      await screen.findByText("[core]");
      fireEvent.change(screen.getByRole("textbox", { name: "Search repositories" }), { target: { value: "core" } });
      fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
      const dialog = screen.getByRole("dialog", { name: "Add repository" });

      fillRepo(dialog, "local-repo", "file:///srv/repo");
      expect(within(dialog).getByText(/after \[chaotic-aur\]/)).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Add [local-repo] to pacman.conf" }));
      });

      const [list] = mockSaveRepos.mock.calls[0];
      expect(list.map((r) => r.name)).toEqual(["core", "extra", "chaotic-aur", "local-repo", "repo-name", "multilib"]);
    });

    it("saves pending edits with the new section and says so", async () => {
      const dialog = await (async () => {
        render(<RepositoriesView />);
        await screen.findByText("[core]");
        fireEvent.click(screen.getByRole("switch", { name: "Enable repository extra" }));
        fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
        return screen.getByRole("dialog", { name: "Add repository" });
      })();
      fillRepo(dialog, "custom", "https://repo.example.org/$repo/$arch");
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Add [custom] and save 1 other change" }));
      });

      const [list] = mockSaveRepos.mock.calls[0];
      expect(list.map((r) => [r.name, r.enabled])).toEqual([["core", true], ["custom", true], ["extra", false]]);
    });

    it("refuses existing, reserved and malformed names before saving", async () => {
      const dialog = await openAdd();
      const name = within(dialog).getByRole("textbox", { name: /^Name/ });
      fireEvent.change(within(dialog).getByRole("textbox", { name: /^Server/ }), { target: { value: "https://x.example/$arch" } });

      for (const [value, problem] of [
        ["core", "[core] is already in pacman.conf"],
        ["options", "[options] is reserved by pacman"],
        ["my repo", "Use letters, digits, hyphens, underscores and periods only"],
      ]) {
        fireEvent.change(name, { target: { value } });
        expect(name).toHaveAccessibleDescription(expect.stringContaining(problem));
        expect(name).toHaveAttribute("aria-invalid", "true");
        const commit = within(dialog).getByRole("button", { name: new RegExp(`^Add \\[${value}\\]`) });
        expect(commit).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(commit);
      }
      expect(mockSaveRepos).not.toHaveBeenCalled();
    });

    it("puts SigLevel Never behind the signature guard", async () => {
      const dialog = await openAdd();
      fillRepo(dialog, "custom", "https://repo.example.org/$arch");
      fireEvent.change(within(dialog).getByRole("combobox", { name: "SigLevel" }), { target: { value: "Never" } });

      expect(within(dialog).getByRole("heading", { name: /Disable signature verification\?/ })).toBeInTheDocument();
      const commit = within(dialog).getByRole("button", { name: "Add [custom] to pacman.conf" });
      expect(commit).toHaveAttribute("aria-disabled", "true");

      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Use Never for [custom] anyway" }));
      await act(async () => {
        fireEvent.click(commit);
      });
      expect(mockSaveRepos.mock.calls[0][0].find((r) => r.name === "custom")?.sig_level).toBe("Never");
    });

    it("fetches the signing key, then signs it before the save from one commit", async () => {
      const order: string[] = [];
      mockReceiveKey.mockResolvedValue({ key: { fingerprint: FPR, uid: "Chaotic AUR <ops@example.org>", created: null, expires: null, trust: "unknown" } });
      mockLsignKey.mockImplementation(async () => {
        order.push("lsign");
        return { key: { fingerprint: FPR, uid: "Chaotic AUR <ops@example.org>", created: null, expires: null, trust: "full" } };
      });
      mockSaveRepos.mockImplementation(async () => {
        order.push("save");
        return saved;
      });
      const dialog = await openAdd();
      fillRepo(dialog, "chaotic", "https://cdn.example.org/$repo/$arch");
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Signing key fingerprint (optional)" }), { target: { value: FPR } });
      expect(within(dialog).getByRole("button", { name: "Add [chaotic] to pacman.conf" })).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Fetch" }));
      });
      expect(mockReceiveKey).toHaveBeenCalledWith(FPR, undefined, expect.any(AbortSignal));
      expect(within(dialog).getByRole("group", { name: "Fetched key" })).toHaveTextContent("Chaotic AUR <ops@example.org>");
      expect(mockLsignKey).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Sign key and add [chaotic]" }));
      });
      expect(mockLsignKey).toHaveBeenCalledWith(FPR, expect.any(AbortSignal));
      expect(order).toEqual(["lsign", "save"]);
    });

    it("does not save when signing the key fails", async () => {
      mockReceiveKey.mockResolvedValue({ key: { fingerprint: FPR, uid: "X <x@example.org>", created: null, expires: null, trust: "unknown" } });
      mockLsignKey.mockRejectedValue(new Error("gpg failed"));
      const dialog = await openAdd();
      fillRepo(dialog, "chaotic", "https://cdn.example.org/$repo/$arch");
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Signing key fingerprint (optional)" }), { target: { value: FPR } });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Fetch" }));
      });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Sign key and add [chaotic]" }));
      });

      expect(mockSaveRepos).not.toHaveBeenCalled();
      expect(within(dialog).getByRole("list", { name: "Steps" })).toHaveTextContent("Sign key locally, failed");
    });

    it("marks and scrolls to the added row, labels it not synced and offers Updates", async () => {
      const scrolled: string[] = [];
      const originalScroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
        scrolled.push(this.getAttribute("data-repo") ?? "");
      });
      const added = {
        name: "local-repo",
        enabled: true,
        sig_level: null,
        directives: [{ directive_type: "Server" as const, value: "file:///srv/repo", enabled: true }],
      };
      mockListRepos.mockResolvedValue(withCustom);
      mockSaveRepos.mockImplementation(async () => {
        mockListRepos.mockResolvedValue({
          repos: [...withCustom.repos.slice(0, 3), added, withCustom.repos[3]],
          revision: "rev-2",
          not_synced: ["local-repo"],
        });
        return saved;
      });
      const dialog = await openAdd();
      fillRepo(dialog, "local-repo", "file:///srv/repo");
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Add [local-repo] to pacman.conf" }));
      });

      await screen.findByRole("heading", { name: /Added \[local-repo\]$/ });
      expect(screen.getByRole("button", { name: "Add repository" })).toHaveFocus();
      const row = screen.getByText("[local-repo]").closest("tr")!;
      expect(within(row).getByText("Added")).toBeInTheDocument();
      expect(within(row).getByText("Not synced yet")).toBeInTheDocument();
      expect(scrolled).toEqual(["local-repo"]);

      expect(screen.getByRole("heading", { name: /Packages from \[local-repo\] appear after the next system upgrade$/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Go to Updates" }));
      expect(mockLocationGo).toHaveBeenCalledWith([]);
      Element.prototype.scrollIntoView = originalScroll;
    });

    it("labels an enabled repository whose database is missing as not synced", async () => {
      mockListRepos.mockResolvedValue({ ...withCustom, not_synced: ["chaotic-aur"] });
      render(<RepositoriesView />);
      const row = (await screen.findByText("[chaotic-aur]")).closest("tr")!;
      expect(within(row).getByText("Not synced yet")).toBeInTheDocument();
      expect(within(screen.getByText("[core]").closest("tr")!).queryByText("Not synced yet")).not.toBeInTheDocument();
    });

    it("lists the other pending changes the add saves with it", async () => {
      render(<RepositoriesView />);
      await screen.findByText("[core]");
      fireEvent.click(screen.getByRole("switch", { name: "Enable repository extra" }));
      fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
      const dialog = screen.getByRole("dialog", { name: "Add repository" });
      const list = within(dialog).getByRole("list", { name: "Other changes saved with this" });
      expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Disable [extra]"]);
    });

    it("shows a Server problem only after a pause or on blur, and previews no empty Server line", async () => {
      const dialog = await openAdd();
      vi.useFakeTimers();
      try {
        fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), { target: { value: "custom" } });
        expect(dialog.querySelector("pre")).toHaveTextContent(/^\[custom\]$/);

        const server = within(dialog).getByRole("textbox", { name: /^Server/ });
        fireEvent.change(server, { target: { value: "h" } });
        expect(server).not.toHaveAttribute("aria-invalid", "true");
        act(() => {
          vi.advanceTimersByTime(299);
        });
        expect(server).not.toHaveAttribute("aria-invalid", "true");
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(server).toHaveAttribute("aria-invalid", "true");

        fireEvent.change(server, { target: { value: "ht" } });
        expect(server).not.toHaveAttribute("aria-invalid", "true");
        fireEvent.blur(server);
        expect(server).toHaveAttribute("aria-invalid", "true");
        expect(server).toHaveAccessibleDescription(expect.stringContaining("A Server needs a URL"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("titles a signed add, says the key stays signed and asks to compare the fingerprint", async () => {
      const uid = "Chaotic AUR <ops@example.org>";
      mockListRepos.mockResolvedValue(withCustom);
      mockReceiveKey.mockResolvedValue({ key: { fingerprint: FPR, uid, created: null, expires: null, trust: "unknown" } });
      let finishSign: (value: { key: api.KeyringKey }) => void = () => {};
      mockLsignKey.mockImplementation(() => new Promise((resolve) => { finishSign = resolve; }));
      mockSaveRepos.mockImplementation(async () => {
        mockListRepos.mockResolvedValue({ ...withCustom, revision: "rev-2", not_synced: ["chaotic"] });
        return saved;
      });
      const dialog = await openAdd();
      fillRepo(dialog, "chaotic", "https://cdn.example.org/$repo/$arch");
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Signing key fingerprint (optional)" }), { target: { value: FPR } });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Fetch" }));
      });
      expect(dialog).toHaveTextContent("Compare this fingerprint with the one [chaotic] publishes before signing.");
      expect(dialog).toHaveTextContent("Undo removes [chaotic]; the key stays signed.");

      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Sign key and add [chaotic]" }));
      });
      for (const name of ["Close", "Cancel"]) {
        const control = within(dialog).getByRole("button", { name });
        expect(control).toHaveAttribute("aria-disabled", "true");
        expect(control).toHaveAccessibleDescription("Signing cannot be interrupted");
        fireEvent.click(control);
      }
      announceSpy.mockClear();
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(announceSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("dialog", { name: "Add repository" })).toBeInTheDocument();

      await act(async () => {
        finishSign({ key: { fingerprint: FPR, uid, created: null, expires: null, trust: "full" } });
      });
      expect(await screen.findByRole("heading", { name: /\[chaotic\] added, key for Chaotic AUR <ops@example\.org> locally signed$/ })).toBeInTheDocument();
      expect(screen.getByText(`Undo removes [chaotic]; the key for ${uid} stays signed.`)).toBeInTheDocument();
    });

    it("offers no Remove for official repositories", async () => {
      mockListRepos.mockResolvedValue(withCustom);
      render(<RepositoriesView />);
      await screen.findByText("[core]");
      fireEvent.click(screen.getByRole("button", { name: "More actions for core" }));
      expect(screen.queryByRole("menuitem", { name: /^Remove/ })).not.toBeInTheDocument();
    });

    it("names the installed packages before removing a custom repository, then saves with Undo", async () => {
      mockListRepos.mockResolvedValue(withCustom);
      mockSaveRepos.mockResolvedValue(saved);
      mockListInstalled.mockResolvedValue({
        packages: [
          { name: "chaotic-keyring", version: "1", description: null, installed_size: 1, install_date: null, reason: "explicit", repository: "chaotic-aur" },
          { name: "paru", version: "2", description: null, installed_size: 1, install_date: null, reason: "explicit", repository: "chaotic-aur" },
        ],
        total: 2,
        total_explicit: 2,
        total_dependency: 0,
        repositories: ["core", "extra", "chaotic-aur"],
        warnings: [],
      });
      render(<RepositoriesView />);
      await screen.findByText("[chaotic-aur]");
      fireEvent.click(screen.getByRole("button", { name: "More actions for chaotic-aur" }));
      const menuItems = Array.from(screen.getByRole("menu").querySelectorAll("li"));
      const removeItem = screen.getByRole("menuitem", { name: "Remove [chaotic-aur]" }).closest("li")!;
      expect(menuItems[menuItems.indexOf(removeItem) - 1]).toHaveAttribute("role", "separator");
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Remove [chaotic-aur]" }));
      });

      expect(mockListInstalled).toHaveBeenCalledWith(expect.objectContaining({ repo: "chaotic-aur" }));
      const dialog = screen.getByRole("dialog", { name: /Remove \[chaotic-aur\] from pacman\.conf\?$/ });
      const names = within(dialog).getByRole("list", { name: "Installed packages from [chaotic-aur]" });
      expect(within(names).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["chaotic-keyring", "paru"]);
      expect(mockSaveRepos).not.toHaveBeenCalled();

      sweepA11y({ dialogs: [/Remove \[chaotic-aur\] from pacman\.conf\?$/] });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove [chaotic-aur]" }));
      });
      expect(mockSaveRepos.mock.calls[0][0].map((r) => r.name)).toEqual(["core", "extra", "multilib"]);
      expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Removed \[chaotic-aur\]; 2 installed packages are now foreign$/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "More actions for multilib" })).toHaveFocus();
    });

    it("blocks the Remove commit with a reason until the installed list arrives, and lists pending changes", async () => {
      mockListRepos.mockResolvedValue(withCustom);
      mockSaveRepos.mockResolvedValue(saved);
      let finishList: (value: Awaited<ReturnType<typeof api.listInstalled>>) => void = () => {};
      mockListInstalled.mockImplementation(() => new Promise((resolve) => { finishList = resolve; }));
      render(<RepositoriesView />);
      await screen.findByText("[chaotic-aur]");
      fireEvent.click(screen.getByRole("switch", { name: "Enable repository extra" }));
      fireEvent.click(screen.getByRole("button", { name: "More actions for chaotic-aur" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Remove [chaotic-aur]" }));
      });
      const dialog = screen.getByRole("dialog", { name: /Remove \[chaotic-aur\]/ });
      const list = within(dialog).getByRole("list", { name: "Other changes saved with this" });
      expect(list).toHaveTextContent("Disable [extra]");
      const commit = within(dialog).getByRole("button", { name: "Remove [chaotic-aur] and save 1 other change" });
      expect(commit).toHaveAttribute("aria-disabled", "true");
      expect(commit).toHaveAccessibleDescription("Listing installed packages from [chaotic-aur]…");
      fireEvent.click(commit);
      expect(mockSaveRepos).not.toHaveBeenCalled();

      await act(async () => {
        finishList({ packages: [], total: 0, total_explicit: 0, total_dependency: 0, repositories: [], warnings: [] });
      });
      expect(commit).not.toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        fireEvent.click(commit);
      });
      expect(mockSaveRepos).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole("heading", { name: /Removed \[chaotic-aur\]$/ })).toBeInTheDocument();
    });

    it("lists no packages for a disabled custom section, and Cancel saves nothing", async () => {
      mockListRepos.mockResolvedValue({
        ...withCustom,
        repos: withCustom.repos.map((r) => (r.name === "chaotic-aur" ? { ...r, enabled: false } : r)),
      });
      render(<RepositoriesView />);
      await screen.findByText("[chaotic-aur]");
      fireEvent.click(screen.getByRole("button", { name: "More actions for chaotic-aur" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Remove [chaotic-aur]" }));
      });

      expect(mockListInstalled).not.toHaveBeenCalled();
      const dialog = screen.getByRole("dialog", { name: /Remove \[chaotic-aur\]/ });
      expect(dialog).toHaveTextContent("[chaotic-aur] is disabled, so pacman tracks no installed packages to it.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockSaveRepos).not.toHaveBeenCalled();
    });

    it("names a failed installed-package listing in a dialog heading at h2", async () => {
      mockListRepos.mockResolvedValue(withCustom);
      mockListInstalled.mockRejectedValue(new Error("database not found"));
      render(<RepositoriesView />);
      await screen.findByText("[chaotic-aur]");
      fireEvent.click(screen.getByRole("button", { name: "More actions for chaotic-aur" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Remove [chaotic-aur]" }));
      });

      const dialog = screen.getByRole("dialog", { name: /Remove \[chaotic-aur\] from pacman\.conf\?$/ });
      expect(within(dialog).getByRole("heading", { level: 2, name: /Installed packages could not be listed$/ })).toBeInTheDocument();
      sweepA11y({ dialogs: [/Remove \[chaotic-aur\] from pacman\.conf\?$/] });
    });

    it("gates Add repository without administrative access", async () => {
      mockPermission.mockReturnValue({
        allowed: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      });
      render(<RepositoriesView />);
      const add = await screen.findByRole("button", { name: "Add repository" });
      expect(add).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(add);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

describe("addInsertion", () => {
  const entry = (name: string, enabled: boolean) => ({ name, enabled, sig_level: null, directives: [] });

  it("goes after the last enabled repository, skipping the template", () => {
    expect(addInsertion([entry("core", true), entry("repo-name", true), entry("multilib", false)]))
      .toEqual({ at: 1, after: "core" });
  });

  it("goes at the end when nothing is enabled", () => {
    expect(addInsertion([entry("repo-name", true), entry("multilib", false)])).toEqual({ at: 2, after: null });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useState } from "react";
import { render, screen, fireEvent, act, cleanup, waitFor, within } from "@testing-library/react";
import { TransactionHost, TransactionHostProvider } from "./TransactionHost";
import { TransactionBanner } from "./TransactionBanner";
import { PackageActionModal, installConfig } from "./PackageActionModal";
import { DowngradeModal } from "./DowngradeModal";
import { OrphansView } from "./OrphansView";
import { NavigationProvider } from "../contexts/NavigationContext";
import * as api from "../api";
import { mutationGate } from "../hooks/useMutationGate";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { mockSpawn } from "../test/setup";
import { createMockStreamingProcess } from "../test/mocks";
import { sweepA11y } from "../test/a11ySweep";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    checkUpdates: vi.fn().mockResolvedValue({ updates: [], warnings: [] }),
    listDowngrades: vi.fn(),
    previewDowngrade: vi.fn(),
    listOrphans: vi.fn(),
    previewRemoveOrphans: vi.fn(),
  };
});

const preview: api.TransactionPreview = {
  success: true,
  add: [{ name: "vim", version: "9.1-1", repo: "extra", download_size: 1, installed_size: 1, reason: "target" }],
  remove: [],
  conflicts: [],
  replacements: [],
  providers: [],
  import_keys: [],
  warnings: [],
  blocked_by: [],
  total_download_size: 1,
  net_installed_size: 1,
};

const config = { ...installConfig, preview: () => Promise.resolve(preview) };

const Launcher: React.FC<{ dialog: (onClose: () => void) => React.ReactNode }> = ({ dialog }) => {
  const [open, setOpen] = useState(true);
  return open ? <>{dialog(() => setOpen(false))}</> : null;
};

function renderPage(dialog: (onClose: () => void) => React.ReactNode) {
  return render(
    <AnnouncerProvider>
      <TransactionHostProvider>
        <TransactionBanner activeSlug="search" activeOptions={{}} onNavigate={vi.fn()} />
        <TransactionHost />
        <Launcher dialog={dialog} />
      </TransactionHostProvider>
    </AnnouncerProvider>,
  );
}

function spawnProcess() {
  const proc = createMockStreamingProcess();
  const close = vi.spyOn(proc, "close");
  const input = vi.spyOn(proc, "input");
  mockSpawn.mockReturnValueOnce(proc);
  return { proc, close, input };
}

const emit = (proc: ReturnType<typeof createMockStreamingProcess>, event: object) =>
  act(() => {
    proc._emit(JSON.stringify(event) + "\n");
    if ("type" in event && event.type === "complete") proc._complete();
  });

async function backgroundInstall() {
  const spawned = spawnProcess();
  renderPage((onClose) => (
    <PackageActionModal packageName="vim" packageVersion="9.1-1" isOpen onClose={onClose} config={config} />
  ));
  fireEvent.click(await screen.findByRole("button", { name: "Install vim" }));
  emit(spawned.proc, { type: "log", level: "info", message: "fetching vim" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));
  });
  return spawned;
}

describe("TransactionHost", () => {
  let finish: (() => void) | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    finish = undefined;
  });

  afterEach(() => {
    finish?.();
    cleanup();
  });

  it("keeps a backgrounded install running and the gate blocked after its dialog unmounts", async () => {
    const { proc, close, input } = await backgroundInstall();
    finish = () => emit(proc, { type: "complete", success: true });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(api.getActiveTransaction()?.command).toBe("install-package");
    expect(mutationGate("install packages", true, api.getActiveTransaction()).blocked).toBe(true);
    expect(screen.getByText("Installing vim is running")).toBeInTheDocument();
  });

  it("moves focus to View progress, which reopens the same run with its log", async () => {
    const { proc } = await backgroundInstall();
    finish = () => emit(proc, { type: "complete", success: true });
    const viewProgress = screen.getByRole("button", { name: "View progress" });
    await waitFor(() => expect(viewProgress).toHaveFocus());

    emit(proc, { type: "log", level: "info", message: "installing vim" });
    fireEvent.click(viewProgress);

    const dialog = screen.getByRole("dialog", { name: "Install vim" });
    expect(await within(dialog).findByText(/fetching vim/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/installing vim/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Run in background" })).toBeInTheDocument();
  });

  it("cancels from the reopened dialog through the same handle", async () => {
    const { proc, input } = await backgroundInstall();
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop installing vim" }));
    expect(input).toHaveBeenCalledWith("cancel\n", true);

    emit(proc, { type: "complete", success: false, message: "cancelled" });
    expect(screen.getByRole("dialog", { name: "Install vim" })).toBeInTheDocument();
    expect(api.getActiveTransaction()).toBeNull();
  });

  it("shows the outcome of a run that ends in the background and reopens its result", async () => {
    const { proc } = await backgroundInstall();
    emit(proc, { type: "complete", success: true });

    expect(screen.queryByText("Installing vim is running")).not.toBeInTheDocument();
    expect(screen.getByText("Install vim finished")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View result" }));
    const dialog = screen.getByRole("dialog", { name: "Install vim" });
    expect(within(dialog).getByText("Package installed")).toBeInTheDocument();

    const buttons = within(dialog).getAllByRole("button", { name: "Close" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Install vim finished")).not.toBeInTheDocument();
  });

  it("names a failed background run and lets it be dismissed", async () => {
    const { proc } = await backgroundInstall();
    emit(proc, { type: "complete", success: false, message: "target not found: vim" });

    expect(screen.getByText("Install vim failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Close .*alert/i }));
    expect(screen.queryByText("Install vim failed")).not.toBeInTheDocument();
  });

  it("backgrounds a downgrade and reopens it at the running step", async () => {
    const version: api.CachedVersion = {
      name: "vim",
      version: "9.0-1",
      filename: "vim-9.0-1-x86_64.pkg.tar.zst",
      size: 1024,
      installed_version: "9.1-1",
      is_older: true,
    };
    vi.mocked(api.listDowngrades).mockResolvedValue({ packages: [version] } as api.DowngradeResponse);
    vi.mocked(api.previewDowngrade).mockResolvedValue(preview);
    const { proc, close } = spawnProcess();
    finish = () => emit(proc, { type: "complete", success: true });
    renderPage((onClose) => <DowngradeModal packageName="vim" currentVersion="9.1-1" isOpen onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: "Select 9.0-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade vim to 9.0-1" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run in background" }));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    expect(api.getActiveTransaction()?.command).toBe("downgrade");
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(within(screen.getByRole("dialog", { name: "Downgrade vim" })).getByText("Downgrading vim to 9.0-1…")).toBeInTheDocument();
  });

  describe("an orphan removal whose view unmounts", () => {
    const orphanPreview: api.TransactionPreview = {
      ...preview,
      add: [],
      remove: [{ name: "libunused", version: "1.0-1", installed_size: 1, reason: "target" }],
      net_installed_size: -1,
    };

    const OrphanPage: React.FC<{ show: boolean; onViewOrphans?: () => void }> = ({ show, onViewOrphans }) => (
      <AnnouncerProvider>
        <NavigationProvider value={{ onViewOrphans }}>
          <TransactionHostProvider>
            <TransactionBanner
              activeSlug="installed"
              activeOptions={{ filter: show ? "orphan" : "all" }}
              onNavigate={vi.fn()}
            />
            <TransactionHost />
            {show && <OrphansView onRowClick={vi.fn()} />}
          </TransactionHostProvider>
        </NavigationProvider>
      </AnnouncerProvider>
    );

    async function startAndLeave(onViewOrphans?: () => void) {
      vi.mocked(api.listOrphans).mockResolvedValue({
        orphans: [{ name: "libunused", version: "1.0-1", installed_size: 1, repository: "extra" }],
        total_size: 1,
      } as api.OrphanResponse);
      vi.mocked(api.previewRemoveOrphans).mockResolvedValue(orphanPreview);
      const spawned = spawnProcess();
      const view = render(<OrphanPage show onViewOrphans={onViewOrphans} />);
      fireEvent.click(await screen.findByRole("button", { name: "Remove 1 orphan" }));
      const dialog = await screen.findByRole("dialog", { name: "Remove orphan packages?" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Remove 1 orphan" }));
      emit(spawned.proc, { type: "log", level: "info", message: "removing libunused" });
      view.rerender(<OrphanPage show={false} onViewOrphans={onViewOrphans} />);
      return spawned;
    }

    it("keeps the backend running and routes View progress to the orphan list", async () => {
      const onViewOrphans = vi.fn();
      const { proc, close, input } = await startAndLeave(onViewOrphans);
      finish = () => emit(proc, { type: "complete", success: true });

      expect(close).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
      expect(api.getActiveTransaction()?.command).toBe("remove-orphans");
      const viewProgress = screen.getByRole("button", { name: "View progress" });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(viewProgress).not.toHaveFocus();

      fireEvent.click(viewProgress);
      expect(onViewOrphans).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens a progress dialog without a route, and stops through the same handle", async () => {
      const { proc, input } = await startAndLeave();
      fireEvent.click(screen.getByRole("button", { name: "View progress" }));

      const dialog = screen.getByRole("dialog", { name: "Removing 1 orphan package" });
      await waitFor(() => expect(within(dialog).getByRole("log")).toHaveTextContent("removing libunused"));
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      expect(cancel).toHaveClass("pf-m-secondary");
      fireEvent.click(cancel);
      const stop = within(dialog).getByRole("button", { name: "Stop removing orphan packages" });
      expect(stop).toHaveClass("pf-m-danger");
      fireEvent.click(stop);
      expect(input).toHaveBeenCalledTimes(1);
      expect(input).toHaveBeenCalledWith("cancel\n", true);

      emit(proc, { type: "complete", success: false, message: "cancelled" });
      expect(screen.getByRole("dialog", { name: "Stopped removing 1 orphan package" })).toBe(dialog);
      expect(within(dialog).getByText("Orphan removal stopped")).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Run in background" })).not.toBeInTheDocument();
      expect(api.getActiveTransaction()).toBeNull();
    });

    it("shows the removal phase and value, and hides the dialog with Run in background", async () => {
      const { proc } = await startAndLeave();
      fireEvent.click(screen.getByRole("button", { name: "View progress" }));
      const dialog = screen.getByRole("dialog", { name: "Removing 1 orphan package" });
      expect(dialog).toHaveTextContent("Preparing");
      expect(within(dialog).queryByRole("progressbar")).not.toBeInTheDocument();

      emit(proc, { type: "progress", operation: "remove_start", package: "libunused", percent: 50, current: 1, total: 1 });
      const bar = await within(dialog).findByRole("progressbar", { name: "Removing packages" });
      expect(bar).toHaveAttribute("aria-valuenow", "47");
      expect(bar).toHaveAttribute("aria-valuetext", "47 percent, Removing packages, 1 of 1");
      sweepA11y({ dialogs: ["Removing 1 orphan package"] });

      fireEvent.click(within(dialog).getByRole("button", { name: "Run in background" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View progress" })).toBeInTheDocument();
      finish = () => emit(proc, { type: "complete", success: true });
    });

    it("titles a finished removal in the past tense and lists what it removed", async () => {
      const { proc } = await startAndLeave();
      emit(proc, { type: "complete", success: true });
      expect(screen.getByRole("heading", { name: /Removed 1 orphan package$/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "View result" }));
      const dialog = screen.getByRole("dialog", { name: "Removed 1 orphan package" });
      expect(dialog).toHaveTextContent("Removed 1 package, freeing");
      expect(within(within(dialog).getByRole("list", { name: "Removed packages" })).getByText("libunused")).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Back to orphan list" })).not.toBeInTheDocument();
      const closeButtons = within(dialog).getAllByRole("button", { name: "Close" });
      const footerClose = closeButtons[closeButtons.length - 1];
      expect(footerClose).toHaveClass("pf-m-primary");
      sweepA11y({ dialogs: ["Removed 1 orphan package"] });

      fireEvent.click(footerClose);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Removed 1 orphan package$/ })).not.toBeInTheDocument();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { TidyUpModal, tidyCommitLabel } from "./TidyUpModal";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import * as api from "../api";
import { createMockStreamingProcess } from "../test/mocks";
import { mockSpawn } from "../test/setup";
import { sweepA11y } from "../test/a11ySweep";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    previewRemoveOrphans: vi.fn(),
    removeOrphans: vi.fn(),
    cleanCache: vi.fn(),
    previewCacheCleanup: vi.fn(),
    getActiveTransaction: vi.fn(() => null),
    onSystemChanged: vi.fn(() => () => {}),
  };
});

const mockCachePreview = vi.mocked(api.previewCacheCleanup);
const mockPreview = vi.mocked(api.previewRemoveOrphans);
const mockRemoveOrphans = vi.mocked(api.removeOrphans);
const mockCleanCache = vi.mocked(api.cleanCache);

const preview = (overrides: Partial<api.TransactionPreview> = {}): api.TransactionPreview => ({
  success: true,
  add: [],
  remove: [
    { name: "libfoo", version: "1", installed_size: 1000, reason: "target" },
    { name: "libbar", version: "1", installed_size: 1000, reason: "target" },
    { name: "libdep", version: "1", installed_size: 1000, reason: "dependency" },
  ],
  conflicts: [],
  replacements: [],
  providers: [],
  import_keys: [],
  warnings: [],
  blocked_by: [],
  total_download_size: 0,
  net_installed_size: -3000,
  ...overrides,
});

interface Run {
  callbacks: api.UpgradeCallbacks;
  handle: { cancel: ReturnType<typeof vi.fn>; forceStop: ReturnType<typeof vi.fn>; setReopen: ReturnType<typeof vi.fn> };
}

function capture(mock: typeof mockRemoveOrphans | typeof mockCleanCache): Run[] {
  const runs: Run[] = [];
  mock.mockImplementation(((callbacks: api.UpgradeCallbacks) => {
    const handle = { cancel: vi.fn(), forceStop: vi.fn(), setReopen: vi.fn() };
    runs.push({ callbacks, handle });
    return handle;
  }) as never);
  return runs;
}

const CACHE = { files: 41, bytes: 5 * 1024 * 1024 };

function renderModal(props: Partial<React.ComponentProps<typeof TidyUpModal>> = {}) {
  const onClose = vi.fn();
  const onFinished = vi.fn();
  render(
    <AnnouncerProvider>
      <TidyUpModal onClose={onClose} onFinished={onFinished} orphans={["libfoo", "libbar"]} cache={CACHE} {...props} />
    </AnnouncerProvider>
  );
  return { onClose, onFinished };
}

const commitButton = () => screen.getByRole("dialog").querySelector(".pf-v6-c-modal-box__footer button") as HTMLElement;

describe("TidyUpModal", () => {
  let orphanRuns: Run[];
  let cacheRuns: Run[];

  beforeEach(() => {
    mockPreview.mockResolvedValue(preview());
    mockCachePreview.mockResolvedValue(CACHE);
    vi.mocked(api.getActiveTransaction).mockReturnValue(null);
    orphanRuns = capture(mockRemoveOrphans);
    cacheRuns = capture(mockCleanCache);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("refreshes the cache count before reconfirming a stale cache-only plan", async () => {
    mockCachePreview.mockResolvedValueOnce({ files: 2, bytes: 2048 });
    renderModal({ orphans: [] });
    await screen.findByRole("checkbox", { name: /Delete up to 2 old cache files/ });
    act(() => vi.mocked(api.onSystemChanged).mock.calls[0][0]("system"));
    expect(commitButton()).toHaveAttribute("aria-disabled", "true");
    let resolve!: (value: { files: number; bytes: number }) => void;
    mockCachePreview.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(commitButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(commitButton());
    expect(mockCleanCache).not.toHaveBeenCalled();
    await act(async () => { resolve({ files: 7, bytes: 7168 }); });
    expect(commitButton()).toHaveTextContent("Delete up to 7 cache files");
    fireEvent.click(commitButton());
    expect(mockCleanCache).toHaveBeenCalledWith(expect.anything(), 3);
  });

  it("keeps cache cleanup blocked and shows diagnostics when its preview fails", async () => {
    mockCachePreview.mockRejectedValue(new api.BackendError("Cannot read cache", "permission_denied", "Cache directory is unreadable"));
    renderModal({ orphans: [] });
    await screen.findByText("Cache directory is unreadable");
    expect(commitButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(commitButton());
    expect(mockCleanCache).not.toHaveBeenCalled();
  });

  it("requires explicit consent to conflict removals and sends the full approved list", async () => {
    mockPreview.mockResolvedValue(preview({ remove: [{ name: "conflicting", version: "1", installed_size: 1000, reason: "conflict" }] }));
    renderModal();
    const consent = await screen.findByRole("checkbox", { name: "Remove conflicting" });
    fireEvent.click(commitButton());
    expect(mockRemoveOrphans).not.toHaveBeenCalled();
    fireEvent.click(consent);
    fireEvent.click(commitButton());
    expect(mockRemoveOrphans).toHaveBeenCalledWith(expect.anything(), ["libfoo", "libbar"], ["conflicting"]);
  });

  it("blocks an unknown signing key without an acknowledgement bypass", async () => {
    mockPreview.mockResolvedValue(preview({ import_keys: [{ fingerprint: "A".repeat(40), uid: "Unknown signer" }] }));
    renderModal();
    await screen.findByText(/Unknown signer/);
    expect(commitButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(commitButton());
    expect(mockRemoveOrphans).not.toHaveBeenCalled();
    expect(mockCleanCache).not.toHaveBeenCalled();
  });

  it("checks the current transaction again when confirming", async () => {
    renderModal();
    await screen.findByText("libdep");
    vi.mocked(api.getActiveTransaction).mockReturnValue({ command: "upgrade", startedAt: Date.now() });
    fireEvent.click(commitButton());
    expect(mockRemoveOrphans).not.toHaveBeenCalled();
    expect(mockCleanCache).not.toHaveBeenCalled();
  });

  it("keeps the run and registry active through the completion event until process exit", async () => {
    const actual = await vi.importActual<typeof api>("../api");
    mockRemoveOrphans.mockImplementation(actual.removeOrphans);
    const process = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(process);
    const { onFinished } = renderModal();
    await screen.findByText("libdep");
    fireEvent.click(commitButton());
    act(() => process._emit(JSON.stringify({ type: "complete", success: true }) + "\n"));
    expect(screen.getByRole("dialog", { name: "Tidying up" })).toBeInTheDocument();
    expect(actual.getActiveTransaction()?.command).toBe("remove-orphans");
    expect(mockCleanCache).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop removing orphan packages" }));
    expect(screen.queryByRole("button", { name: "Force stop" })).not.toBeInTheDocument();
    act(() => process._complete());
    expect(actual.getActiveTransaction()).toBeNull();
    expect(mockCleanCache).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Tidy-up stopped" })).toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("cancels on unmount, clears the reopen callback, and ignores late results", async () => {
    const { onFinished } = renderModal();
    await screen.findByText("libdep");
    fireEvent.click(commitButton());
    const run = orphanRuns[0];
    cleanup();
    expect(run.handle.cancel).toHaveBeenCalledTimes(1);
    expect(run.handle.setReopen).toHaveBeenLastCalledWith(undefined);
    act(() => { run.callbacks.onData?.("late output"); run.callbacks.onComplete(); });
    expect(mockCleanCache).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("keeps a real failure and its diagnostics after Stop was requested", async () => {
    renderModal();
    await screen.findByText("libdep");
    fireEvent.click(commitButton());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop removing orphan packages" }));
    act(() => orphanRuns[0].callbacks.onError("Commit failed", "transaction_failed", "Disk is full"));
    expect(screen.getByRole("dialog", { name: "Tidy-up failed" })).toBeInTheDocument();
    expect(screen.getByText("Disk is full")).toBeInTheDocument();
    expect(mockCleanCache).not.toHaveBeenCalled();
  });

  it("previews both parts with names, counts and size, and runs nothing before the commit", async () => {
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "Tidy up after the upgrade" });
    expect(mockPreview).toHaveBeenCalledWith(["libfoo", "libbar"], expect.any(AbortSignal));
    expect(await within(dialog).findByText("libdep")).toBeInTheDocument();
    expect(within(dialog).getByText("libfoo")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Remove 3 orphan packages" })).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: /Delete up to 41 old cache files, keeping 3 versions \(5\.0 MiB\)/ })
    ).toBeChecked();
    expect(commitButton()).toHaveTextContent("Remove 3 orphans and delete up to 41 cache files");
    expect(mockRemoveOrphans).not.toHaveBeenCalled();
    expect(mockCleanCache).not.toHaveBeenCalled();
    sweepA11y({ dialogs: ["Tidy up after the upgrade"] });
  });

  it("names only the checked parts in the commit label", async () => {
    renderModal();
    const orphans = await screen.findByRole("checkbox", { name: "Remove 3 orphan packages" });
    const cache = screen.getByRole("checkbox", { name: /Delete up to 41 old cache files/ });

    fireEvent.click(cache);
    expect(commitButton()).toHaveTextContent(/^Remove 3 orphans$/);

    fireEvent.click(cache);
    fireEvent.click(orphans);
    expect(commitButton()).toHaveTextContent(/^Delete up to 41 cache files$/);

    fireEvent.click(cache);
    expect(commitButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(commitButton());
    expect(mockRemoveOrphans).not.toHaveBeenCalled();
    expect(mockCleanCache).not.toHaveBeenCalled();
  });

  it("keeps the commit aria-disabled until a tick the orphan preview requires is set", async () => {
    mockPreview.mockResolvedValue(preview({
      warnings: [{
        id: "w1", severity: "warning", title: "libfoo provides a hook", message: "m", packages: [], blocking: false,
      }],
    }));
    renderModal();
    const tick = await screen.findByRole("checkbox", { name: "Proceed despite: libfoo provides a hook" });
    expect(commitButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(commitButton());
    expect(mockRemoveOrphans).not.toHaveBeenCalled();

    fireEvent.click(tick);
    expect(commitButton()).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(commitButton());
    expect(mockRemoveOrphans).toHaveBeenCalledWith(expect.anything(), ["libfoo", "libbar"], ["libfoo", "libbar", "libdep"]);
  });

  it("drops the tick requirement when the orphan part is unchecked", async () => {
    mockPreview.mockResolvedValue(preview({
      warnings: [{ id: "w1", severity: "warning", title: "Hook", message: "m", packages: [], blocking: false }],
    }));
    renderModal();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Remove 3 orphan packages" }));
    expect(commitButton()).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(commitButton());
    expect(mockRemoveOrphans).not.toHaveBeenCalled();
    expect(mockCleanCache).toHaveBeenCalledWith(expect.anything(), 3);
  });

  it("offers only the cache part when the orphan preview fails", async () => {
    mockPreview.mockRejectedValue(new Error("database is locked"));
    renderModal();
    expect(await within(screen.getByRole("dialog")).findByText("Could not check what orphan removal changes")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Remove 2 orphan packages/ })).toBeDisabled();
    expect(commitButton()).toHaveTextContent(/^Delete up to 41 cache files$/);
  });

  it("runs orphan removal, then the cache clean at keep 3, and reports both", async () => {
    const { onFinished } = renderModal();
    await screen.findByText("libdep");
    fireEvent.click(commitButton());
    expect(screen.getByRole("dialog", { name: "Tidying up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
    expect(screen.getByText("Step 1 of 2: Orphan removal")).toBeInTheDocument();
    expect(mockCleanCache).not.toHaveBeenCalled();

    act(() => {
      orphanRuns[0].callbacks.onData?.("removing libfoo\n");
      orphanRuns[0].callbacks.onComplete();
    });
    expect(mockCleanCache).toHaveBeenCalledWith(expect.anything(), 3);
    expect(screen.getByText("Step 2 of 2: Cache clean")).toBeInTheDocument();

    act(() => {
      cacheRuns[0].callbacks.onEvent?.({ type: "event", event: "Removed", package: "a.pkg.tar.zst", current: 1, total: 4 });
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "1 of 4 files");

    act(() => {
      cacheRuns[0].callbacks.onData?.("a.pkg.tar.zst\n");
      cacheRuns[0].callbacks.onEvent?.({ type: "complete", success: true, message: "Removed 4 files, freed 12.0 MiB" });
      cacheRuns[0].callbacks.onComplete();
    });
    expect(screen.getByRole("dialog", { name: "Tidy-up finished" })).toBeInTheDocument();
    expect(commitButton()).toHaveTextContent("Close");
    expect(commitButton()).toHaveFocus();
    expect(screen.getByText("Removed 3 orphan packages.")).toBeInTheDocument();
    expect(screen.getByText(/Deleted old cache files, keeping 3 versions/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Cache clean" })).getByText("Removed 4 files, freed 12.0 MiB")).toBeInTheDocument();
    expect(screen.getByLabelText("Orphan removal output")).toHaveTextContent("removing libfoo");
    expect(screen.getByLabelText("Cache clean output")).toHaveTextContent("a.pkg.tar.zst");
    expect(onFinished).toHaveBeenCalledTimes(1);
    sweepA11y({ dialogs: ["Tidy-up finished"] });
  });

  it("skips the cache clean when orphan removal fails and says so", async () => {
    renderModal();
    await screen.findByText("libdep");
    fireEvent.click(commitButton());
    act(() => {
      orphanRuns[0].callbacks.onData?.("error: failed to commit transaction\n");
      orphanRuns[0].callbacks.onError("failed to commit transaction", "transaction_failed");
    });
    expect(mockCleanCache).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Tidy-up failed" })).toBeInTheDocument();
    expect(screen.getByText("Orphan removal failed.")).toBeInTheDocument();
    expect(screen.getByText("The cache clean did not start because orphan removal failed.")).toBeInTheDocument();
    expect(screen.getByLabelText("Orphan removal output")).toHaveTextContent("failed to commit transaction");
  });

  it("asks before stopping, and a stopped orphan removal skips the cache clean", async () => {
    renderModal();
    await screen.findByText("libdep");
    fireEvent.click(commitButton());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(orphanRuns[0].handle.cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep running" })).toHaveFocus();
    sweepA11y({ dialogs: ["Tidying up"] });

    fireEvent.click(screen.getByRole("button", { name: "Stop removing orphan packages" }));
    expect(orphanRuns[0].handle.cancel).toHaveBeenCalledTimes(1);
    expect(orphanRuns[0].handle.forceStop).not.toHaveBeenCalled();
    act(() => orphanRuns[0].callbacks.onError("Operation cancelled", "cancelled"));

    expect(mockCleanCache).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Tidy-up stopped" })).toBeInTheDocument();
    expect(commitButton()).toHaveFocus();
    expect(screen.getByText("Orphan removal stopped.")).toBeInTheDocument();
    expect(screen.getByText("The cache clean did not start because orphan removal was stopped.")).toBeInTheDocument();
  });

  it("does not start the cache clean when orphan removal finishes after a stop was requested", async () => {
    renderModal();
    await screen.findByText("libdep");
    fireEvent.click(commitButton());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop removing orphan packages" }));
    act(() => orphanRuns[0].callbacks.onComplete());

    expect(mockCleanCache).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Tidy-up stopped" })).toBeInTheDocument();
    expect(screen.getByText("Removed 3 orphan packages.")).toBeInTheDocument();
    expect(screen.getByText("The cache clean did not start because you stopped the tidy-up.")).toBeInTheDocument();
  });

  it("shows the cache clean's Stopped outcome after a stop during the cache part", async () => {
    renderModal();
    await screen.findByText("libdep");
    fireEvent.click(commitButton());
    act(() => orphanRuns[0].callbacks.onComplete());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByText("Stop cleaning the cache?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop cleaning the cache" }));
    expect(cacheRuns[0].handle.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Stopping…/ })).toHaveAttribute("aria-disabled", "true");

    act(() => {
      cacheRuns[0].callbacks.onData?.("a.pkg.tar.zst\n");
      cacheRuns[0].callbacks.onError("Stopped after removing 1 file, freed 1.0 MiB", "cancelled");
    });
    expect(screen.getByRole("dialog", { name: "Tidy-up stopped" })).toBeInTheDocument();
    expect(screen.getByText("Removed 3 orphan packages.")).toBeInTheDocument();
    expect(screen.getByText("Cache clean stopped.")).toBeInTheDocument();
    expect(screen.getByText("Stopped after removing 1 file, freed 1.0 MiB")).toBeInTheDocument();
    expect(screen.getByLabelText("Cache clean output")).toHaveTextContent("a.pkg.tar.zst");
  });

  it("ignores Close while running and closes from the result", async () => {
    const { onClose } = renderModal({ orphans: [] });
    await act(async () => {});
    expect(mockPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeInTheDocument();
    fireEvent.click(commitButton());
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    act(() => cacheRuns[0].callbacks.onComplete());
    expect(screen.queryByText(/orphan/i)).not.toBeInTheDocument();
    expect(commitButton()).toHaveTextContent("Close");
    fireEvent.click(commitButton());
    expect(onClose).toHaveBeenCalled();
  });
});

describe("tidyCommitLabel", () => {
  it.each([
    [3, 41, "Remove 3 orphans and delete up to 41 cache files"],
    [1, 1, "Remove 1 orphan and delete up to 1 cache file"],
    [2, null, "Remove 2 orphans"],
    [null, 5, "Delete up to 5 cache files"],
    [null, 1000, "Delete up to 1,000 cache files"],
    [null, null, "Tidy up"],
  ])("%s orphans and %s cache files read %s", (orphans, files, label) => {
    expect(tidyCommitLabel(orphans, files)).toBe(label);
  });
});

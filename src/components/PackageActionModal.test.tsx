import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { PackageActionModal, installConfig, uninstallConfig } from "./PackageActionModal";
import { LOG_FLUSH_MS } from "../constants";
import { CANCEL_WAIT_NOTICE_MS } from "./CancellationNotice";
import { BackendError, checkLock, formatPreviewTotals, type LockStatus, type StreamEvent, type TransactionPreview, type UpgradeCallbacks } from "../api";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { previewSummary } from "./TransactionPreview";
import { NavigationProvider } from "../contexts/NavigationContext";
import { sweepA11y } from "../test/a11ySweep";

const systemChange = vi.hoisted(() => {
  const listeners = new Set<{ listener: (kind: "system" | "sync") => void; kinds: ("system" | "sync")[] }>();
  return {
    listeners,
    subscribe: (listener: (kind: "system" | "sync") => void, kinds: ("system" | "sync")[] = ["system", "sync"]) => {
      const entry = { listener, kinds };
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
  };
});

function emitSystemChange(kind: "system" | "sync" = "system") {
  for (const { listener, kinds } of [...systemChange.listeners]) {
    if (kinds.includes(kind)) listener(kind);
  }
}

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return { ...actual, checkUpdates: vi.fn().mockResolvedValue({ updates: [], warnings: [] }), checkLock: vi.fn(), onSystemChanged: systemChange.subscribe };
});

const mockCheckLock = vi.mocked(checkLock);
const heldLock = { locked: true, stale: false, blocking_process: "pacman", holder_unknown: false } as LockStatus;
const freeLock = { locked: false, stale: false, holder_unknown: false } as LockStatus;

beforeEach(() => {
  mockCheckLock.mockReset();
  mockCheckLock.mockResolvedValue(heldLock);
});

function makePreview(overrides: Partial<TransactionPreview> = {}): TransactionPreview {
  return {
    success: true,
    add: [],
    remove: [],
    conflicts: [],
    replacements: [],
    providers: [],
    import_keys: [],
    warnings: [],
    blocked_by: [],
    total_download_size: 0,
    net_installed_size: 0,
    ...overrides,
  };
}

const firefoxPreview = makePreview({
  add: [{ name: "firefox", version: "130.0-1", repo: "extra", download_size: 70_000_000, installed_size: 250_000_000, reason: "target" }],
  total_download_size: 70_000_000,
  net_installed_size: 250_000_000,
});

function renderModal(config = installConfig, preview: (name: string) => Promise<TransactionPreview> = () => Promise.resolve(firefoxPreview)) {
  let callbacks: UpgradeCallbacks | undefined;
  const cancel = vi.fn();
  const forceStop = vi.fn();
  const onClose = vi.fn();
  const run = vi.fn((cb: UpgradeCallbacks) => {
    callbacks = cb;
    return { cancel, forceStop };
  });
  render(
    <PackageActionModal
      packageName="firefox"
      packageVersion="130.0-1"
      isOpen
      onClose={onClose}
      config={{ ...config, run, preview }}
    />,
    { wrapper: AnnouncerProvider }
  );
  return { cancel, forceStop, onClose, run, callbacks: () => callbacks! };
}

async function renderRunning() {
  const ctx = renderModal();
  fireEvent.click(await screen.findByRole("button", { name: "Install firefox" }));
  return ctx;
}

describe("PackageActionModal running progress", () => {
  afterEach(() => cleanup());

  it("stays indeterminate through downloads, then fills by transaction count", async () => {
    const { callbacks } = await renderRunning();
    const emit = async (event: StreamEvent) => {
      act(() => callbacks().onEvent?.(event));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, LOG_FLUSH_MS)); });
    };
    const bar = () => screen.getByRole("progressbar", { name: "Install progress" });

    await emit({ type: "download", filename: "firefox-130.0-1-x86_64.pkg.tar.zst", event: "progress", downloaded: 10, total: 100 });
    expect(bar()).toHaveAttribute("aria-valuenow", "0");
    expect(bar()).toHaveAttribute("aria-valuetext", "Downloading packages");

    await emit({ type: "progress", operation: "add_start", package: "nss", percent: 100, current: 1, total: 2 });
    const mid = Number(bar().getAttribute("aria-valuenow"));
    expect(mid).toBe(47);
    expect(bar()).toHaveAttribute("aria-valuetext", "47 percent, Installing packages, 1 of 2");

    await emit({ type: "progress", operation: "integrity_start", package: "", percent: 0, current: 1, total: 1 });
    expect(Number(bar().getAttribute("aria-valuenow"))).toBe(mid);
  });
});

describe("PackageActionModal dismissal and cancel", () => {
  afterEach(() => cleanup());

  it("names the commit button after the action and package", async () => {
    renderModal(installConfig);
    expect(await screen.findByRole("button", { name: "Install firefox" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Install firefox");
    cleanup();
    renderModal(uninstallConfig, () => Promise.resolve(makePreview({
      remove: [{ name: "firefox", version: "130.0-1", installed_size: 250_000_000, reason: "target" }],
      net_installed_size: -250_000_000,
    })));
    expect(await screen.findByRole("button", { name: "Remove firefox" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Remove firefox");
    sweepA11y({ dialogs: ["Remove firefox"] });
  });

  it("states what a removal does instead of asking for certainty", async () => {
    renderModal(uninstallConfig, () => Promise.resolve(makePreview({
      remove: [
        { name: "firefox", version: "130.0-1", installed_size: 250_000_000, reason: "target" },
        { name: "nss", version: "3.100-1", installed_size: 5_000_000, reason: "dependency" },
        { name: "nspr", version: "4.35-1", installed_size: 1_000_000, reason: "dependency" },
      ],
      net_installed_size: -256_000_000,
    })));
    const commit = await screen.findByRole("button", { name: "Remove firefox and 2 dependencies" });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Removes firefox and 2 dependencies that nothing else needs.");
    expect(dialog).toHaveTextContent("kept as .pacsave files");
    expect(dialog).not.toHaveTextContent(/are you sure/i);
    expect(commit).toHaveClass("pf-m-danger");
  });

  it("ignores Escape and backdrop clicks while running", async () => {
    const { cancel, onClose } = await renderRunning();

    fireEvent.keyDown(document.body, { key: "Escape" });
    const backdrop = document.querySelector(".pf-v6-c-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);

    expect(cancel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("progressbar", { name: "Install progress" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("asks before stopping, and Keep running leaves the transaction alone", async () => {
    const { cancel } = await renderRunning();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).not.toHaveBeenCalled();
    const keep = screen.getByRole("button", { name: "Keep running" });
    expect(keep).toHaveFocus();
    expect(keep).toHaveAccessibleDescription(/Stop installing firefox\?/);
    expect(screen.getByRole("button", { name: "Stop installing firefox" })).toHaveAccessibleDescription(/cannot be stopped/);

    fireEvent.click(keep);
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("stops on request and reports a transaction that finished anyway", async () => {
    const onSuccess = vi.fn();
    let callbacks: UpgradeCallbacks | undefined;
    const cancel = vi.fn();
    render(
      <PackageActionModal
        packageName="firefox"
        packageVersion="130.0-1"
        isOpen
        onClose={vi.fn()}
        onSuccess={onSuccess}
        config={{ ...installConfig, preview: () => Promise.resolve(firefoxPreview), run: (cb) => { callbacks = cb; return { cancel, forceStop: vi.fn() }; } }}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Install firefox" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop installing firefox" }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Cancelling…").length).toBeGreaterThan(0);
    const cancelling = screen.getByRole("button", { name: /Cancelling/ });
    expect(cancelling).toHaveAttribute("aria-disabled", "true");
    expect(cancelling).toHaveFocus();
    fireEvent.click(cancelling);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Install firefox" })).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);

    act(() => callbacks!.onComplete());
    expect(screen.getByRole("heading", { name: "The transaction finished before it could be stopped" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install firefox" })).not.toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toHaveTextContent("Close");
  });

  it("shows a neutral Stopped result with the log when the cancel takes effect", async () => {
    const { callbacks } = await renderRunning();
    act(() => callbacks().onData?.("resolving dependencies\n"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop installing firefox" }));

    act(() => callbacks().onError("Transaction cancelled", "cancelled"));
    expect(screen.getByRole("heading", { name: /Stopped/ })).toBeInTheDocument();
    expect(screen.getByRole("log")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
    expect(document.activeElement).toHaveTextContent("Close");
  });

  it("keeps cancellation pending while the backend finishes", async () => {
    const { forceStop, onClose, callbacks } = await renderRunning();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "Stop installing firefox" }));
      act(() => vi.advanceTimersByTime(CANCEL_WAIT_NOTICE_MS));
      expect(screen.getByText(/Waiting for the backend to stop safely/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Force stop" })).not.toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      expect(forceStop).not.toHaveBeenCalled();
      act(() => callbacks().onComplete());
      expect(screen.getByRole("heading", { name: /finished before it could be stopped/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers stale lock removal after a stop that left db.lck behind", async () => {
    const { callbacks } = await renderRunning();
    mockCheckLock.mockResolvedValue({ locked: true, stale: true, holder_unknown: false } as LockStatus);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop installing firefox" }));
    act(() => callbacks().onError("Transaction cancelled", "cancelled"));
    expect(await screen.findByRole("button", { name: "Remove stale lock and retry" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Database is locked/ })).toBeInTheDocument();
  });

  it("shows no lock recovery after a stop that left the database free", async () => {
    const { callbacks } = await renderRunning();
    mockCheckLock.mockResolvedValue(freeLock);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop installing firefox" }));
    act(() => callbacks().onError("Transaction cancelled", "cancelled"));
    await act(async () => {});
    expect(mockCheckLock).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /Database is locked/ })).not.toBeInTheDocument();
  });

  it("clears the waiting notice when cancellation completes", async () => {
    const { callbacks } = await renderRunning();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "Stop installing firefox" }));
      act(() => callbacks().onError("Transaction cancelled", "cancelled"));
      act(() => vi.advanceTimersByTime(CANCEL_WAIT_NOTICE_MS));
      await act(async () => {});
      expect(screen.queryByRole("button", { name: "Force stop" })).not.toBeInTheDocument();
      expect(document.querySelector('[role="status"][aria-live="polite"]')!.textContent).not.toMatch(/Force stop/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves focus to Try again when the stop ends in a failure", async () => {
    const { callbacks } = await renderRunning();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop installing firefox" }));

    act(() => callbacks().onError("failed to commit transaction", "transaction_failed"));
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
  });

  it("keeps the log on failure and Try again returns to the confirm step", async () => {
    const { callbacks, run } = await renderRunning();
    act(() => callbacks().onData?.("error: failed to commit transaction\n"));
    act(() => callbacks().onError("failed to commit transaction", "transaction_failed"));

    expect(screen.getByRole("heading", { name: /Install failed/ })).toBeInTheDocument();
    expect(screen.getByRole("log")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Install firefox" })).toBeInTheDocument();
  });
});

describe("PackageActionModal preview", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("blocks the commit when a signing key needs verification", async () => {
    const preview = makePreview({
      ...firefoxPreview,
      import_keys: [{ fingerprint: "ABCD", uid: "Packager <p@example.org>" }],
    });
    const { run } = renderModal(installConfig, () => Promise.resolve(preview));
    const commit = await screen.findByRole("button", { name: "Install firefox" });
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).toHaveAccessibleDescription("Verify and import the signing keys before retrying.");
    fireEvent.click(commit);
    expect(run).not.toHaveBeenCalled();

    expect(screen.queryByRole("checkbox", { name: /Import key/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Verify these fingerprints/)).toBeInTheDocument();
  });

  it("blocks the commit on a full disk, and Open Cache closes before switching tabs", async () => {
    const preview = makePreview({
      ...firefoxPreview,
      warnings: [{
        id: "disk_space", severity: "danger", title: "Not enough free space on /usr",
        message: "Needs about 0.2 GiB, 0.1 GiB free.", packages: [],
        blocking: true, disk: { mount: "/usr", deficit: 100 * 1024 * 1024, holds_cache: true },
      }],
    });
    const order: string[] = [];
    const onClose = vi.fn(() => order.push("close"));
    const onViewCache = vi.fn(() => order.push("cache"));
    const run = vi.fn();
    render(
      <NavigationProvider value={{ onViewCache }}>
        <PackageActionModal
          packageName="firefox"
          packageVersion="130.0-1"
          isOpen
          onClose={onClose}
          config={{ ...installConfig, preview: () => Promise.resolve(preview), run }}
        />
      </NavigationProvider>,
      { wrapper: AnnouncerProvider }
    );
    const commit = await screen.findByRole("button", { name: "Install firefox" });
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).toHaveAccessibleDescription(
      "Not enough free space on /usr. Free at least 100.0 MiB on /usr. Cleaning the package cache frees space on /usr."
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(commit);
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open Cache" }));
    expect(order).toEqual(["close", "cache"]);
  });

  it("lists the target and its dependencies and names them in the commit button", async () => {
    const preview = makePreview({
      add: [
        { name: "libdep-b", version: "2.0-1", repo: "extra", download_size: 2_000_000, installed_size: 6_000_000, reason: "dependency" },
        { name: "foo", version: "1.0-1", repo: "extra", download_size: 1_000_000, installed_size: 3_000_000, reason: "target" },
        { name: "libdep-a", version: "3.0-1", repo: "core", download_size: 500_000, installed_size: 1_000_000, reason: "dependency" },
      ],
      total_download_size: 3_500_000,
      net_installed_size: 10_000_000,
    });
    render(
      <PackageActionModal
        packageName="foo"
        packageVersion="1.0-1"
        isOpen
        onClose={vi.fn()}
        config={{ ...installConfig, preview: () => Promise.resolve(preview), run: vi.fn() }}
      />
    );

    expect(await screen.findByRole("button", { name: "Install foo and 2 dependencies" })).toBeInTheDocument();
    const table = screen.getByRole("grid", { name: "Will be installed" });
    const names = Array.from(table.querySelectorAll("tbody tr")).map(r => r.querySelector("td")!.textContent);
    expect(names).toEqual(["foo", "libdep-a", "libdep-b"]);
    const totals = formatPreviewTotals(preview);
    expect(totals.count).toBe(3);
    expect(screen.getByText(previewSummary(preview))).toBeInTheDocument();
    expect(screen.getByText("1.0-1", { selector: ".pf-v6-c-label__text" })).toBeInTheDocument();
  });

  it("shows the spinner text only after the preview has taken a second", async () => {
    vi.useFakeTimers();
    renderModal(installConfig, () => new Promise(() => {}));
    await act(async () => {});
    expect(screen.getByRole("progressbar", { name: "Checking what will change" })).toBeInTheDocument();
    expect(screen.queryByText(/Checking what will change…/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText(/Checking what will change…/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Install/ })).not.toBeInTheDocument();
  });

  it("blocks a removal that dependents need, without a commit button", async () => {
    const onViewDependencies = vi.fn();
    const onClose = vi.fn();
    const run = vi.fn();
    render(
      <NavigationProvider value={{ onViewDependencies }}>
        <PackageActionModal
          packageName="nss"
          packageVersion="3.100-1"
          isOpen
          onClose={onClose}
          config={{
            ...uninstallConfig,
            run,
            preview: () => Promise.resolve(makePreview({
              success: false,
              error: "could not satisfy dependencies",
              blocked_by: [{ target: "firefox", depend: "nss", causing: "nss" }],
            })),
          }}
        />
      </NavigationProvider>
    );

    expect(await screen.findByText("Cannot remove nss")).toBeInTheDocument();
    expect(screen.getByText("firefox requires nss")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "View dependents" }));
    expect(onViewDependencies).toHaveBeenCalledWith("nss");
    expect(onClose).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("gives an install with unsatisfied dependencies Check again, not View dependents", async () => {
    const onViewDependencies = vi.fn();
    const run = vi.fn();
    const preview = vi.fn()
      .mockResolvedValueOnce(makePreview({
        success: false,
        error: "could not satisfy dependencies",
        blocked_by: [{ target: "firefox", depend: "nss>=4", causing: "nss>=4" }],
      }))
      .mockResolvedValueOnce(firefoxPreview);
    render(
      <NavigationProvider value={{ onViewDependencies }}>
        <PackageActionModal
          packageName="firefox"
          packageVersion="130.0-1"
          isOpen
          onClose={vi.fn()}
          config={{ ...installConfig, run, preview }}
        />
      </NavigationProvider>
    );

    expect(await screen.findByText("Cannot install firefox")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View dependents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Install/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("button", { name: "Install firefox" })).toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(onViewDependencies).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("shows the lock alert for a locked database and Check again re-runs the preview once", async () => {
    const preview = vi.fn()
      .mockRejectedValueOnce(new BackendError("unable to lock database", "database_locked"))
      .mockResolvedValueOnce(firefoxPreview);
    renderModal(installConfig, preview);

    expect(await screen.findByText("Database is locked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install firefox" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("button", { name: "Install firefox" })).toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("re-runs the preview, never the commit, once the lock holder exits", async () => {
    vi.useFakeTimers();
    try {
      mockCheckLock.mockResolvedValueOnce(heldLock).mockResolvedValue(freeLock);
      const preview = vi.fn()
        .mockRejectedValueOnce(new BackendError("unable to lock database", "database_locked"))
        .mockResolvedValueOnce(firefoxPreview);
      const { run } = renderModal(installConfig, preview);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/Waiting for/)).toBeInTheDocument();
      expect(preview).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(preview).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Install firefox" })).toBeInTheDocument();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the preview stale on a system change, blocks the commit and refreshes it", async () => {
    const preview = vi.fn(() => Promise.resolve(firefoxPreview));
    const { run } = renderModal(installConfig, preview);
    const commit = await screen.findByRole("button", { name: "Install firefox" });
    expect(commit).not.toHaveAttribute("aria-disabled", "true");

    act(() => emitSystemChange("system"));
    expect(screen.getByRole("heading", { name: /The system changed since this preview/ })).toBeInTheDocument();
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).toHaveAccessibleDescription("The system changed since this preview");
    fireEvent.click(commit);
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    const refreshed = await screen.findByRole("button", { name: "Install firefox" });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: /The system changed since this preview/ })).not.toBeInTheDocument();
    expect(refreshed).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not mark the dialog stale once its own commit runs", async () => {
    await renderRunning();
    act(() => emitSystemChange("system"));
    expect(screen.queryByRole("heading", { name: /The system changed since this preview/ })).not.toBeInTheDocument();
    expect(systemChange.listeners.size).toBe(0);
  });

  it("announces the settled preview", async () => {
    render(
      <AnnouncerProvider>
        <PackageActionModal
          packageName="firefox"
          packageVersion="130.0-1"
          isOpen
          onClose={vi.fn()}
          config={{ ...installConfig, run: vi.fn(), preview: () => Promise.resolve(firefoxPreview) }}
        />
      </AnnouncerProvider>
    );
    await screen.findByRole("button", { name: "Install firefox" });
    const status = document.querySelector('[role="status"][aria-live="polite"]')!;
    await act(async () => {});
    expect(status.textContent).toMatch(/^Preview ready: 1 package/);
  });
});

describe("PackageActionModal signature failure", () => {
  afterEach(() => cleanup());

  it("closes itself before Open Keyring switches the tab", async () => {
    const calls: string[] = [];
    let callbacks: UpgradeCallbacks | undefined;
    const run = vi.fn((cb: UpgradeCallbacks) => {
      callbacks = cb;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    render(
      <NavigationProvider value={{ onViewKeyring: () => calls.push("keyring") }}>
        <PackageActionModal
          packageName="firefox"
          packageVersion="130.0-1"
          isOpen
          onClose={() => calls.push("close")}
          config={{ ...installConfig, run, preview: () => Promise.resolve(firefoxPreview) }}
        />
      </NavigationProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Install firefox" }));
    act(() => callbacks!.onError("firefox: signature from \"Packager\" is unknown trust", "signature_error"));

    fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
    expect(calls).toEqual(["close", "keyring"]);
  });

  it("names the failed install for the Keyring tab", async () => {
    const onViewKeyring = vi.fn();
    let callbacks: UpgradeCallbacks | undefined;
    const run = vi.fn((cb: UpgradeCallbacks) => {
      callbacks = cb;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    render(
      <NavigationProvider value={{ onViewKeyring }}>
        <PackageActionModal
          packageName="firefox"
          packageVersion="130.0-1"
          isOpen
          onClose={vi.fn()}
          config={{ ...installConfig, run, preview: () => Promise.resolve(firefoxPreview) }}
        />
      </NavigationProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Install firefox" }));
    act(() => callbacks!.onError("firefox: signature from \"Packager\" is unknown trust", "signature_error"));
    fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
    expect(onViewKeyring).toHaveBeenCalledWith({ origin: "install", target: "firefox", retry: undefined });
  });
});

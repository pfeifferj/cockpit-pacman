import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { OrphansView } from "./OrphansView";
import { TransactionHost, TransactionHostProvider } from "./TransactionHost";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { CANCEL_WAIT_NOTICE_MS } from "./CancellationNotice";
import * as api from "../api";
import { mockPermission, mockSpawn } from "../test/setup";
import { createMockStreamingProcess } from "../test/mocks";
import { sweepA11y } from "../test/a11ySweep";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listOrphans: vi.fn(),
    removeOrphans: vi.fn(),
    previewRemoveOrphans: vi.fn(),
    checkLock: vi.fn(),
    listIgnoredPackages: vi.fn(async () => ({ packages: [], total: 0 })),
  };
});

const mockListOrphans = vi.mocked(api.listOrphans);
const mockRemoveOrphans = vi.mocked(api.removeOrphans);
const mockCheckLock = vi.mocked(api.checkLock);
const mockPreviewRemoveOrphans = vi.mocked(api.previewRemoveOrphans);

const previewFor = (names: string[], alsoRemoved: string[] = []): api.TransactionPreview => ({
  success: true,
  add: [],
  remove: [
    ...names.map(name => ({ name, version: "1", installed_size: 1000, reason: "target" as const })),
    ...alsoRemoved.map(name => ({ name, version: "1", installed_size: 1000, reason: "dependency" as const })),
  ],
  conflicts: [],
  replacements: [],
  providers: [],
  import_keys: [],
  warnings: [],
  blocked_by: [],
  total_download_size: 0,
  net_installed_size: -1000 * (names.length + alsoRemoved.length),
});

const checkbox = (name: string) =>
  screen.getByText(name).closest("tr")!.querySelector("input[type=checkbox]") as HTMLInputElement;

const confirmStop = () => {
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop removing orphan packages" }));
};

async function openConfirmAndRemove() {
  fireEvent.click(screen.getByRole("button", { name: /^Remove \d+ orphans?/ }));
  const confirm = await screen.findByRole("button", { name: /^Remove \d+ orphans?$/ });
  fireEvent.click(confirm);
}

const completeUpgrade = () => {
  const proc = createMockStreamingProcess();
  mockSpawn.mockReturnValue(proc);
  api.runUpgrade({ onComplete: () => {}, onError: () => {} });
  proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n"); proc._complete();
};

const mockOrphanResponse: api.OrphanResponse = {
  orphans: [
    {
      name: "libunused",
      version: "1.0.0-1",
      description: "An unused library",
      installed_size: 5000000,
      install_date: 1704067200,
      repository: "extra",
    },
    {
      name: "old-dep",
      version: "2.3.1-1",
      description: "Old dependency",
      installed_size: 12000000,
      install_date: 1700000000,
      repository: "core",
    },
  ],
  total_size: 17000000,
};

describe("OrphansView", () => {
  const defaultProps = {
    onRowClick: vi.fn(),
    onOrphansLoaded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListOrphans.mockResolvedValue(mockOrphanResponse);
    mockPreviewRemoveOrphans.mockImplementation(async (names) => previewFor(names ?? []));
    mockCheckLock.mockResolvedValue({ locked: true, stale: false, blocking_process: "pacman", holder_unknown: false } as api.LockStatus);
  });

  afterEach(() => {
    cleanup();
    mockPermission.mockImplementation(() => ({
      allowed: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    }));
  });

  it("shows loading spinner initially", () => {
    mockListOrphans.mockImplementation(() => new Promise(() => {}));
    render(<OrphansView {...defaultProps} />);
    expect(screen.getByText(/Checking for orphan packages/i)).toBeInTheDocument();
  });

  it("renders orphan packages after loading", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    expect(screen.getByText("old-dep")).toBeInTheDocument();
    expect(screen.getByText("1.0.0-1")).toBeInTheDocument();
    expect(screen.getByText("2.3.1-1")).toBeInTheDocument();
  });

  it("calls onOrphansLoaded with count", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(defaultProps.onOrphansLoaded).toHaveBeenCalledWith(2);
    });
  });

  it("shows error on API failure", async () => {
    mockListOrphans.mockRejectedValue(new Error("Permission denied"));
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Error loading orphans/i)).toBeInTheDocument();
    });
  });

  it("shows lock error message when database is locked", async () => {
    mockListOrphans.mockRejectedValue(new Error("unable to lock database"));
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Database is locked/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when no orphans", async () => {
    mockListOrphans.mockResolvedValue({ orphans: [], total_size: 0 });
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /No orphan packages/i })).toBeInTheDocument();
    });
  });

  it("previews the selected orphans before confirming", async () => {
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");
    sweepA11y();

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 orphans" }));

    expect(await screen.findByText("Remove orphan packages?")).toBeInTheDocument();
    expect(mockPreviewRemoveOrphans).toHaveBeenCalledWith(["libunused", "old-dep"]);
    expect(await screen.findByRole("grid", { name: "Will be removed" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Remove orphan packages?");
    sweepA11y({ dialogs: ["Remove orphan packages?"] });
  });

  it("starts removal of the selected names when confirming", async () => {
    mockRemoveOrphans.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    await openConfirmAndRemove();

    expect(mockRemoveOrphans).toHaveBeenCalledWith(expect.anything(), ["libunused", "old-dep"], ["libunused", "old-dep"]);
  });

  it("selects every orphan on load and removes only the checked ones", async () => {
    const actual = await vi.importActual<typeof api>("../api");
    mockRemoveOrphans.mockImplementation(actual.removeOrphans);
    mockSpawn.mockReturnValue(createMockStreamingProcess());
    mockListOrphans.mockResolvedValue({
      orphans: [
        ...mockOrphanResponse.orphans,
        { ...mockOrphanResponse.orphans[0], name: "bar", description: "Bar" },
      ],
      total_size: 22000000,
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("bar");

    expect(checkbox("libunused")).toBeChecked();
    expect(checkbox("old-dep")).toBeChecked();
    expect(checkbox("bar")).toBeChecked();
    fireEvent.click(checkbox("old-dep"));
    expect(screen.getByRole("button", { name: "Remove 2 orphans" })).toBeInTheDocument();

    await openConfirmAndRemove();

    const argv = mockSpawn.mock.calls[0][0] as string[];
    expect(argv.slice(argv.indexOf("remove-orphans"))).toEqual(["remove-orphans", "", "libunused,bar", "libunused,bar"]);
  });

  it("counts recursive removals in the confirm button and lists them", async () => {
    mockPreviewRemoveOrphans.mockImplementation(async (names) => previewFor(names ?? [], ["libextra"]));
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 orphans" }));

    expect(await screen.findByRole("button", { name: "Remove 3 orphans" })).toHaveClass("pf-m-danger");
    expect(screen.getByRole("grid", { name: "Also removed (no longer needed)" })).toHaveTextContent("libextra");
  });

  it("names selected rows hidden by the filter and selects all over filtered rows only", async () => {
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    fireEvent.change(screen.getByPlaceholderText(/Filter orphans/), { target: { value: "old" } });
    expect(screen.getByRole("button", { name: "Remove 2 orphans (1 hidden by filter)" })).toBeInTheDocument();

    const selectAll = screen.getByRole("checkbox", { name: "Select all matching orphans" });
    fireEvent.click(selectAll);
    expect(screen.getByRole("button", { name: "Remove 1 orphan (1 hidden by filter)" })).toBeInTheDocument();
    fireEvent.click(selectAll);
    expect(screen.getByRole("button", { name: "Remove 2 orphans (1 hidden by filter)" })).toBeInTheDocument();
  });

  it("disables removal with nothing selected", async () => {
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all orphans" }));

    expect(screen.getByRole("button", { name: "Remove 0 orphans" })).toHaveAttribute("aria-disabled", "true");
  });

  it("toggles selection on Space in a row checkbox without opening details", async () => {
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    const box = checkbox("libunused");
    fireEvent.keyDown(box, { key: " " });
    fireEvent.click(box);

    expect(box).not.toBeChecked();
    expect(defaultProps.onRowClick).not.toHaveBeenCalled();
  });

  it("stays closed when a preview resolves after Cancel", async () => {
    let resolvePreview: (p: api.TransactionPreview) => void = () => {};
    mockPreviewRemoveOrphans.mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve; }));
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 orphans" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await act(async () => {
      resolvePreview(previewFor(["libunused", "old-dep"]));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers Check again when the preview fails, and re-runs it once", async () => {
    mockPreviewRemoveOrphans.mockRejectedValueOnce(new api.BackendError("unable to lock database", "database_locked"));
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 orphans" }));
    expect(await screen.findByText("Database is locked")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("button", { name: "Remove 2 orphans", hidden: false })).toBeInTheDocument();
    expect(mockPreviewRemoveOrphans).toHaveBeenCalledTimes(2);
  });

  it("keeps the selection after a failure and resets it after success", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRemoveOrphans.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    fireEvent.click(checkbox("old-dep"));
    await openConfirmAndRemove();
    await act(async () => {
      capturedCallbacks?.onError("transaction failed");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to orphan list" }));
    });
    await screen.findByText("old-dep");
    expect(checkbox("old-dep")).not.toBeChecked();

    await openConfirmAndRemove();
    await act(async () => {
      capturedCallbacks?.onComplete();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to orphan list" }));
    });
    await screen.findByText("old-dep");
    expect(checkbox("old-dep")).toBeChecked();
  });

  it("waits for the backend after Cancel and reports a stop with the log", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    const cancel = vi.fn();
    mockRemoveOrphans.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel, forceStop: vi.fn() };
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    await openConfirmAndRemove();
    act(() => capturedCallbacks?.onData?.("checking dependencies\n"));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("pf-m-secondary");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Keep running" })).toHaveFocus();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    confirmStop();

    expect(cancel).toHaveBeenCalledTimes(1);
    const cancelling = screen.getByRole("button", { name: /Cancelling/ });
    expect(cancelling).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(cancelling);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("log")).toBeInTheDocument();

    await act(async () => {
      capturedCallbacks?.onError("Transaction cancelled", "cancelled");
    });
    expect(screen.getByText("Orphan removal stopped")).toBeInTheDocument();
    expect(screen.getByRole("log")).toBeInTheDocument();
  });

  it("shows success state after removal completes", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRemoveOrphans.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    await openConfirmAndRemove();

    await act(async () => {
      capturedCallbacks?.onComplete();
    });

    await waitFor(() => {
      expect(screen.getByText(/Orphan packages removed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Removed 2 packages, freeing/)).toBeInTheDocument();
    const removed = screen.getByRole("list", { name: "Removed packages" });
    expect(within(removed).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["libunused", "old-dep"]);
  });

  it("collapses a removed-name list longer than ten", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `orphan${i}`);
    mockPreviewRemoveOrphans.mockImplementation(async () => previewFor(names));
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRemoveOrphans.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");
    await openConfirmAndRemove();
    await act(async () => capturedCallbacks?.onComplete());

    const toggle = screen.getByRole("button", { name: "Show 12 removed packages" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(within(screen.getByRole("list", { name: "Removed packages" })).getAllByRole("listitem")).toHaveLength(12);
  });

  it("filters orphans by search input", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Filter orphans/);
    fireEvent.change(searchInput, { target: { value: "libunused" } });

    expect(screen.getByText("libunused")).toBeInTheDocument();
    expect(screen.queryByText("old-dep")).not.toBeInTheDocument();
  });

  it("calls onRowClick when clicking a package row", async () => {
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    const rows = screen.getAllByRole("row");
    // First data row (index 1, after header)
    fireEvent.click(rows[1]);

    expect(defaultProps.onRowClick).toHaveBeenCalledWith("libunused");
  });

  it("offers Clear filter on a filter miss, which restores the list", async () => {
    render(<OrphansView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("libunused")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Filter orphans/);
    fireEvent.change(searchInput, { target: { value: "no-such-orphan" } });
    expect(screen.queryByText("libunused")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(screen.getByText("libunused")).toBeInTheDocument();
    expect(screen.getByText("old-dep")).toBeInTheDocument();
    expect(document.activeElement).toBe(searchInput);
  });

  it("renders the lock recovery body for a locked database", async () => {
    mockListOrphans.mockRejectedValue(new api.BackendError("unable to lock database", "database_locked"));
    render(<OrphansView {...defaultProps} />);

    await waitFor(() => expect(mockCheckLock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("pacman")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("requires a fresh removal preview after another transaction completes", async () => {
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 orphans" }));
    const commit = await screen.findByRole("button", { name: "Remove 2 orphans" });
    await act(async () => completeUpgrade());
    expect(commit).toHaveAccessibleDescription("The system changed since this preview");
    fireEvent.click(commit);
    expect(mockRemoveOrphans).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await waitFor(() => expect(mockPreviewRemoveOrphans).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Remove 2 orphans" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("blocks orphan removal when a signing key needs verification", async () => {
    mockPreviewRemoveOrphans.mockImplementation(async (names) => ({
      ...previewFor(names ?? []),
      import_keys: [{ fingerprint: "ABCD", uid: "Packager <p@example.org>" }],
    }));
    mockRemoveOrphans.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");
    fireEvent.click(screen.getByRole("button", { name: /^Remove 2 orphans/ }));
    const commit = await screen.findByRole("button", { name: "Remove 2 orphans" });
    expect(commit).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(commit);
    expect(mockRemoveOrphans).not.toHaveBeenCalled();

    expect(screen.queryByRole("checkbox", { name: /Import key/ })).not.toBeInTheDocument();
    expect(commit).toHaveAccessibleDescription("Verify and import the signing keys before retrying.");
  });

  it("re-runs a confirm preview that failed on a lock once the lock is free", async () => {
    mockPreviewRemoveOrphans
      .mockRejectedValueOnce(new api.BackendError("unable to lock database", "database_locked"))
      .mockImplementation(async (names) => previewFor(names ?? []));
    mockCheckLock.mockResolvedValue({ locked: false, stale: false, holder_unknown: false } as api.LockStatus);
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");
    fireEvent.click(screen.getByRole("button", { name: /^Remove 2 orphans/ }));

    expect(await screen.findByRole("button", { name: "Remove 2 orphans" })).toBeInTheDocument();
    expect(mockPreviewRemoveOrphans).toHaveBeenCalledTimes(2);
    expect(mockPreviewRemoveOrphans).toHaveBeenLastCalledWith(["libunused", "old-dep"]);
  });

  it("keeps a cancelled removal pending until the backend responds", async () => {
    let callbacks: api.UpgradeCallbacks | undefined;
    const forceStop = vi.fn();
    mockRemoveOrphans.mockImplementation((next) => {
      callbacks = next;
      return { cancel: vi.fn(), forceStop };
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");
    await openConfirmAndRemove();
    vi.useFakeTimers();
    try {
      confirmStop();
      act(() => vi.advanceTimersByTime(CANCEL_WAIT_NOTICE_MS));
      expect(screen.getByText(/Waiting for the backend to stop safely/)).toBeInTheDocument();
      expect(forceStop).not.toHaveBeenCalled();
      expect(screen.queryByText("Orphan removal stopped")).not.toBeInTheDocument();
      act(() => callbacks?.onError("Operation cancelled", "cancelled"));
      expect(screen.getByText("Orphan removal stopped")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed load", async () => {
    mockListOrphans.mockRejectedValueOnce(new Error("Permission denied"));
    render(<OrphansView {...defaultProps} />);
    const retry = await screen.findByRole("button", { name: "Try again" });

    await act(async () => {
      fireEvent.click(retry);
    });

    expect(mockListOrphans).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("libunused")).toBeInTheDocument();
  });

  it("reports a removal failure as such and keeps the log", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRemoveOrphans.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    await openConfirmAndRemove();
    await act(async () => {
      capturedCallbacks?.onData?.("removing libunused\n");
      capturedCallbacks?.onError("transaction failed");
    });

    expect(screen.getByText("Orphan removal failed")).toBeInTheDocument();
    expect(screen.queryByText(/Error loading orphans/)).not.toBeInTheDocument();
    expect(screen.getByRole("log")).toBeInTheDocument();
  });

  it("reloads in the background after a system change, keeping the filter", async () => {
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter orphans" }), { target: { value: "old" } });

    mockListOrphans.mockClear();
    mockListOrphans.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      completeUpgrade();
    });

    expect(mockListOrphans).toHaveBeenCalledTimes(1);
    expect(screen.getByText("old-dep")).toBeInTheDocument();
    expect(screen.queryByText(/Checking for orphan packages/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filter orphans" })).toHaveValue("old");
  });

  it.each(["success", "failure"] as const)("keeps removal running when a pending background load settles with %s", async (outcome) => {
    let resolveLoad!: (response: api.OrphanResponse) => void;
    let rejectLoad!: (error: Error) => void;
    const backgroundLoad = new Promise<api.OrphanResponse>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    let callbacks!: api.UpgradeCallbacks;
    const cancel = vi.fn();
    mockRemoveOrphans.mockImplementation((removalCallbacks) => {
      callbacks = removalCallbacks;
      return { cancel, forceStop: vi.fn() };
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    mockListOrphans.mockReturnValueOnce(backgroundLoad);
    await act(async () => completeUpgrade());
    expect(mockListOrphans).toHaveBeenCalledTimes(2);

    await openConfirmAndRemove();
    act(() => callbacks.onData?.("removing libunused\n"));
    expect(screen.getByText("Removing orphan packages")).toBeInTheDocument();
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const runningLog = screen.getByRole("log");

    await act(async () => {
      if (outcome === "success") resolveLoad(mockOrphanResponse);
      else rejectLoad(new Error("background refresh failed"));
    });

    expect(screen.getByText("Removing orphan packages")).toBeInTheDocument();
    expect(screen.getByRole("log")).toBe(runningLog);
    expect(screen.getByRole("button", { name: "Cancel" })).toBe(cancelButton);
    expect(screen.queryByText("Error loading orphans")).not.toBeInTheDocument();
    expect(defaultProps.onOrphansLoaded).toHaveBeenCalledTimes(1);

    fireEvent.click(cancelButton);
    fireEvent.click(screen.getByRole("button", { name: "Stop removing orphan packages" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Removing orphan packages")).toBeInTheDocument();
    expect(screen.getByRole("log")).toBe(runningLog);
    expect(screen.getByRole("button", { name: /Cancelling/ })).toHaveAttribute("aria-disabled", "true");

    act(() => callbacks.onComplete());
    expect(screen.getByText("Orphan packages removed")).toBeInTheDocument();
    expect(screen.getByText(/The removal finished before it could be stopped/)).toBeInTheDocument();
    expect(screen.queryByText("Removing orphan packages")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
  });

  it("gates removal without administrative access", async () => {
    mockPermission.mockImplementation(() => ({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    }));
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    const button = screen.getByRole("button", { name: "Remove 2 orphans" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(screen.queryByText("Remove orphan packages?")).not.toBeInTheDocument();
    expect(mockPreviewRemoveOrphans).not.toHaveBeenCalled();

  });
  it("gates removal while another transaction runs, and while access is unknown", async () => {
    const upgrade = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(upgrade);
    act(() => {
      api.runUpgrade({ onComplete: vi.fn(), onError: vi.fn() });
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");

    const button = screen.getByRole("button", { name: "Remove 2 orphans" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      button.focus();
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("An upgrade is running.");

    act(() => {
      upgrade._emit(JSON.stringify({ type: "complete", success: true }) + "\n"); upgrade._complete();
    });
    expect(screen.getByRole("button", { name: "Remove 2 orphans" })).not.toHaveAttribute("aria-disabled");

    cleanup();
    mockPermission.mockReturnValueOnce({
      allowed: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });
    render(<OrphansView {...defaultProps} />);
    await screen.findByText("libunused");
    const pending = screen.getByRole("button", { name: "Remove 2 orphans" });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      pending.focus();
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Checking administrative access…");
  });

  describe("when the view unmounts during a removal", () => {
    const Page: React.FC<{ show: boolean }> = ({ show }) => (
      <AnnouncerProvider>
        <TransactionHostProvider>
          <TransactionHost />
          {show && <OrphansView {...defaultProps} />}
        </TransactionHostProvider>
      </AnnouncerProvider>
    );

    /** Every non-empty text the polite live region shows, in order. */
    function recordAnnouncements(): string[] {
      const seen: string[] = [];
      const region = document.querySelector('[aria-live="polite"]')!;
      const observer = new MutationObserver(() => {
        const text = region.textContent ?? "";
        if (text) seen.push(text);
      });
      observer.observe(region, { childList: true, subtree: true, characterData: true });
      return seen;
    }

    function startHeldRemoval() {
      let callbacks!: api.UpgradeCallbacks;
      const handle = { cancel: vi.fn(), forceStop: vi.fn() };
      mockRemoveOrphans.mockImplementation((removalCallbacks) => {
        callbacks = removalCallbacks;
        return handle;
      });
      return { handle, callbacks: () => callbacks };
    }

    it("keeps the run going and reports its outcome once in the host", async () => {
      const { handle, callbacks } = startHeldRemoval();
      const { rerender } = render(<Page show />);
      await screen.findByText("libunused");
      await openConfirmAndRemove();
      act(() => callbacks().onData?.("removing libunused\n"));
      const announcements = recordAnnouncements();

      rerender(<Page show={false} />);
      expect(handle.cancel).not.toHaveBeenCalled();
      expect(handle.forceStop).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Removing 2 orphan packages/ })).not.toBeInTheDocument();

      await act(async () => callbacks().onComplete());
      expect(screen.getByRole("heading", { name: /Removed 2 orphan packages$/ })).toBeInTheDocument();
      expect(announcements.filter((text) => text === "Removed 2 orphan packages")).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "View result" }));
      const dialog = screen.getByRole("dialog", { name: "Removed 2 orphan packages" });
      sweepA11y({ dialogs: ["Removed 2 orphan packages"] });
      expect(dialog).toHaveTextContent("Orphan packages removed");
      expect(dialog).toHaveTextContent("removing libunused");
      const closeButtons = within(dialog).getAllByRole("button", { name: "Close" });
      fireEvent.click(closeButtons[closeButtons.length - 1]);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Removed 2 orphan packages$/ })).not.toBeInTheDocument();
    });

    it("takes the run back when it mounts again, and Cancel stops it once", async () => {
      const { handle, callbacks } = startHeldRemoval();
      const { rerender } = render(<Page show />);
      await screen.findByText("libunused");
      await openConfirmAndRemove();
      act(() => callbacks().onData?.("removing libunused\n"));

      rerender(<Page show={false} />);
      act(() => callbacks().onData?.("removing old-dep\n"));
      rerender(<Page show />);

      expect(screen.getByText("Removing orphan packages")).toBeInTheDocument();
      const log = screen.getByRole("log");
      await waitFor(() => expect(log).toHaveTextContent("removing libunused"));
      await waitFor(() => expect(log).toHaveTextContent("removing old-dep"));
      expect(screen.queryByRole("button", { name: "Remove 2 orphans" })).not.toBeInTheDocument();

      confirmStop();
      expect(handle.cancel).toHaveBeenCalledTimes(1);
      await act(async () => callbacks().onError("Transaction cancelled", "cancelled"));
      expect(screen.getByText("Orphan removal stopped")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Stopped removing 2 orphan packages/ })).not.toBeInTheDocument();
      expect(handle.cancel).toHaveBeenCalledTimes(1);
    });

    it("shows a run that ended in the background as its result when it mounts again", async () => {
      const { callbacks } = startHeldRemoval();
      const { rerender } = render(<Page show />);
      await screen.findByText("libunused");
      await openConfirmAndRemove();

      rerender(<Page show={false} />);
      await act(async () => callbacks().onError("transaction failed", "transaction_failed"));
      expect(screen.getByRole("heading", { name: /Failed to remove 2 orphan packages/ })).toBeInTheDocument();

      rerender(<Page show />);
      expect(screen.getByText("Orphan removal failed")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Failed to remove 2 orphan packages/ })).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Back to orphan list" }));
      });
      expect(await screen.findByText("libunused")).toBeInTheDocument();
    });

    it("cancels the run when no host can keep it", async () => {
      const { handle } = startHeldRemoval();
      const { unmount } = render(<OrphansView {...defaultProps} />);
      await screen.findByText("libunused");
      await openConfirmAndRemove();
      unmount();
      expect(handle.cancel).toHaveBeenCalledTimes(1);
    });
  });
});


describe("OrphansView cancellation", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("keeps removal busy until the process settles, including a parent refresh", async () => {
    mockListOrphans.mockResolvedValue(mockOrphanResponse);
    mockPreviewRemoveOrphans.mockImplementation(async names => previewFor(names ?? []));
    const cancel = vi.fn();
    mockRemoveOrphans.mockReturnValue({ cancel, forceStop: vi.fn() });
    const onRowClick = vi.fn();
    const { rerender } = render(<OrphansView onRowClick={onRowClick} refreshTrigger={0} />);
    await screen.findByText("libunused");
    await openConfirmAndRemove();
    confirmStop();
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Cancelling/ })).toHaveAttribute("aria-disabled", "true");
    rerender(<OrphansView onRowClick={onRowClick} refreshTrigger={1} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Remove 2 orphans" })).not.toBeInTheDocument();
    act(() => mockRemoveOrphans.mock.lastCall![0].onError("Commit failed", "transaction_failed", "Filesystem read-only"));
    expect(screen.getByText("Filesystem read-only")).toBeInTheDocument();
  });
});

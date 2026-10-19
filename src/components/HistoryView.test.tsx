import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act, within } from "@testing-library/react";
import { HistoryView } from "./HistoryView";
import { sweepA11y } from "../test/a11ySweep";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { DowngradeProvider } from "../contexts/DowngradeContext";
import { TabActiveContext } from "../hooks/useRefreshOnActivate";
import * as api from "../api";
import { mockGroupedLogResponse, mockLogGroups, mockLogResponse, mockPackageDetails, createMockStreamingProcess } from "../test/mocks";
import { mockSpawn } from "../test/setup";

const completeUpgrade = () => {
  const proc = createMockStreamingProcess();
  mockSpawn.mockReturnValue(proc);
  api.runUpgrade({ onComplete: () => {}, onError: () => {} });
  proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
  proc._complete();
};

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getGroupedHistory: vi.fn(),
    getHistory: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
    getScheduledRuns: vi.fn(),
    getScheduleConfig: vi.fn(),
    listIgnoredPackages: vi.fn(async () => ({ packages: [], total: 0 })),
    listDowngrades: vi.fn(),
    listArchiveVersions: vi.fn(),
    previewDowngrade: vi.fn(),
  };
});

const mockGetGroupedHistory = vi.mocked(api.getGroupedHistory);
const mockGetHistory = vi.mocked(api.getHistory);
const mockGetScheduledRuns = vi.mocked(api.getScheduledRuns);

const scheduledRun = (timestamp: string, duration_secs: number | null): api.ScheduledRunEntry => ({
  timestamp,
  mode: "upgrade",
  success: true,
  status: "ok",
  packages_checked: 3,
  packages_upgraded: 3,
  error: null,
  details: [],
  duration_secs,
  removed_stale_lock: false,
});

describe("HistoryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGroupedHistory.mockResolvedValue(mockGroupedLogResponse);
    mockGetHistory.mockResolvedValue(mockLogResponse);
    mockGetScheduledRuns.mockResolvedValue({ runs: [], total: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps separate transaction parts expanded independently after refreshing", async () => {
    const part1 = { ...mockLogGroups[0], id: "old-1", part: 1, parts: 2 };
    const part2 = { ...part1, id: "old-2", part: 2 };
    mockGetGroupedHistory.mockResolvedValueOnce({ ...mockGroupedLogResponse, groups: [part1, part2] });
    mockGetGroupedHistory.mockResolvedValue({ ...mockGroupedLogResponse, groups: [
      { ...part1, id: "new-1" }, { ...part2, id: "new-2" },
    ] });
    render(<HistoryView />);
    expect(await screen.findByText("Part 1 of 2")).toBeInTheDocument();
    fireEvent.click(document.getElementById("old-1-toggle")!);
    await act(async () => completeUpgrade());
    await waitFor(() => expect(document.getElementById("new-1-toggle")).toHaveAttribute("aria-expanded", "true"));
    expect(document.getElementById("new-2-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("aborts the history load when unmounted", async () => {
    mockGetGroupedHistory.mockImplementation(() => new Promise(() => {}));
    mockGetHistory.mockImplementation(() => new Promise(() => {}));
    const view = render(<HistoryView />);
    await waitFor(() => expect(mockGetGroupedHistory).toHaveBeenCalledOnce());
    const first = mockGetGroupedHistory.mock.calls[0][0]?.signal;
    view.unmount();
    expect(first?.aborted).toBe(true);
  });

  it("shows loading state initially", () => {
    mockGetGroupedHistory.mockImplementation(() => new Promise(() => {}));
    render(<HistoryView />);
    expect(screen.getByText(/Loading history/i)).toBeInTheDocument();
  });

  it("renders history data after loading", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });
    sweepA11y();

    // Stat boxes show upgraded/installed/removed counts
    expect(screen.getByText("Upgraded")).toBeInTheDocument();
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
  });

  it("formats a group's package count", async () => {
    const [first] = mockLogGroups;
    const entries = Array.from({ length: 1000 }, (_, i) => ({ ...first.entries[0], package: `pkg-${i}` }));
    mockGetGroupedHistory.mockResolvedValue({ ...mockGroupedLogResponse, groups: [{ ...first, entries }] });
    render(<HistoryView />);
    expect(await screen.findByText("(1,000 packages)")).toBeInTheDocument();
    expect(screen.queryByText("pkg-0")).not.toBeInTheDocument();
  });

  it("shows package details in a panel that keeps the expanded group and returns focus to the row", async () => {
    vi.mocked(api.getPackageInfo).mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
    render(<HistoryView />);
    await screen.findByLabelText("Filter history by package name");
    fireEvent.click(document.getElementById("group-0-toggle")!);
    const nameButton = (name: string) => screen.getByRole("button", { name });

    fireEvent.click(nameButton("linux"));
    await screen.findByRole("region", { name: /^linux/ });
    nameButton("systemd").focus();
    fireEvent.click(nameButton("systemd"));
    await screen.findByRole("region", { name: /^systemd/ });

    expect(screen.queryByRole("region", { name: /^linux/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(nameButton("systemd").closest("tr")).toHaveAttribute("aria-current", "true");
    expect(nameButton("linux").closest("tr")).not.toHaveAttribute("aria-current");
    expect(document.getElementById("group-0-toggle")).toHaveAttribute("aria-expanded", "true");
    sweepA11y();

    fireEvent.keyDown(nameButton("systemd"), { key: "ArrowDown" });
    expect(nameButton("systemd")).toHaveFocus();
    expect(api.getPackageInfo).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: /^systemd/ })).not.toBeInTheDocument());
    expect(nameButton("systemd")).toHaveFocus();
  });

  it("shows error state on API failure", async () => {
    mockGetGroupedHistory.mockRejectedValue(new Error("Failed to read log"));
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText(/Could not load history/i)).toBeInTheDocument();
    });
  });

  it("shows retry button on error", async () => {
    mockGetGroupedHistory.mockRejectedValue(new Error("Failed"));
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });
  });

  it("shows empty state when no history", async () => {
    mockGetGroupedHistory.mockResolvedValue({
      groups: [],
      total_groups: 0,
      total_upgraded: 0,
      total_installed: 0,
      total_removed: 0,
      total_other: 0,
    });
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByText(/No history found/i)).toBeInTheDocument();
    });
  });

  it("expands accordion group on click", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });

    // Click on the first group toggle (should contain "3 packages")
    const toggles = screen.getAllByText(/packages\)/i);
    fireEvent.click(toggles[0]);

    // After expanding, entries should be visible
    await waitFor(() => {
      expect(screen.getByText("linux")).toBeInTheDocument();
    });
  });

  it("toggles expand all / collapse all", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });

    const expandButton = screen.getByRole("button", { name: /Expand all/i });
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Collapse all/i })).toBeInTheDocument();
    });

    // Should show entries from all groups
    expect(screen.getByText("linux")).toBeInTheDocument();
    expect(screen.getByText("neovim")).toBeInTheDocument();
  });

  it("has filter dropdown with action options", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });

    // Default filter shows "All actions"
    expect(screen.getByText("All actions")).toBeInTheDocument();
  });

  it("has search input", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("Filter by package name…")).toBeInTheDocument();
  });

  it("keeps search input mounted during refetch", async () => {
    let resolveSecondCall: (value: api.GroupedLogResponse) => void;
    mockGetGroupedHistory
      .mockResolvedValueOnce(mockGroupedLogResponse)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondCall = resolve; }));

    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Filter by package name…");
    fireEvent.change(searchInput, { target: { value: "linux" } });

    // Wait for debounce to trigger the second API call
    await waitFor(() => {
      expect(mockGetGroupedHistory).toHaveBeenCalledTimes(2);
    });

    // Search input must remain in the DOM during the refetch
    expect(screen.getByPlaceholderText("Filter by package name…")).toBeInTheDocument();

    // Resolve the pending fetch and verify the input is still there
    resolveSecondCall!(mockGroupedLogResponse);
    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("Filter by package name…")).toBeInTheDocument();
  });

  it("shows inline error when refetch fails after data loaded", async () => {
    mockGetGroupedHistory
      .mockResolvedValueOnce(mockGroupedLogResponse)
      .mockRejectedValueOnce(new Error("Network error"));

    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Filter by package name…");
    fireEvent.change(searchInput, { target: { value: "badquery" } });

    // Wait for the refetch error to appear inline (toolbar still mounted)
    await waitFor(
      () => {
        expect(screen.getByText(/Could not load history/i)).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(screen.getByPlaceholderText("Filter by package name…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("switching to Flat fetches getHistory and renders entries", async () => {
    render(<HistoryView />);

    await waitFor(() => {
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    });
    expect(mockGetHistory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Flat" }));

    await waitFor(() => {
      expect(mockGetHistory).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getAllByRole("row")).toHaveLength(mockLogResponse.entries.length + 1);
    });
    // Expand/Collapse-all button is grouped-only.
    expect(screen.queryByRole("button", { name: /Expand all|Collapse all/i })).not.toBeInTheDocument();
  });

  const emptyGrouped: api.GroupedLogResponse = {
    groups: [],
    total_groups: 0,
    total_upgraded: 3,
    total_installed: 2,
    total_removed: 1,
    total_other: 0,
  };

  const lastParams = () => mockGetGroupedHistory.mock.lastCall?.[0];

  it("announces the settled count after a filter change, not on first load", async () => {
    render(<AnnouncerProvider><HistoryView /></AnnouncerProvider>);
    const status = screen.getByRole("status");
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    expect(status.textContent).toBe("");

    let resolveGrouped!: (value: api.GroupedLogResponse) => void;
    mockGetGroupedHistory.mockImplementationOnce(() => new Promise(resolve => { resolveGrouped = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "All actions" }));
    fireEvent.click(screen.getByRole("option", { name: "Downgraded" }));
    expect(status.textContent).toBe("");
    await act(async () => resolveGrouped(emptyGrouped));
    expect(status).toHaveTextContent("No history entries match");

    let resolveFlat!: (value: api.LogResponse) => void;
    mockGetHistory.mockImplementationOnce(() => new Promise(resolve => { resolveFlat = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Flat" }));
    expect(status).toHaveTextContent("No history entries match");
    await act(async () => resolveFlat(mockLogResponse));
    expect(status).toHaveTextContent(`${mockLogResponse.total} entries`);
  });

  it("refetches with the downgraded filter from the action select", async () => {
    render(<HistoryView />);
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "All actions" }));
    fireEvent.click(await screen.findByRole("option", { name: "Downgraded" }));

    await waitFor(() => expect(lastParams()).toMatchObject({ filter: "downgraded", offset: 0 }));
    expect(screen.getByRole("button", { name: "Downgraded" })).toBeInTheDocument();
  });

  it("picking a date refetches from page 1 with until and offers Back to latest", async () => {
    mockGetGroupedHistory.mockResolvedValue({ ...mockGroupedLogResponse, total_groups: 100 });
    render(<HistoryView />);
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: /next page/i })[0]);
    await waitFor(() => expect(lastParams()).toMatchObject({ offset: 20 }));

    const dateInput = screen.getByRole("textbox", { name: "Show history up to date" });
    fireEvent.change(dateInput, { target: { value: "2026-01-3" } });
    expect(lastParams()?.until).toBeUndefined();

    fireEvent.change(dateInput, { target: { value: "2026-01-31" } });
    await waitFor(() => expect(lastParams()).toMatchObject({ until: "2026-01-31", offset: 0 }));

    fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
    await waitFor(() => expect(lastParams()?.until).toBeUndefined());
    expect(screen.queryByRole("button", { name: "Back to latest" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter by package name…")).toHaveFocus();
  });

  it("names the action filter by its label in the no-match body", async () => {
    mockGetGroupedHistory.mockImplementation(async (params) =>
      params?.filter && params.filter !== "all" ? emptyGrouped : mockGroupedLogResponse
    );
    render(<HistoryView />);
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "All actions" }));
    fireEvent.click(await screen.findByRole("option", { name: "Downgraded" }));

    expect(await screen.findByText(/with action "Downgraded"/)).toBeInTheDocument();
  });

  it("Clear filters resets action, search and date in one step", async () => {
    mockGetGroupedHistory.mockImplementation(async (params) =>
      params?.filter && params.filter !== "all" ? emptyGrouped : mockGroupedLogResponse
    );
    render(<HistoryView />);
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());

    fireEvent.change(screen.getByRole("textbox", { name: "Show history up to date" }), {
      target: { value: "2026-01-31" },
    });
    fireEvent.change(screen.getByPlaceholderText("Filter by package name…"), { target: { value: "linux" } });
    await waitFor(() => expect(lastParams()).toMatchObject({ search: "linux", until: "2026-01-31" }));

    fireEvent.click(screen.getByRole("button", { name: "All actions" }));
    fireEvent.click(await screen.findByRole("option", { name: "Reinstalled" }));

    const clear = await screen.findByRole("button", { name: "Clear filters" });
    fireEvent.click(clear);

    await waitFor(() => {
      const params = lastParams();
      expect(params).toMatchObject({ filter: "all", search: "", offset: 0 });
      expect(params?.until).toBeUndefined();
    });
    expect(screen.getByPlaceholderText("Filter by package name…")).toHaveValue("");
    expect(screen.getByPlaceholderText("Filter by package name…")).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Show history up to date" })).toHaveValue("");
  });

  it("puts view mode, action and date, not the search field, in a named toggle group", async () => {
    render(<HistoryView />);
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());

    const group = screen.getByRole("button", { name: "Show filters" }).closest(".pf-m-toggle-group") as HTMLElement;
    expect(within(group).getByRole("group", { name: "History view mode" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "All actions" })).toBeInTheDocument();
    expect(within(group).getByRole("textbox", { name: "Show history up to date" })).toBeInTheDocument();
    expect(within(group).queryByRole("textbox", { name: "Filter history by package name" })).not.toBeInTheDocument();
  });

  it("shows the action and date as chips; removing one refetches without it and focuses the search field", async () => {
    render(<HistoryView />);
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());
    expect(screen.queryByRole("list", { name: "Action" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All actions" }));
    fireEvent.click(await screen.findByRole("option", { name: "Upgraded" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Show history up to date" }), {
      target: { value: "2026-01-31" },
    });
    await waitFor(() => expect(lastParams()).toMatchObject({ filter: "upgraded", until: "2026-01-31" }));

    const action = await screen.findByRole("list", { name: "Action" });
    expect(within(action).getByText("Upgraded")).toBeInTheDocument();
    const until = screen.getByRole("list", { name: "Up to" });
    expect(within(until).getByText("2026-01-31")).toBeInTheDocument();

    fireEvent.click(within(action).getByRole("button", { name: "Close Upgraded" }));
    await waitFor(() => expect(lastParams()).toMatchObject({ filter: "all", until: "2026-01-31" }));
    expect(screen.getByPlaceholderText("Filter by package name…")).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("list", { name: "Action" })).not.toBeInTheDocument());

    fireEvent.click(within(screen.getByRole("list", { name: "Up to" })).getByRole("button", { name: "Close 2026-01-31" }));
    await waitFor(() => expect(lastParams()?.until).toBeUndefined());
    await waitFor(() => expect(screen.queryByRole("list", { name: "Up to" })).not.toBeInTheDocument());
  });

  it("re-fetches with the same filter and date after a system change, keeping the page on screen", async () => {
    render(<HistoryView />);
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "All actions" }));
    fireEvent.click(await screen.findByRole("option", { name: "Downgraded" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Show history up to date" }), {
      target: { value: "2026-01-31" },
    });
    await waitFor(() => expect(lastParams()).toMatchObject({ filter: "downgraded", until: "2026-01-31" }));
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());

    mockGetGroupedHistory.mockClear();
    mockGetGroupedHistory.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      completeUpgrade();
    });

    expect(mockGetGroupedHistory).toHaveBeenCalledTimes(1);
    expect(lastParams()).toMatchObject({ filter: "downgraded", until: "2026-01-31", offset: 0 });
    expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    expect(screen.queryByText(/Loading history/i)).not.toBeInTheDocument();
  });

  it("moves to the last page when a refresh finds the current page empty", async () => {
    mockGetGroupedHistory.mockResolvedValue({ ...mockGroupedLogResponse, total_groups: 100 });
    render(<HistoryView />);
    await waitFor(() => expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /next page/i })[0]);
    await waitFor(() => expect(lastParams()).toMatchObject({ offset: 20 }));

    mockGetGroupedHistory.mockImplementation(async (params) =>
      params?.offset === 20 ? { ...emptyGrouped, total_groups: 1 } : { ...mockGroupedLogResponse, total_groups: 1 }
    );
    await act(async () => {
      completeUpgrade();
    });

    await waitFor(() => expect(lastParams()).toMatchObject({ offset: 0 }));
  });

  it.each([
    ["initial load", "succeeds"],
    ["initial load", "fails"],
    ["retry", "succeeds"],
    ["retry", "fails"],
  ])("keeps a newer refresh when an older %s %s", async (request, outcome) => {
    let resolvePending!: (response: api.GroupedLogResponse) => void;
    let rejectPending!: (error: Error) => void;
    const pending = new Promise<api.GroupedLogResponse>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    if (request === "retry") mockGetGroupedHistory.mockRejectedValueOnce(new Error("Initial failure"));
    mockGetGroupedHistory.mockReturnValueOnce(pending).mockResolvedValueOnce(mockGroupedLogResponse);

    render(<HistoryView />);
    if (request === "retry") {
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    }
    await waitFor(() => expect(mockGetGroupedHistory).toHaveBeenCalledTimes(request === "retry" ? 2 : 1));

    await act(async () => { completeUpgrade(); });
    expect(await screen.findByLabelText("Filter history by package name")).toBeInTheDocument();

    await act(async () => {
      if (outcome === "succeeds") resolvePending(emptyGrouped);
      else rejectPending(new Error("Stale failure"));
    });

    expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load history/i)).not.toBeInTheDocument();
  });

  describe("transaction context", () => {
    beforeEach(() => {
      const groups = mockGroupedLogResponse.groups.map(group => ({
        ...group, origin: null, entries: group.entries.map(entry => ({ ...entry, origin: null })),
      }));
      mockGetGroupedHistory.mockResolvedValue({ ...mockGroupedLogResponse, groups });
      mockGetHistory.mockResolvedValue({ ...mockLogResponse, entries: groups.flatMap(group => group.entries) });
    });
    it("shows the command that ran each transaction", async () => {
      render(<HistoryView />);
      expect(await screen.findByText("pacman -Syu")).toBeInTheDocument();
      expect(screen.getByText("pacman -S firefox")).toBeInTheDocument();
    });

    const scheduleRuns = () => {
      vi.mocked(api.getScheduleConfig).mockResolvedValue({
        enabled: true, mode: "upgrade", schedule: "daily", max_packages: 0,
      } as unknown as api.ScheduleConfig);
      mockGetScheduledRuns.mockResolvedValue({
        runs: [
          scheduledRun("2026-01-22T10:29:50+0000", 120),
          scheduledRun("2026-01-21T14:05:00+0000", 60),
          { ...scheduledRun("2026-01-21T14:14:00+0000", 600), mode: "check" },
        ],
        total: 3,
      });
    };

    it("labels a transaction inside a scheduled run with a control beside its toggle", async () => {
      scheduleRuns();
      render(<HistoryView />);
      const toggle = (await screen.findByText("pacman -Syu")).closest("button")!;
      const label = await screen.findByRole("button", { name: "Scheduled upgrade" });
      expect(toggle).not.toContainElement(label);
      expect(toggle.closest(".pf-v6-c-accordion__item")).toContainElement(label);
      expect(screen.getAllByRole("button", { name: "Scheduled upgrade" })).toHaveLength(1);
      expect(screen.getByText("pacman -S firefox").closest(".pf-v6-c-accordion__item")).not.toHaveTextContent(/scheduled/i);
      expect(screen.queryByRole("button", { name: "View scheduled run history" })).not.toBeInTheDocument();
    });

    it("opens a read-only view of the run from the label without expanding the group", async () => {
      scheduleRuns();
      render(<HistoryView />);
      const toggle = (await screen.findByText("pacman -Syu")).closest("button")!;
      fireEvent.click(await screen.findByRole("button", { name: "Scheduled upgrade" }));

      const popover = await screen.findByRole("dialog", { name: "Scheduled upgrade" });
      expect(popover).toHaveTextContent("Success");
      expect(popover).toHaveTextContent("3 upgraded");
      expect(popover).toHaveTextContent("2m 0s");
      expect(popover.querySelector("input, select, textarea")).toBeNull();
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    it("shows the run in the run history with that run focused", async () => {
      scheduleRuns();
      render(<HistoryView />);
      fireEvent.click(await screen.findByRole("button", { name: "Scheduled upgrade" }));
      const popover = await screen.findByRole("dialog", { name: "Scheduled upgrade" });
      mockGetScheduledRuns.mockClear();
      fireEvent.click(within(popover).getByRole("button", { name: "Show in run history" }));

      await waitFor(() => expect(mockGetScheduledRuns).toHaveBeenCalled());
      const modal = await screen.findByRole("dialog", { name: "Scheduled upgrades" });
      await waitFor(() => expect(document.activeElement?.id).toBe("simple-node0"));
      expect(modal).toContainElement(document.activeElement as HTMLElement);
      expect(document.activeElement!.closest("tr")).toHaveClass("pf-m-selected");
    });

    it("hedges the label for a run without a recorded duration", async () => {
      mockGetScheduledRuns.mockResolvedValue({ runs: [scheduledRun("2026-01-22T10:25:00+0000", null)], total: 1 });
      render(<HistoryView />);
      fireEvent.click(await screen.findByRole("button", { name: "Probably scheduled" }));
      expect(screen.queryByRole("button", { name: "Scheduled upgrade" })).not.toBeInTheDocument();
      const popover = await screen.findByRole("dialog", { name: "Probably a scheduled upgrade" });
      expect(popover).toHaveTextContent(/matched by start time only/);
    });

    it("marks scheduled entries in flat mode without opening package details", async () => {
      scheduleRuns();
      render(<HistoryView />);
      await screen.findByText("pacman -Syu");
      fireEvent.click(screen.getByRole("button", { name: "Flat" }));

      const labels = await screen.findAllByRole("button", { name: "Scheduled upgrade" });
      expect(labels).toHaveLength(3);
      expect(labels[0].closest("tr")).toHaveTextContent("linux");
      fireEvent.click(labels[0]);
      expect(await screen.findByRole("dialog", { name: "Scheduled upgrade" })).toBeInTheDocument();
      expect(api.getPackageInfo).not.toHaveBeenCalled();
    });
  });

  describe("logged origin", () => {
    const runCommand = (group: api.LogGroup, origin: api.TransactionOrigin | null) =>
      origin === "cockpit" || origin === "scheduled"
        ? `cockpit-pacman ${origin === "scheduled" ? "upgrade" : "install"} ${group.entries.map((e) => e.package).join(" ")}`
        : group.command;
    const withOrigins = (origins: (api.TransactionOrigin | null)[]) => {
      const groups = mockGroupedLogResponse.groups.map((group, i) => {
        const command = runCommand(group, origins[i]);
        return {
          ...group,
          command,
          origin: origins[i],
          entries: group.entries.map((entry) => ({ ...entry, command, origin: origins[i] })),
        };
      });
      mockGetGroupedHistory.mockResolvedValue({ ...mockGroupedLogResponse, groups });
      mockGetHistory.mockResolvedValue({ ...mockLogResponse, entries: groups.flatMap((g) => g.entries) });
    };

    it("labels a scheduled origin without any matching run", async () => {
      withOrigins(["scheduled", null, null]);
      render(<HistoryView />);
      const toggle = (await screen.findByText("Upgraded linux, linux-firmware and systemd")).closest("button")!;
      const item = toggle.closest(".pf-v6-c-accordion__item") as HTMLElement;
      await waitFor(() => expect(within(item).getByText("Scheduled upgrade")).toBeInTheDocument());
      expect(within(item).queryByRole("button", { name: "Scheduled upgrade" })).not.toBeInTheDocument();
      expect(screen.queryByText(/Probably scheduled/)).not.toBeInTheDocument();
    });

    it("drops the hedge when the origin confirms a run matched only by start time", async () => {
      withOrigins(["scheduled", null, null]);
      mockGetScheduledRuns.mockResolvedValue({ runs: [scheduledRun("2026-01-22T10:25:00+0000", null)], total: 1 });
      render(<HistoryView />);
      fireEvent.click(await screen.findByRole("button", { name: "Scheduled upgrade" }));
      expect(screen.queryByRole("button", { name: "Probably scheduled" })).not.toBeInTheDocument();
      const popover = await screen.findByRole("dialog", { name: "Scheduled upgrade" });
      expect(popover).not.toHaveTextContent(/matched by start time only/);
    });

    it("labels a Cockpit origin and never guesses a schedule for a logged pacman run", async () => {
      withOrigins(["pacman", "cockpit", null]);
      mockGetScheduledRuns.mockResolvedValue({ runs: [scheduledRun("2026-01-22T10:25:00+0000", null)], total: 1 });
      render(<HistoryView />);
      const neovim = (await screen.findByText("Installed neovim and tree-sitter")).closest(".pf-v6-c-accordion__item") as HTMLElement;
      expect(within(neovim).getByText("From Cockpit")).toBeInTheDocument();
      expect(screen.queryByText(/cockpit-pacman/)).not.toBeInTheDocument();
      expect(screen.getByText("pacman -Syu").tagName).toBe("CODE");
      await waitFor(() => expect(mockGetScheduledRuns).toHaveBeenCalled());
      expect(screen.queryByText(/scheduled/i)).not.toBeInTheDocument();
    });

    it("keeps the time-window guess for records without an origin", async () => {
      withOrigins([null, null, null]);
      mockGetScheduledRuns.mockResolvedValue({ runs: [scheduledRun("2026-01-22T10:25:00+0000", null)], total: 1 });
      render(<HistoryView />);
      expect(await screen.findByRole("button", { name: "Probably scheduled" })).toBeInTheDocument();
    });

    it("shows the origin label on flat entries", async () => {
      withOrigins(["scheduled", "cockpit", null]);
      render(<HistoryView />);
      await screen.findByText("Upgraded linux, linux-firmware and systemd");
      fireEvent.click(screen.getByRole("button", { name: "Flat" }));

      await waitFor(() => expect(screen.getAllByText("Scheduled upgrade")).toHaveLength(3));
      expect(screen.getAllByText("Scheduled upgrade")[0].closest("tr")).toHaveTextContent("linux");
      const cockpit = screen.getAllByText("From Cockpit");
      expect(cockpit).toHaveLength(2);
      expect(cockpit[0].closest("tr")).toHaveTextContent("neovim");
      expect(screen.getByText("deprecated-package").closest("tr")).not.toHaveTextContent(/Cockpit|scheduled/i);
    });
  });

  describe("background refresh", () => {
    const newGroup: api.LogGroup = {
      ...mockGroupedLogResponse.groups[0],
      id: "group-0",
      command: "pacman -S htop",
      start_time: "2026-01-23T09:00:00+0000",
      end_time: "2026-01-23T09:00:05+0000",
    };

    it("marks the history busy while a refresh is pending and keeps the rows", async () => {
      const { container } = render(<HistoryView />);
      await screen.findByText("pacman -Syu");
      const region = container.querySelector(".pf-v6-c-accordion")!;
      expect(region).not.toHaveAttribute("aria-busy", "true");

      let resolve!: (r: api.GroupedLogResponse) => void;
      mockGetGroupedHistory.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
      await act(async () => { completeUpgrade(); });

      expect(region).toHaveAttribute("aria-busy", "true");
      expect(screen.getByText("pacman -Syu")).toBeInTheDocument();
      await act(async () => { resolve(mockGroupedLogResponse); });
      expect(region).not.toHaveAttribute("aria-busy", "true");
    });

    it("keeps the rows and offers Try again when a refresh fails", async () => {
      render(<HistoryView />);
      await screen.findByText("pacman -Syu");

      mockGetGroupedHistory.mockRejectedValueOnce(new Error("log unreadable"));
      await act(async () => { completeUpgrade(); });

      expect(await screen.findByText("Could not refresh history")).toBeInTheDocument();
      expect(screen.getByText("pacman -Syu")).toBeInTheDocument();
      expect(screen.getByLabelText("Filter history by package name")).toBeInTheDocument();
      expect(screen.queryByText(/Could not load history/i)).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      await waitFor(() => expect(screen.queryByText("Could not refresh history")).not.toBeInTheDocument());
      expect(mockGetGroupedHistory).toHaveBeenCalledTimes(3);
      expect(screen.getByText("pacman -Syu")).toBeInTheDocument();
    });

    it("labels a transaction that arrived at the top and announces it once", async () => {
      render(<AnnouncerProvider><HistoryView /></AnnouncerProvider>);
      await screen.findByText("pacman -Syu");
      const seen: string[] = [];
      const status = screen.getByRole("status");
      new MutationObserver(() => {
        if (status.textContent) seen.push(status.textContent);
      }).observe(status, { childList: true, characterData: true, subtree: true });

      const grown = {
        ...mockGroupedLogResponse,
        groups: [newGroup, ...mockGroupedLogResponse.groups.map((g, i) => ({ ...g, id: `group-${i + 1}` }))],
        total_groups: 4,
      };
      mockGetGroupedHistory.mockResolvedValue(grown);
      await act(async () => { completeUpgrade(); });

      const toggle = (await screen.findByText("pacman -S htop")).closest("button")!;
      expect(toggle).toHaveTextContent("New");
      expect(screen.getByText("pacman -Syu").closest("button")).not.toHaveTextContent("New");
      expect(seen).toEqual(["1 new transaction"]);

      await act(async () => { completeUpgrade(); });
      await waitFor(() => expect(mockGetGroupedHistory).toHaveBeenCalledTimes(3));
      expect(seen).toEqual(["1 new transaction"]);
      expect(screen.getByText("pacman -S htop").closest("button")).toHaveTextContent("New");
    });
  });

  describe("route options", () => {
    it("loads with the routed query and filter", async () => {
      render(<HistoryView routeOptions={{ q: "linux", filter: "downgraded" }} />);
      await waitFor(() =>
        expect(mockGetGroupedHistory).toHaveBeenCalledWith(
          expect.objectContaining({ search: "linux", filter: "downgraded", offset: 0 }),
        ),
      );
      expect(await screen.findByPlaceholderText("Filter by package name…")).toHaveValue("linux");
    });

    it("falls back to all actions on an unknown filter", async () => {
      const onRouteChange = vi.fn();
      render(<HistoryView routeOptions={{ filter: "toString" }} onRouteChange={onRouteChange} />);
      await waitFor(() =>
        expect(mockGetGroupedHistory).toHaveBeenCalledWith(expect.objectContaining({ filter: "all" })),
      );
      expect(onRouteChange).toHaveBeenCalledWith({});
    });

    it("preserves package details while normalizing history filters", async () => {
      const onRouteChange = vi.fn();
      render(
        <HistoryView
          routeOptions={{ q: "linux", filter: "invalid", pkg: "bash", repo: "core" }}
          onRouteChange={onRouteChange}
        />,
      );

      await waitFor(() =>
        expect(onRouteChange).toHaveBeenLastCalledWith({ q: "linux", pkg: "bash", repo: "core" }),
      );
    });

    it("applies a package history opened from elsewhere", async () => {
      const { rerender } = render(<HistoryView routeOptions={{}} />);
      await screen.findByLabelText("Filter history by package name");
      rerender(<HistoryView routeOptions={{ q: "bash" }} />);
      await waitFor(() =>
        expect(mockGetGroupedHistory).toHaveBeenLastCalledWith(expect.objectContaining({ search: "bash" })),
      );
    });

    it("writes the settled search back to the route", async () => {
      const onRouteChange = vi.fn();
      render(<HistoryView routeOptions={{}} onRouteChange={onRouteChange} />);
      await screen.findByLabelText("Filter history by package name");
      fireEvent.change(screen.getByPlaceholderText("Filter by package name…"), { target: { value: "glibc" } });
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ q: "glibc" }));
    });

    describe("targeting a transaction", () => {
      const firefoxRun = "2026-01-21T14:15:00+0000";
      const toggle = (id: string) => document.getElementById(`${id}-toggle`);

      it("expands, scrolls to and focuses the group at the routed start time, then drops the option", async () => {
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        const onRouteChange = vi.fn();
        render(<HistoryView routeOptions={{ at: firefoxRun }} onRouteChange={onRouteChange} />);

        await waitFor(() => expect(toggle("group-1")).toHaveFocus());
        expect(toggle("group-1")).toHaveAttribute("aria-expanded", "true");
        expect(toggle("group-0")).toHaveAttribute("aria-expanded", "false");
        expect(scrollIntoView).toHaveBeenCalled();
        await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({}));
        delete (Element.prototype as Partial<Element>).scrollIntoView;
      });

      it("targets a group routed while the tab is already open", async () => {
        const { rerender } = render(<HistoryView routeOptions={{}} />);
        await screen.findByLabelText("Filter history by package name");
        rerender(<HistoryView routeOptions={{ at: firefoxRun }} />);
        await waitFor(() => expect(toggle("group-1")).toHaveFocus());
        expect(toggle("group-1")).toHaveAttribute("aria-expanded", "true");
      });

      it("offers Show it when a search hides the group, and clearing it reaches the group", async () => {
        mockGetGroupedHistory.mockImplementation(async (params) =>
          params?.search
            ? { ...mockGroupedLogResponse, groups: [mockGroupedLogResponse.groups[0]], total_groups: 1 }
            : mockGroupedLogResponse,
        );
        render(
          <AnnouncerProvider>
            <HistoryView routeOptions={{ q: "linux", at: firefoxRun }} />
          </AnnouncerProvider>,
        );
        const notice = await screen.findByText(/is hidden by the current view/);
        expect(toggle("group-1")).not.toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/is hidden by the current view/));

        fireEvent.click(within(notice.closest(".pf-v6-c-alert") as HTMLElement).getByRole("button", { name: "Show it" }));
        await waitFor(() => expect(toggle("group-1")).toHaveFocus());
        expect(toggle("group-1")).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByPlaceholderText("Filter by package name…")).toHaveValue("");
        expect(screen.queryByText(/is hidden by the current view/)).not.toBeInTheDocument();
      });

      it("offers Show it from the flat view and switches to groups", async () => {
        const { rerender } = render(<HistoryView routeOptions={{}} />);
        await screen.findByLabelText("Filter history by package name");
        fireEvent.click(screen.getByRole("button", { name: "Flat" }));
        await screen.findByRole("grid", { name: "Package history (flat)" });
        rerender(<HistoryView routeOptions={{ at: firefoxRun }} />);

        fireEvent.click(await screen.findByRole("button", { name: "Show it" }));
        await waitFor(() => expect(toggle("group-1")).toHaveFocus());
      });

      it("says when the group is not in the history and has nothing to clear", async () => {
        render(<HistoryView routeOptions={{ at: "2025-01-01T00:00:00+0000" }} />);
        const notice = await screen.findByText(/is not in the history/);
        const alert = notice.closest(".pf-v6-c-alert") as HTMLElement;
        expect(within(alert).queryByRole("button", { name: "Show it" })).not.toBeInTheDocument();
        fireEvent.click(within(alert).getByRole("button", { name: /Close/ }));
        expect(screen.queryByText(/is not in the history/)).not.toBeInTheDocument();
      });

      it("waits for the activation reload before resolving a group newer than the loaded rows", async () => {
        const outsideRun = "2026-01-23T08:00:00+0000";
        const newGroup = { ...mockGroupedLogResponse.groups[0], id: "group-new", start_time: outsideRun, end_time: outsideRun };
        const view = (active: boolean, at?: string) => (
          <AnnouncerProvider>
            <TabActiveContext.Provider value={active}>
              <HistoryView routeOptions={at ? { at } : {}} />
            </TabActiveContext.Provider>
          </AnnouncerProvider>
        );
        const { rerender } = render(view(true));
        await screen.findByLabelText("Filter history by package name");
        rerender(view(false));

        let resolveReload!: (response: api.GroupedLogResponse) => void;
        mockGetGroupedHistory.mockImplementation(
          () => new Promise((resolve) => { resolveReload = resolve; }),
        );
        rerender(view(true, outsideRun));
        expect(screen.queryByText(/is not in the history/)).not.toBeInTheDocument();
        await act(async () => {});
        expect(screen.getByRole("status")).not.toHaveTextContent(/is not in the history/);

        await act(async () => {
          resolveReload({
            ...mockGroupedLogResponse,
            groups: [newGroup, ...mockGroupedLogResponse.groups],
            total_groups: mockGroupedLogResponse.total_groups + 1,
          });
        });
        await waitFor(() => expect(toggle("group-new")).toHaveFocus());
        expect(toggle("group-new")).toHaveAttribute("aria-expanded", "true");
        expect(screen.queryByText(/is not in the history/)).not.toBeInTheDocument();
        expect(screen.getByRole("status")).not.toHaveTextContent(/is not in the history/);
      });

      it("still reports a missing group once the reload has finished", async () => {
        const view = (active: boolean, at?: string) => (
          <TabActiveContext.Provider value={active}>
            <HistoryView routeOptions={at ? { at } : {}} />
          </TabActiveContext.Provider>
        );
        const { rerender } = render(view(true));
        await screen.findByLabelText("Filter history by package name");
        rerender(view(false));
        const calls = mockGetGroupedHistory.mock.calls.length;
        rerender(view(true, "2025-01-01T00:00:00+0000"));
        expect(await screen.findByText(/is not in the history/)).toBeInTheDocument();
        expect(mockGetGroupedHistory.mock.calls.length).toBe(calls + 1);
      });
    });

    it("opens a routed pkg in the drawer, writes a row open and closes when pkg is cleared", async () => {
      vi.mocked(api.getPackageInfo).mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
      const onRouteChange = vi.fn();
      const { rerender } = render(<HistoryView routeOptions={{ pkg: "linux" }} onRouteChange={onRouteChange} />);
      await screen.findByLabelText("Filter history by package name");
      expect(await screen.findByRole("region", { name: /^linux/ })).toBeInTheDocument();
      expect(screen.queryAllByRole("dialog")).toHaveLength(0);
      expect(api.getPackageInfo).toHaveBeenCalledWith("linux");

      fireEvent.click(document.getElementById("group-0-toggle")!);
      const nameButton = (name: string) => screen.getByRole("button", { name });
      expect(nameButton("linux").closest("tr")).toHaveAttribute("aria-current", "true");

      nameButton("systemd").focus();
      fireEvent.click(nameButton("systemd"));
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ pkg: "systemd" }));
      rerender(<HistoryView routeOptions={{ pkg: "systemd" }} onRouteChange={onRouteChange} />);
      const panel = await screen.findByRole("region", { name: /^systemd/ });
      expect(nameButton("systemd").closest("tr")).toHaveAttribute("aria-current", "true");

      within(panel).getByRole("button", { name: "Close package details" }).focus();
      rerender(<HistoryView routeOptions={{}} onRouteChange={onRouteChange} />);
      await waitFor(() => expect(screen.queryByRole("region", { name: /^systemd/ })).not.toBeInTheDocument());
      expect(nameButton("systemd")).toHaveFocus();
      expect(nameButton("systemd").closest("tr")).not.toHaveAttribute("aria-current");
    });

    it("drops pkg from the route when the drawer is closed", async () => {
      vi.mocked(api.getPackageInfo).mockImplementation(async (name: string) => ({ ...mockPackageDetails, name }));
      const onRouteChange = vi.fn();
      render(<HistoryView routeOptions={{ pkg: "linux" }} onRouteChange={onRouteChange} />);
      const panel = await screen.findByRole("region", { name: /^linux/ });
      fireEvent.click(within(panel).getByRole("button", { name: "Close package details" }));
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({}));
    });

    it("preserves package details when writing the settled search", async () => {
      const onRouteChange = vi.fn();
      render(<HistoryView routeOptions={{ pkg: "bash", repo: "core" }} onRouteChange={onRouteChange} />);
      await screen.findByLabelText("Filter history by package name");

      fireEvent.change(screen.getByPlaceholderText("Filter by package name…"), { target: { value: "glibc" } });
      await waitFor(() =>
        expect(onRouteChange).toHaveBeenLastCalledWith({ q: "glibc", pkg: "bash", repo: "core" }),
      );
    });
  });

  describe("row actions", () => {
    const cachedLinux: api.CachedVersion = {
      name: "linux",
      version: "6.18.4-arch1-1",
      filename: "linux-6.18.4-arch1-1-x86_64.pkg.tar.zst",
      size: 1024,
      installed_version: "6.18.5-arch1-1",
      is_older: true,
    };

    beforeEach(() => {
      vi.mocked(api.getPackageInfo).mockImplementation(async (name: string) => ({
        ...mockPackageDetails, name, version: "6.18.5-arch1-1", repository: "core",
      }));
      vi.mocked(api.listDowngrades).mockResolvedValue({ packages: [cachedLinux], total: 1 });
      vi.mocked(api.listArchiveVersions).mockResolvedValue({ packages: [], total: 0 });
      vi.mocked(api.previewDowngrade).mockImplementation(async (name, version) => ({
        success: true,
        add: [{ name, version, repo: null, download_size: 0, installed_size: 1, old_version: "6.18.5-arch1-1", reason: "target" }],
        remove: [],
        conflicts: [],
        replacements: [],
        providers: [],
        import_keys: [],
        warnings: [],
        blocked_by: [],
        total_download_size: 0,
        net_installed_size: 0,
      }));
    });

    const openLinuxMenu = async () => {
      render(<DowngradeProvider><HistoryView /></DowngradeProvider>);
      await screen.findByLabelText("Filter history by package name");
      fireEvent.click(document.getElementById("group-0-toggle")!);
      for (const name of ["linux", "linux-firmware", "systemd"]) {
        expect(screen.getByRole("button", { name: `Actions for ${name}` })).toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole("button", { name: "Actions for linux" }));
      return screen.findByRole("menu");
    };

    it("opens a named kebab on each entry row without opening details", async () => {
      const menu = await openLinuxMenu();
      expect(await within(menu).findByRole("menuitem", { name: "Remove linux" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: /^linux/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Close package details" })).not.toBeInTheDocument();
    });

    it("downgrades an upgraded entry to its previous version straight into the preview", async () => {
      const menu = await openLinuxMenu();
      fireEvent.click(await within(menu).findByRole("menuitem", { name: "Downgrade linux to 6.18.4-arch1-1" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByRole("button", { name: "Downgrade linux to 6.18.4-arch1-1" })).toBeInTheDocument();
      expect(api.previewDowngrade).toHaveBeenCalledWith("linux", "6.18.4-arch1-1");
      expect(within(dialog).queryByRole("grid", { name: "Available versions" })).not.toBeInTheDocument();
    });

    it("shows the version list with a note when the previous version is nowhere to be found", async () => {
      vi.mocked(api.listDowngrades).mockResolvedValue({ packages: [], total: 0 });
      const menu = await openLinuxMenu();
      fireEvent.click(await within(menu).findByRole("menuitem", { name: "Downgrade linux to 6.18.4-arch1-1" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByText("6.18.4-arch1-1 is not in the cache or the archive")).toBeInTheDocument();
      expect(api.previewDowngrade).not.toHaveBeenCalled();
    });
  });
});

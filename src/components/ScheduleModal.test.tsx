import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { ScheduleModal } from "./ScheduleModal";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getScheduleConfig: vi.fn(),
    setScheduleConfig: vi.fn(),
    getScheduledRuns: vi.fn(),
  };
});

const mockGetScheduleConfig = vi.mocked(api.getScheduleConfig);
const mockGetScheduledRuns = vi.mocked(api.getScheduledRuns);

const config: api.ScheduleConfig = {
  enabled: true,
  mode: "upgrade",
  schedule: "daily",
  max_packages: 1,
  timer_active: true,
  timer_next_run: null,
  timer_calendar: null,
};

function run(overrides: Partial<api.ScheduledRunEntry>): api.ScheduledRunEntry {
  return {
    timestamp: "2026-08-21T10:35:21+0000",
    mode: "upgrade",
    success: true,
    status: "ok",
    packages_checked: 9,
    packages_upgraded: 0,
    error: null,
    details: [],
    duration_secs: null,
    removed_stale_lock: false,
    ...overrides,
  };
}

async function renderWithRuns(runs: api.ScheduledRunEntry[]) {
  mockGetScheduleConfig.mockResolvedValue(config);
  mockGetScheduledRuns.mockResolvedValue({ runs, total: runs.length });
  render(<ScheduleModal isOpen onClose={() => {}} />);
  await waitFor(() => expect(mockGetScheduledRuns).toHaveBeenCalled());
}

describe("ScheduleModal run history", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("cannot save defaults when the schedule could not be read", async () => {
    mockGetScheduleConfig.mockRejectedValue(new Error("Permission denied"));
    mockGetScheduledRuns.mockResolvedValue({ runs: [], total: 0 });
    render(<ScheduleModal isOpen onClose={() => {}} />);

    await screen.findByText("Permission denied");
    fireEvent.click(screen.getByRole("switch"));
    const save = screen.getByRole("button", { name: "Save" });

    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(api.setScheduleConfig).not.toHaveBeenCalled();
  });

  it("labels a skipped run as skipped, not success", async () => {
    await renderWithRuns([
      run({
        status: "skipped",
        success: true,
        details: ["Skipped: 9 updates exceed safety limit of 1"],
      }),
    ]);

    expect(await screen.findByText("Skipped")).toBeInTheDocument();
    expect(screen.queryByText("Success")).not.toBeInTheDocument();
  });

  it("labels an ok run as success", async () => {
    await renderWithRuns([run({ status: "ok", success: true, packages_upgraded: 9 })]);

    expect(await screen.findByText("Success")).toBeInTheDocument();
    expect(screen.queryByText("Skipped")).not.toBeInTheDocument();
  });

  it("labels a failed run as failed", async () => {
    await renderWithRuns([
      run({ status: "failed", success: false, error: "Failed to commit upgrade: disk full" }),
    ]);

    expect(await screen.findByText("Failed")).toBeInTheDocument();
  });

  // derive_status backfills status from success for pre-status records, but a
  // record that reaches the UI without one must still not read as a success.
  it("falls back to success only when status is absent", async () => {
    await renderWithRuns([run({ status: "", success: false, error: "boom" })]);

    expect(await screen.findByText("Failed")).toBeInTheDocument();
  });

  it("does not claim there are no runs when the history cannot be read", async () => {
    mockGetScheduleConfig.mockResolvedValue(config);
    mockGetScheduledRuns.mockRejectedValue(new Error("Permission denied"));
    render(<ScheduleModal isOpen onClose={() => {}} />);

    expect(await screen.findByText("Could not read the run history")).toBeInTheDocument();
    expect(screen.queryByText("No scheduled runs yet")).not.toBeInTheDocument();
  });

  it("marks a run that had to clear a leftover lock", async () => {
    await renderWithRuns([run({ status: "ok", removed_stale_lock: true })]);

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
    expect(screen.getByText("Success")).toBeInTheDocument();
  });

  it("does not mark an ordinary run", async () => {
    await renderWithRuns([run({ status: "ok", removed_stale_lock: false })]);

    expect(await screen.findByText("Success")).toBeInTheDocument();
    expect(screen.queryByText("Recovered")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are genuinely no runs", async () => {
    await renderWithRuns([]);

    expect(await screen.findByText("No scheduled runs yet")).toBeInTheDocument();
    expect(screen.queryByText("Could not read the run history")).not.toBeInTheDocument();
  });
  it("shows a completed service with missing results separately from a failed upgrade", async () => {
    await renderWithRuns([run({ status: "unrecorded", mode: "unknown", packages_checked: null, packages_upgraded: null })]);
    expect(await screen.findByText("Record unavailable")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.queryByText("0 checked")).not.toBeInTheDocument();
  });

  it("keeps independent service evidence visible when the history file is unreadable", async () => {
    mockGetScheduleConfig.mockResolvedValue(config);
    mockGetScheduledRuns.mockResolvedValue({
      runs: [run({ status: "failed", mode: "unknown", packages_checked: null, packages_upgraded: null })],
      total: 1, warning: "Permission denied reading scheduled.jsonl",
    });
    render(<ScheduleModal isOpen onClose={() => {}} />);
    expect(await screen.findByText("Could not read the run history")).toBeInTheDocument();
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

});

describe("ScheduleModal timer and running service state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetScheduleConfig.mockResolvedValue(config);
    mockGetScheduledRuns.mockResolvedValue({ runs: [], total: 0 });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("distinguishes an unavailable timer from an inactive timer", async () => {
    mockGetScheduleConfig.mockResolvedValue({
      ...config, timer_active: null, timer_error: "Could not query systemd",
    });
    render(<ScheduleModal isOpen onClose={() => {}} />);
    expect(await screen.findByText("Timer status unavailable")).toBeInTheDocument();
    expect(screen.getByText("Could not query systemd")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Inactive")).not.toBeInTheDocument();
    expect(screen.queryByText("Timer and saved settings differ")).not.toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it.each([true, false])("can repair timer drift when enabled is %s without changing settings", async enabled => {
    const mismatched = { ...config, enabled, timer_active: !enabled };
    mockGetScheduleConfig.mockResolvedValueOnce(mismatched).mockResolvedValue({ ...mismatched, timer_active: enabled });
    vi.mocked(api.setScheduleConfig).mockResolvedValue({ success: true, message: "Schedule saved" });
    render(<ScheduleModal isOpen onClose={() => {}} />);
    expect(await screen.findByText("Timer and saved settings differ")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.setScheduleConfig).toHaveBeenCalledWith({
      enabled, mode: config.mode, schedule: config.schedule, max_packages: config.max_packages,
    }));
    await waitFor(() => expect(screen.queryByText("Timer and saved settings differ")).not.toBeInTheDocument());
    expect(save).toBeDisabled();
  });

  it("keeps the running service separate from the last completed run", async () => {
    mockGetScheduledRuns.mockResolvedValue({
      runs: [run({ packages_upgraded: 9 })], total: 1,
      current_run: { state: "activating", started_at: "2026-10-11T10:00:00Z", invocation_id: "running" },
    });
    render(<ScheduleModal isOpen onClose={() => {}} />);
    expect(await screen.findByText("Scheduled upgrade is running")).toBeInTheDocument();
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("9 upgraded")).toBeInTheDocument();
  });

  it("polls the service through stopping and completion, then stops polling when closed", async () => {
    vi.useFakeTimers();
    mockGetScheduledRuns
      .mockResolvedValueOnce({ runs: [], total: 0, current_run: { state: "active", started_at: null, invocation_id: "running" } })
      .mockResolvedValueOnce({ runs: [], total: 0, current_run: { state: "deactivating", started_at: null, invocation_id: "running" } })
      .mockResolvedValue({ runs: [run({ packages_upgraded: 2 })], total: 1 });
    let view: ReturnType<typeof render>;
    await act(async () => { view = render(<ScheduleModal isOpen onClose={() => {}} />); });
    expect(screen.getByText("Scheduled upgrade is running")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("Scheduled upgrade is stopping")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByText("Scheduled upgrade is stopping")).not.toBeInTheDocument();
    expect(screen.getByText("2 upgraded")).toBeInTheDocument();
    expect(mockGetScheduledRuns).toHaveBeenCalledTimes(3);
    expect(mockGetScheduleConfig).toHaveBeenCalledTimes(1);
    view!.rerender(<ScheduleModal isOpen={false} onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(mockGetScheduledRuns).toHaveBeenCalledTimes(3);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { ScheduleModal } from "./ScheduleModal";
import * as api from "../api";
import { sweepA11y } from "../test/a11ySweep";

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
const mockSetScheduleConfig = vi.mocked(api.setScheduleConfig);

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
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Scheduled upgrades");
  });

  it("shows an unrecorded run with unknown counts alongside a history warning", async () => {
    mockGetScheduleConfig.mockResolvedValue(config);
    mockGetScheduledRuns.mockResolvedValue({
      runs: [run({ status: "unrecorded", packages_checked: null, packages_upgraded: null })],
      total: 1, warning: "Some run records could not be read",
    });
    render(<ScheduleModal isOpen onClose={() => {}} />);
    expect(await screen.findByText("Record unavailable")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("Could not read the run history")).toBeInTheDocument();
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
});

describe("ScheduleModal package limit", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("counts the limit in singular and plural", async () => {
    await renderWithRuns([]);

    expect(
      await screen.findByText("Upgrades with more than 1 package will be skipped as a safety measure."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Plus" }));
    expect(
      screen.getByText("Upgrades with more than 2 packages will be skipped as a safety measure."),
    ).toBeInTheDocument();
  });
});

describe("ScheduleModal run details", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("shows a skipped run's reason as text after expanding the row", async () => {
    await renderWithRuns([
      run({ status: "skipped", details: ["Skipped: 9 updates exceed safety limit of 1"] }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: /Show run history/ }));
    expect(screen.queryByText(/exceed safety limit/)).not.toBeVisible();

    const toggle = screen.getByRole("button", { name: /Details/ });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/exceed safety limit/)).toBeVisible();
  });

  it("explains a recovered run in its expanded row", async () => {
    await renderWithRuns([run({ status: "ok", removed_stale_lock: true })]);
    fireEvent.click(await screen.findByRole("button", { name: /Show run history/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    });

    expect(screen.getByText(/Cleared a leftover pacman lock/)).toBeVisible();
  });

  it("offers no expansion for a run with nothing more to say", async () => {
    await renderWithRuns([run({ status: "ok" })]);
    fireEvent.click(await screen.findByRole("button", { name: /Show run history/ }));
    await screen.findByText("Success");

    expect(screen.queryByRole("button", { name: /Details/ })).not.toBeInTheDocument();
  });

  it("opens with the history expanded and focused when asked", async () => {
    mockGetScheduleConfig.mockResolvedValue(config);
    mockGetScheduledRuns.mockResolvedValue({ runs: [run({ status: "ok" })], total: 1 });
    render(<ScheduleModal isOpen onClose={() => {}} initialHistoryExpanded />);

    const caption = await screen.findByText("Last 1 scheduled run");
    await waitFor(() => expect(caption).toHaveFocus());
    expect(screen.getByRole("grid", { name: "Scheduled run history" })).toBeVisible();
  });
});

describe("ScheduleModal unsaved edits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetScheduleConfig.mockResolvedValue(config);
    mockGetScheduledRuns.mockResolvedValue({ runs: [], total: 0 });
    mockSetScheduleConfig.mockResolvedValue({ success: true, message: "Schedule updated" } as Awaited<ReturnType<typeof api.setScheduleConfig>>);
  });
  afterEach(() => cleanup());

  const renderAndEdit = async (onClose = vi.fn(), onSaved = vi.fn()) => {
    render(<ScheduleModal isOpen onClose={onClose} onSaved={onSaved} />);
    const preset = await screen.findByLabelText("Schedule");
    fireEvent.change(preset, { target: { value: "weekly" } });
    return { onClose, onSaved };
  };

  it("asks before Escape discards edits, and Discard changes closes without saving", async () => {
    const { onClose } = await renderAndEdit();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(await screen.findByText("Discard changes to the schedule?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    sweepA11y();

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockSetScheduleConfig).not.toHaveBeenCalled();
  });

  it("Keep editing returns to the form with the edit intact", async () => {
    const { onClose } = await renderAndEdit();
    fireEvent.click(screen.getByText("Close").closest("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Schedule")).toHaveValue("weekly");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("asks before a backdrop click discards edits", async () => {
    const { onClose } = await renderAndEdit();
    const backdrop = document.querySelector(".pf-v6-c-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);

    expect(await screen.findByText("Discard changes to the schedule?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes at once when nothing was edited", async () => {
    const onClose = vi.fn();
    render(<ScheduleModal isOpen onClose={onClose} />);
    await screen.findByLabelText("Schedule");
    sweepA11y();
    fireEvent.click(screen.getByText("Close").closest("button")!);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes to the schedule?")).not.toBeInTheDocument();
  });

  it("Save writes the schedule, reports it and closes", async () => {
    const { onClose, onSaved } = await renderAndEdit();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(mockSetScheduleConfig).toHaveBeenCalledWith(expect.objectContaining({ schedule: "weekly" }));
    expect(onSaved).toHaveBeenCalledWith("Schedule updated");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open with the error when Save fails", async () => {
    mockSetScheduleConfig.mockRejectedValue(new Error("Failed to write timer drop-in"));
    const { onClose, onSaved } = await renderAndEdit();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Schedule")).toHaveValue("weekly");
    expect(screen.getByText("Could not save the schedule")).toBeInTheDocument();
    expect(screen.getByText("Failed to write timer drop-in")).toBeInTheDocument();
  });

  it("names a failed configuration read", async () => {
    mockGetScheduleConfig.mockRejectedValue(new Error("timer unit missing"));
    mockGetScheduledRuns.mockResolvedValue({ runs: [], total: 0 });
    render(<ScheduleModal isOpen onClose={() => {}} />);
    expect(await screen.findByText("Could not load the schedule")).toBeInTheDocument();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
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
    const onClose = vi.fn();
    render(<ScheduleModal isOpen onClose={onClose} />);
    expect(await screen.findByText("Timer and saved settings differ")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.setScheduleConfig).toHaveBeenCalledWith({
      enabled, mode: config.mode, schedule: config.schedule, max_packages: config.max_packages,
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
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

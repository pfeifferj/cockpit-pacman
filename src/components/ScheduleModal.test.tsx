import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
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

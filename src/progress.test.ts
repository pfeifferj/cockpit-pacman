import { describe, it, expect } from "vitest";
import type { StreamEvent } from "./bindings";
import { initialProgress, progressPercent, progressValueText, reduceProgress, ProgressPlan, ProgressState } from "./progress";

const plan: ProgressPlan = { downloadBytes: 1000, packages: 2 };

function run(events: StreamEvent[], p: ProgressPlan = plan): ProgressState[] {
  const states: ProgressState[] = [];
  let s = initialProgress;
  for (const e of events) {
    s = reduceProgress(s, e, p);
    states.push(s);
  }
  return states;
}

const dl = (filename: string, event: string, downloaded?: number, total?: number): StreamEvent =>
  ({ type: "download", filename, event, downloaded, total });
const prog = (operation: string, pkg: string, percent: number, current: number, total: number): StreamEvent =>
  ({ type: "progress", operation, package: pkg, percent, current, total });
const ev = (event: string, pkg?: string, current?: number, total?: number): StreamEvent =>
  ({ type: "event", event, package: pkg, current, total });

const upgradeSequence: StreamEvent[] = [
  dl("core.db", "progress", 50, 100),
  dl("a-1-1-x86_64.pkg.tar.zst", "progress", 300, 600),
  dl("a-1-1-x86_64.pkg.tar.zst", "completed", undefined, 600),
  dl("b-1-1-x86_64.pkg.tar.zst", "progress", 200, 400),
  dl("b-1-1-x86_64.pkg.tar.zst", "completed", undefined, 400),
  prog("integrity_start", "", 50, 1, 2),
  prog("conflicts_start", "", 100, 2, 2),
  ev("hook_run_start", "snapshot", 1, 1),
  ev("hook_run_done", "snapshot", 1, 1),
  ev("transaction_start"),
  prog("remove_start", "old", 100, 1, 1),
  prog("upgrade_start", "a", 0, 1, 2),
  prog("upgrade_start", "a", 100, 1, 2),
  prog("upgrade_start", "b", 50, 2, 2),
  prog("upgrade_start", "b", 100, 2, 2),
  ev("transaction_done"),
  ev("hook_run_start", "systemd-daemon-reload", 1, 3),
  ev("hook_run_done", "systemd-daemon-reload", 1, 3),
  ev("hook_run_start", "mkinitcpio", 2, 3),
  ev("hook_run_done", "mkinitcpio", 3, 3),
  { type: "complete", success: true },
];

describe("reduceProgress", () => {
  it("is non-decreasing across a recorded upgrade and reaches 100 only on success", () => {
    const values = run(upgradeSequence).map((s) => s.value);
    let prev = -1;
    for (const v of values) {
      if (v === undefined) continue;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(values.slice(0, -1).every((v) => v === undefined || v < 100)).toBe(true);
    expect(values[values.length - 1]).toBe(100);
  });

  it("stays indeterminate until the first real count", () => {
    const [first] = run([dl("core.db", "progress", 50, 100)]);
    expect(first.value).toBeUndefined();
  });

  it("ignores non-package files in the download band", () => {
    const [s] = run([dl("extra.db", "completed", undefined, 900)]);
    expect(s.value).toBeUndefined();
    expect(s.phase).toBe("downloading");
  });

  it("fills [0,40) by bytes", () => {
    const states = run(upgradeSequence.slice(1, 5));
    expect(states[0].value).toBeCloseTo(12);
    expect(states[3].value).toBeCloseTo(40);
  });

  it("changes only the step label on check operations", () => {
    const before = run(upgradeSequence.slice(0, 5));
    const last = before[before.length - 1];
    const after = reduceProgress(last, prog("integrity_start", "", 50, 3, 12), plan);
    expect(after.value).toBe(last.value);
    expect(after.phase).toBe(last.phase);
    expect(after.phaseLabel).toBe(last.phaseLabel);
    expect(after.stepLabel).toBe("Checking package integrity (3 of 12)");
  });

  it("counts a removal-only transaction against its own total", () => {
    const removeOnly = { downloadBytes: 0, packages: 0 };
    const states = run([prog("remove_start", "a", 100, 1, 2), prog("remove_start", "b", 100, 2, 2)], removeOnly);
    expect(states[0].value).toBeCloseTo(47.5);
    expect(states[1].value).toBeCloseTo(95);
  });

  it("stays indeterminate during downloads when downloadBytes is 0", () => {
    const noBytes = { downloadBytes: 0, packages: 2 };
    const states = run(upgradeSequence.slice(0, 7), noBytes);
    expect(states.every((s) => s.value === undefined)).toBe(true);
    const [s] = run([prog("upgrade_start", "a", 0, 1, 2)], noBytes);
    expect(s.value).toBe(0);
  });

  it("does not move the value for pre-transaction hooks", () => {
    const states = run(upgradeSequence.slice(0, 9));
    expect(states[8].value).toBe(states[6].value);
    expect(states[8].phaseLabel).toBe("Running pre-transaction hooks");
  });

  it("maps transaction counts into [D,95)", () => {
    const states = run(upgradeSequence);
    expect(states[10].value).toBeCloseTo(40 + 55 / 3);
    expect(states[12].value).toBeCloseTo(40 + (55 * 2) / 3);
    expect(states[14].value).toBeCloseTo(95);
    expect(states[14].stepLabel).toBe("2 of 2");
    expect(states[14].phaseLabel).toBe("Upgrading packages");
  });

  it("places post-transaction hooks in [95,100) with position", () => {
    const states = run(upgradeSequence);
    expect(states[16].value).toBeCloseTo(95);
    expect(states[16].stepLabel).toBe("Running hook 1 of 3");
    expect(states[16].item).toBe("systemd-daemon-reload");
    expect(states[19].value).toBe(99);
  });

  it("holds hooks without totals at 95", () => {
    const prefix = run(upgradeSequence.slice(0, 16));
    let s = prefix[prefix.length - 1];
    s = reduceProgress(s, ev("hook_run_start", "x"), plan);
    expect(s.value).toBe(95);
    s = reduceProgress(s, ev("hook_run_done", "x"), plan);
    expect(s.value).toBe(95);
    expect(s.phase).toBe("hooks");
  });

  it("does not reach 100 on failure", () => {
    const prefix = run(upgradeSequence.slice(0, 14));
    const s = reduceProgress(prefix[prefix.length - 1], { type: "complete", success: false }, plan);
    expect(s.value).toBe(prefix[prefix.length - 1].value);
  });

  it("formats aria-valuetext", () => {
    const states = run(upgradeSequence);
    expect(progressPercent(states[12])).toBe(76);
    expect(progressValueText(states[12])).toBe("76 percent, Upgrading packages, 1 of 2");
    expect(progressValueText(initialProgress)).toBe("Preparing");
  });
});

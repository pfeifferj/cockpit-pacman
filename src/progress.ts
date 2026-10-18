import type { StreamEvent } from "./bindings";

export interface ProgressPlan {
  /** Bytes the transaction will download; 0 leaves the download band indeterminate. */
  downloadBytes: number;
  /** Packages the transaction installs or upgrades (removals excluded). */
  packages: number;
}

export type ProgressPhase = "preparing" | "downloading" | "transaction" | "hooks";

export interface ProgressState {
  /** 0-100, non-decreasing; undefined until the first real count. */
  value: number | undefined;
  phase: ProgressPhase;
  phaseLabel: string;
  stepLabel: string | undefined;
  /** Package, file or hook currently being processed. */
  item: string;
  /** Pre-transaction hooks must not move the value, so hooks are placed by stage. */
  stage: "pre" | "transaction" | "post";
  fileBytes: Record<string, number>;
  /** libalpm counts removals and installs separately and runs removals first. */
  removeTotal: number;
}

// Band edges only redistribute real work units; they are design choices, not measured weights.
const DOWNLOAD_END = 40;
const TRANSACTION_END = 95;
const HOOKS_CAP = 99;

const TRANSACTION_LABELS: Record<string, string> = {
  add_start: "Installing packages",
  upgrade_start: "Upgrading packages",
  reinstall_start: "Reinstalling packages",
  downgrade_start: "Downgrading packages",
  remove_start: "Removing packages",
};

const CHECK_LABELS: Record<string, string> = {
  conflicts_start: "Checking for file conflicts",
  diskspace_start: "Checking available disk space",
  integrity_start: "Checking package integrity",
  load_start: "Loading package files",
  keyring_start: "Checking keys in keyring",
};

export const initialProgress: ProgressState = {
  value: undefined,
  phase: "preparing",
  phaseLabel: "Preparing",
  stepLabel: undefined,
  item: "",
  stage: "pre",
  fileBytes: {},
  removeTotal: 0,
};

function raise(prev: number | undefined, next: number): number {
  return prev === undefined ? next : Math.max(prev, next);
}

function isPackageFile(filename: string): boolean {
  return filename.includes(".pkg.tar") && !filename.endsWith(".sig");
}

function downloadEnd(plan: ProgressPlan): number {
  return plan.downloadBytes > 0 ? DOWNLOAD_END : 0;
}

export function reduceProgress(state: ProgressState, event: StreamEvent, plan: ProgressPlan): ProgressState {
  switch (event.type) {
    case "download": {
      const base = { ...state, phase: "downloading" as const, phaseLabel: "Downloading packages", item: event.filename, stepLabel: undefined };
      if (!isPackageFile(event.filename)) return base;
      const bytes = event.event === "completed" ? event.total : event.downloaded;
      if (bytes === undefined) return base;
      const fileBytes = { ...state.fileBytes, [event.filename]: bytes };
      if (plan.downloadBytes <= 0) return { ...base, fileBytes };
      const done = Object.values(fileBytes).reduce((a, b) => a + b, 0);
      const fraction = Math.min(1, done / plan.downloadBytes);
      return { ...base, fileBytes, value: raise(state.value, fraction * DOWNLOAD_END) };
    }
    case "progress": {
      const check = CHECK_LABELS[event.operation];
      if (check) {
        const count = event.total > 0 ? ` (${event.current} of ${event.total})` : "";
        return { ...state, stepLabel: `${check}${count}` };
      }
      const label = TRANSACTION_LABELS[event.operation];
      if (!label) return state;
      const total = event.total;
      if (total <= 0) return { ...state, phase: "transaction", phaseLabel: label, item: event.package };
      const current = Math.min(Math.max(event.current, 1), total);
      const units = current - 1 + Math.min(Math.max(event.percent, 0), 100) / 100;
      const removing = event.operation === "remove_start";
      const removeTotal = removing ? total : state.removeTotal;
      const fraction = removing
        ? units / (total + plan.packages)
        : (removeTotal + units) / (removeTotal + total);
      const start = downloadEnd(plan);
      return {
        ...state,
        removeTotal,
        phase: "transaction",
        phaseLabel: label,
        item: event.package,
        stepLabel: `${current} of ${total}`,
        value: raise(state.value, start + fraction * (TRANSACTION_END - start)),
      };
    }
    case "event": {
      if (event.event === "transaction_start") return { ...state, stage: "transaction" };
      if (event.event === "transaction_done") return { ...state, stage: "post" };
      if (event.event !== "hook_run_start" && event.event !== "hook_run_done") return state;
      const post = state.stage === "post";
      const { current, total } = event;
      const known = current !== undefined && total !== undefined && total > 0;
      const next: ProgressState = {
        ...state,
        phase: "hooks",
        phaseLabel: post ? "Running post-transaction hooks" : "Running pre-transaction hooks",
        item: event.package ?? "",
        stepLabel: known ? `Running hook ${current} of ${total}` : undefined,
      };
      if (!post) return next;
      if (!known) return { ...next, value: raise(state.value, TRANSACTION_END) };
      const finished = event.event === "hook_run_done" ? current : current - 1;
      const computed = TRANSACTION_END + (finished / total) * (100 - TRANSACTION_END);
      return { ...next, value: raise(state.value, Math.min(computed, HOOKS_CAP)) };
    }
    case "complete":
      return event.success ? { ...state, value: 100 } : state;
    default:
      return state;
  }
}

/** Integer percent for display; floor keeps it monotonic with the raw value. */
export function progressPercent(state: ProgressState): number | undefined {
  return state.value === undefined ? undefined : Math.floor(state.value);
}

/** Spoken form, e.g. "42 percent, Upgrading packages, 5 of 12". */
export function progressValueText(state: ProgressState): string {
  const percent = progressPercent(state);
  return [percent === undefined ? undefined : `${percent} percent`, state.phaseLabel, state.stepLabel]
    .filter(Boolean)
    .join(", ");
}

import { BACKEND_TIMEOUT_MS, STREAM_FIRST_OUTPUT_TIMEOUT_MS } from "./constants";
import { isDbLockError, sanitizeSearchInput } from "./utils";
import { initialProgress, progressPercent, reduceProgress, type ProgressState } from "./progress";
import { startSystemWatch, type FileWatch } from "./systemWatch";

// Wire types are generated from the Rust serde structs via ts-rs (see
// backend/src + src/bindings). Imported for local use and re-exported so
// consumers keep importing them from "../api".
import type {
  CacheFiles,
  CacheInfo,
  DependencyTreeResponse,
  DismissalState,
  DowngradeResponse,
  GroupedLogResponse,
  IgnoreOperationResponse,
  IgnoredPackagesResponse,
  KeyringStatusResponse,
  ListReposResponse,
  LockRemoveResult,
  LockStatus,
  LogResponse,
  MirrorBackupListResponse,
  MirrorEntry,
  MirrorListResponse,
  MirrorStatusResponse,
  MirrorTestResult,
  NewsReadState,
  NewsResponse,
  OrphanResponse,
  PackageDetails,
  PackageListResponse,
  PacnewStatus,
  PreflightResponse,
  RebootStatus,
  RefreshMirrorsResponse,
  RepoBackupListResponse,
  RepoEntry,
  RestoreMirrorBackupResponse,
  RestoreRepoBackupResponse,
  SaveMirrorlistResponse,
  SaveReposResponse,
  ScheduleConfig,
  ScheduleMode,
  ScheduleSetResponse,
  ScheduledRunsResponse,
  SearchResponse,
  SecurityInfoResponse,
  SecurityResponse,
  ServicesStatus,
  SettingsResponse,
  SettingsSetResponse,
  SignoffActionResponse,
  SignoffBatchResponse,
  SignoffTarget,
  SignoffListResponse,
  StreamEvent,
  SyncPackageDetails,
  TransactionPreview,
  UpdatesResponse,
} from "./bindings";
export type * from "./bindings";

function backendPath(): string {
  const configured = cockpit.manifests?.pacman?.config?.backend;
  return typeof configured === "string" && configured.startsWith("/")
    ? configured
    : "/usr/libexec/cockpit-pacman/cockpit-pacman-backend";
}

export type FilterType = "all" | "explicit" | "dependency" | "orphan" | "graph";

export type SortDirection = "asc" | "desc";

export interface ListInstalledParams {
  offset?: number;
  limit?: number;
  search?: string;
  filter?: FilterType;
  repo?: string;
  sortBy?: string;
  sortDir?: SortDirection;
  signal?: AbortSignal;
}

export type InstalledFilterType = "all" | "installed" | "not-installed";

export interface SearchParams {
  query: string;
  offset?: number;
  limit?: number;
  installed?: InstalledFilterType;
  repo?: string;
  sortBy?: string;
  sortDir?: SortDirection;
  signal?: AbortSignal;
}

export type ErrorCode =
  | "timeout"
  | "database_locked"
  | "network_error"
  | "transaction_failed"
  | "signature_error"
  | "validation_error"
  | "cancelled"
  | "not_found"
  | "permission_denied"
  | "config_changed"
  | "internal_error";

export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "timeout",
  "database_locked",
  "network_error",
  "transaction_failed",
  "signature_error",
  "validation_error",
  "cancelled",
  "not_found",
  "permission_denied",
  "config_changed",
  "internal_error",
]);

// An unrecognized envelope code maps to internal_error, so a code the frontend
// doesn't know still surfaces as an error rather than a value.
function asErrorCode(code: string): ErrorCode {
  return KNOWN_ERROR_CODES.has(code) ? (code as ErrorCode) : "internal_error";
}

export function isNetworkErrorCode(code: ErrorCode): boolean {
  return code === "network_error";
}

export interface StructuredError {
  code: ErrorCode;
  message: string;
  details?: string;
}

export class BackendError extends Error {
  code: ErrorCode;
  details?: string;

  constructor(message: string, code: ErrorCode = "internal_error", details?: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.details = details;
  }

  static fromStructured(err: StructuredError): BackendError {
    return new BackendError(err.message, err.code, err.details);
  }

}

// Canonical network-error keyword list. Kept in sync with classify_message in
// backend/src/util.rs; the two can't share code across the FFI boundary, so the
// list is mirrored deliberately. parseErrorCode is the single TS classifier:
// other views (e.g. UpdatesView) call it instead of re-deriving from regexes.
export const NETWORK_ERROR_KEYWORDS = [
  "network",
  "connection",
  "could not connect",
  "unable to connect",
  "could not resolve",
  "resolve host",
  "host not found",
  "name resolution",
  "temporary failure in name resolution",
  "dns",
  "failed retrieving file",
  "failed to retrieve",
  "download library error",
];

// Package and key signature failures, as libalpm words them. Mirrors
// SIGNATURE_ERROR_KEYWORDS in backend/src/util.rs, which cites the source of each.
export const SIGNATURE_ERROR_KEYWORDS = [
  "pgp signature",
  "missing required signature",
  "signature from",
  "unknown trust",
  "marginal trust",
  "required key missing",
  "could not be looked up remotely",
  "\" is disabled",
];

export function parseErrorCode(message: string): ErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }
  if (isDbLockError(message)) {
    return "database_locked";
  }
  if (NETWORK_ERROR_KEYWORDS.some((kw) => lower.includes(kw))) {
    return "network_error";
  }
  if (SIGNATURE_ERROR_KEYWORDS.some((kw) => lower.includes(kw))) {
    return "signature_error";
  }
  if (lower.includes("transaction") || lower.includes("commit")) {
    return "transaction_failed";
  }
  if (lower.includes("cancelled") || lower.includes("canceled")) {
    return "cancelled";
  }
  if (lower.includes("not found")) {
    return "not_found";
  }
  if (lower.includes("permission denied")) {
    return "permission_denied";
  }
  if (lower.includes("invalid") || lower.includes("validation")) {
    return "validation_error";
  }
  return "internal_error";
}

async function runBackend<T>(command: string, args: string[] = [], options?: { superuser?: "try" | "require" | "none"; stdin?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  if (options?.signal?.aborted) throw new BackendError("Operation cancelled", "cancelled");
  const su = options?.superuser ?? "try";
  const spawnOpts: Record<string, unknown> = { err: "message" };
  if (su !== "none") {
    spawnOpts.superuser = su;
  }
  const spawnPromise = cockpit.spawn(
    [backendPath(), command, ...args],
    spawnOpts,
  );

  // Secrets go over stdin, never argv: /proc/<pid>/cmdline is world-readable.
  if (options?.stdin !== undefined) {
    spawnPromise.input(options.stdin);
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? BACKEND_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Handle abort signal by closing the spawn process
  controller.signal.addEventListener("abort", () => {
    spawnPromise.close("timeout");
  });

  const cancel = () => spawnPromise.close("cancelled");
  options?.signal?.addEventListener("abort", cancel, { once: true });

  const holdsDbLock = DB_LOCK_COMMANDS.has(command);
  if (holdsDbLock) beginOwnLockCall();
  let output: string;
  try {
    output = await spawnPromise;
  } catch (ex) {
    if (options?.signal?.aborted) throw new BackendError("Operation cancelled", "cancelled");
    if (controller.signal.aborted) {
      throw new BackendError(
        `Backend operation timed out after ${timeoutMs / 1000}s`,
        "timeout"
      );
    }
    if (ex instanceof BackendError) {
      throw ex;
    }
    const message = ex instanceof Error ? ex.message : String(ex);
    const code = parseErrorCode(message);
    throw new BackendError(`Backend command '${command}' failed: ${message}`, code);
  } finally {
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener("abort", cancel);
    if (holdsDbLock) endOwnLockCall();
  }

  if (!output || output.trim() === "") {
    throw new BackendError(
      `Backend returned empty response for command: ${command}`,
      "internal_error"
    );
  }

  try {
    const parsed = JSON.parse(output);
    const rec = parsed as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof rec.code === "string" &&
      typeof rec.message === "string"
    ) {
      throw BackendError.fromStructured({
        code: asErrorCode(rec.code),
        message: rec.message,
        details: typeof rec.details === "string" ? rec.details : undefined,
      });
    }
    return parsed as T;
  } catch (ex) {
    if (ex instanceof BackendError) {
      throw ex;
    }
    throw new BackendError(
      `Backend returned invalid JSON for ${command}: ${ex instanceof Error ? ex.message : String(ex)}`,
      "internal_error"
    );
  }
}

export async function listInstalled(
  params: ListInstalledParams = {}
): Promise<PackageListResponse> {
  const { offset = 0, limit = 50, search = "", filter = "all", repo = "all", sortBy = "", sortDir = "" } = params;
  return runBackend<PackageListResponse>("list-installed", [
    String(offset),
    String(limit),
    sanitizeSearchInput(search),
    filter,
    repo,
    sortBy,
    sortDir,
  ], { superuser: "none", signal: params.signal });
}

export async function checkUpdates(): Promise<UpdatesResponse> {
  return runBackend<UpdatesResponse>("check-updates", [], { superuser: "none" });
}

export async function checkLock(): Promise<LockStatus> {
  return runBackend<LockStatus>("check-lock");
}

export async function removeStaleLock(): Promise<LockRemoveResult> {
  return runBackend<LockRemoveResult>("remove-stale-lock", [], { superuser: "require" });
}

export async function checkSecurity(force = false): Promise<SecurityResponse> {
  return runBackend<SecurityResponse>("check-security", [String(force)], { superuser: "none" });
}

export async function getSecurityInfo(name: string): Promise<SecurityInfoResponse> {
  return runBackend<SecurityInfoResponse>("security-info", [name], { superuser: "none" });
}

export async function getSettings(): Promise<SettingsResponse> {
  return runBackend<SettingsResponse>("get-settings", [], { superuser: "none" });
}

export async function setSecurityAdvisories(enabled: boolean): Promise<SettingsSetResponse> {
  return runBackend<SettingsSetResponse>("set-settings", [String(enabled)]);
}

export async function getPackageInfo(name: string): Promise<PackageDetails> {
  return runBackend<PackageDetails>("local-package-info", [name], { superuser: "none" });
}

export async function searchPackages(params: SearchParams): Promise<SearchResponse> {
  const { query, offset = 0, limit = 100, installed = "all", repo, sortBy = "", sortDir = "" } = params;
  return runBackend<SearchResponse>("search", [sanitizeSearchInput(query), String(offset), String(limit), installed, sortBy, sortDir, ...(repo ? [repo] : [])], { superuser: "none", signal: params.signal });
}

export async function getSyncPackageInfo(name: string, repo?: string): Promise<SyncPackageDetails> {
  const args = repo ? [name, repo] : [name];
  return runBackend<SyncPackageDetails>("sync-package-info", args, { superuser: "none" });
}

export async function preflightUpgrade(ignore?: string[]): Promise<PreflightResponse> {
  const args = ignore && ignore.length > 0 ? [ignore.map(pkg => sanitizeSearchInput(pkg)).join(",")] : [];
  return runBackend<PreflightResponse>("preflight-upgrade", args);
}

export interface InstallTarget {
  repo?: string;
  version?: string;
  reinstall?: boolean;
}

const installTargetArgs = (target: InstallTarget) => [target.repo ?? "", target.version ?? "", String(target.reinstall ?? false)];

/** Resolves `install-package NAME` without committing. Takes the database lock. */
export async function previewInstall(name: string, target?: InstallTarget): Promise<TransactionPreview> {
  return runBackend<TransactionPreview>("preflight-install", [sanitizeSearchInput(name), ...(target ? installTargetArgs(target) : [])]);
}

/** Resolves `remove-package NAME` (with unneeded dependencies) without committing. */
export async function previewRemove(name: string): Promise<TransactionPreview> {
  return runBackend<TransactionPreview>("preflight-remove", [sanitizeSearchInput(name)]);
}

/** Resolves removing the given orphans, or all of them, without committing. */
export async function previewRemoveOrphans(names?: string[]): Promise<TransactionPreview> {
  const args = names && names.length > 0 ? [names.map(n => sanitizeSearchInput(n)).join(",")] : [];
  return runBackend<TransactionPreview>("preflight-remove-orphans", args);
}

export interface PreviewTotals {
  /** Packages the transaction installs, upgrades or removes. */
  count: number;
  downloadBytes: number;
  download: string;
  /** Signed change in installed size; "+" when it grows. */
  net: string;
}

/** Formats package, download and installed-size totals. */
export function previewTotals(count: number, downloadBytes: number, netBytes: number): PreviewTotals {
  const net = formatSize(netBytes);
  return { count, downloadBytes, download: formatSize(downloadBytes), net: netBytes > 0 ? `+${net}` : net };
}

export function formatPreviewTotals(p: TransactionPreview): PreviewTotals {
  return previewTotals(p.add.length + p.remove.length, p.total_download_size, p.net_installed_size);
}

/**
 * Callbacks for streaming backend operations (sync, upgrade, orphan removal, etc.)
 *
 * @example
 * ```typescript
 * const { cancel } = runUpgrade({
 *   onEvent: (event) => console.log('Event:', event),
 *   onData: (data) => setLog(prev => prev + data),
 *   onComplete: () => setState('success'),
 *   onError: (err) => setError(err),
 *   timeout: 300,
 * });
 * ```
 */
export interface UpgradeCallbacks {
  /** Called for each structured StreamEvent (log, progress, download, etc.) */
  onEvent?: (event: StreamEvent) => void;
  /** Called with raw formatted output text for display in logs */
  onData?: (data: string) => void;
  /** Called when the operation completes successfully */
  onComplete: () => void;
  /** Called when the operation fails with an error message and a classified code */
  onError: (error: string, code?: ErrorCode, details?: string) => void;
  /** Timeout in seconds for the operation (default: 300) */
  timeout?: number;
  /** Superuser mode for cockpit.spawn (default: "require") */
  superuser?: "none" | "try" | "require";
  /** Called for each parsed JSON event before default handling. Return true to skip default processing. */
  onRawEvent?: (event: Record<string, unknown>) => boolean;
}

function extractErrorMessage(ex: unknown): string {
  if (ex instanceof Error) return ex.message;
  if (ex && typeof ex === "object") {
    const obj = ex as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.exit_status === "number") {
      return `Operation failed (exit ${obj.exit_status})`;
    }
  }
  if (typeof ex === "string") return ex;
  return "Operation failed with unknown error";
}

export interface StreamingHandle {
  /** With gracefulCancel, asks the backend to stop and keeps the stream open
   * until onComplete/onError; otherwise closes the channel. */
  cancel: () => void;
  /** Close the channel; this does not confirm that the backend has exited. */
  forceStop: () => void;
  /** Sets the registry entry's reopen while this run is the active transaction. */
  setReopen?: (reopen: (() => void) | undefined) => void;
}

export type SystemChangeKind = "system" | "sync";

type SystemChangeListener = (kind: SystemChangeKind) => void;

const systemChangeListeners = new Set<{ listener: SystemChangeListener; kinds: SystemChangeKind[] }>();

const SYSTEM_CHANGE_COMMANDS: Record<string, SystemChangeKind> = {
  "upgrade": "system",
  "install-package": "system",
  "remove-package": "system",
  "remove-orphans": "system",
  "downgrade": "system",
  "downgrade-archive": "system",
  "clean-cache": "system",
  "refresh-keyring": "system",
  "init-keyring": "system",
  "sync-database": "sync",
};

/** Subscribes to completed mutations and external changes. Failures also notify because state may have changed. */
export function onSystemChanged(
  listener: SystemChangeListener,
  kinds: SystemChangeKind[] = ["system", "sync"],
): () => void {
  const entry = { listener, kinds };
  systemChangeListeners.add(entry);
  if (!systemWatch) {
    systemWatch = startSystemWatch({
      ownActivity: () => activeTransaction !== null && activeTransaction.command !== EXTERNAL_COMMAND,
      notify: () => notifySystemChanged("system"),
    });
  }
  return () => {
    systemChangeListeners.delete(entry);
    if (systemChangeListeners.size === 0 && systemWatch) {
      systemWatch.close();
      systemWatch = null;
    }
  };
}

function notifySystemChanged(kind: SystemChangeKind): void {
  for (const entry of [...systemChangeListeners]) {
    if (!entry.kinds.includes(kind)) continue;
    try {
      entry.listener(kind);
    } catch (listenerError) {
      console.error("System change listener error:", listenerError);
    }
  }
}

export interface ActiveTransaction {
  /** Backend command, or "external" for a lock held by a process outside this page. */
  command: string;
  /** Package name for single-package commands; the holding process for "external". */
  target?: string;
  startedAt: number;
  /** Reopens the dialog showing this run's progress, for runs moved to the background. */
  reopen?: () => void;
  /** Current step, e.g. "Downloading packages". */
  phase?: string;
  /** 0-100, undefined while no count is known. */
  percent?: number;
}

export interface TransactionOutcome {
  command: string;
  target?: string;
  status: "success" | "stopped" | "failed";
  endedAt: number;
}

type ActiveTransactionListener = (transaction: ActiveTransaction | null) => void;

let activeTransaction: ActiveTransaction | null = null;
let transactionOutcome: TransactionOutcome | null = null;
// Bumped whenever this page starts or ends a run, so a lock check that overlapped one is discarded.
let ownRunEpoch = 0;
let ownLockCalls = 0;
let systemWatch: FileWatch | null = null;

/** Non-streaming commands whose backend holds db.lck through a transaction while it runs. */
const DB_LOCK_COMMANDS = new Set([
  "preflight-upgrade",
  "preflight-install",
  "preflight-remove",
  "preflight-remove-orphans",
  "preflight-downgrade",
  "set-install-reason",
]);

function beginOwnLockCall(): void {
  ownLockCalls++;
  ownRunEpoch++;
}

function endOwnLockCall(): void {
  ownLockCalls--;
  ownRunEpoch++;
}
const activeTransactionListeners = new Set<ActiveTransactionListener>();

const EXTERNAL_COMMAND = "external";
const PROGRESS_PUBLISH_MS = 250;

const TARGETED_COMMANDS = new Set(["install-package", "remove-package", "downgrade", "downgrade-archive"]);

/** The system-changing streaming command currently running in this page, if any. */
export function getActiveTransaction(): ActiveTransaction | null {
  return activeTransaction;
}

/** How the last system-changing command run by this page ended, until dismissed or replaced. */
export function getTransactionOutcome(): TransactionOutcome | null {
  return transactionOutcome;
}

export function dismissTransactionOutcome(): void {
  if (!transactionOutcome) return;
  transactionOutcome = null;
  setActiveTransaction(activeTransaction);
}

/** Subscribes to transaction, progress and outcome changes; returns an unsubscribe function. */
export function onActiveTransactionChanged(listener: ActiveTransactionListener): () => void {
  activeTransactionListeners.add(listener);
  return () => {
    activeTransactionListeners.delete(listener);
  };
}

function setActiveTransaction(transaction: ActiveTransaction | null): void {
  activeTransaction = transaction;
  for (const listener of [...activeTransactionListeners]) {
    try {
      listener(transaction);
    } catch (listenerError) {
      console.error("Active transaction listener error:", listenerError);
    }
  }
}

function setExternalHolder(holder: string | null): void {
  const current = activeTransaction;
  if (current && current.command !== EXTERNAL_COMMAND) return;
  if (!holder) {
    if (current) {
      setActiveTransaction(null);
      notifySystemChanged("system");
    }
    return;
  }
  if (current?.target === holder) return;
  setActiveTransaction({ command: EXTERNAL_COMMAND, target: holder, startedAt: Date.now() });
}

/** Tracks external lock holders, excluding this page's own lock calls. */
export async function refreshExternalLockHolder(): Promise<void> {
  if (activeTransaction && activeTransaction.command !== EXTERNAL_COMMAND) return;
  if (ownLockCalls > 0) return;
  const epoch = ownRunEpoch;
  const status = await checkLock();
  if (epoch !== ownRunEpoch) return;
  setExternalHolder(status.locked && !status.stale ? status.blocking_process ?? null : null);
}

function runStreamingBackend(
  command: string,
  args: string[],
  callbacks: UpgradeCallbacks,
  options?: { gracefulCancel?: boolean }
): StreamingHandle {
  if (command in SYSTEM_CHANGE_COMMANDS && activeTransaction && activeTransaction.command !== EXTERNAL_COMMAND) {
    globalThis.queueMicrotask(() => callbacks.onError("Another package operation is still running.", "database_locked"));
    return { cancel() {}, forceStop() {} };
  }
  let buffer = "";
  let completionHandled = false;
  type Completion = { success: boolean; message?: string; code?: ErrorCode; details?: string };
  let terminal: Completion | undefined;
  let startupTimeout: Completion | undefined;
  let signatureFailure = false;

  const markComplete = (
    success: boolean,
    message?: string,
    code?: ErrorCode,
    details?: string,
  ) => {
    if (completionHandled) return;
    completionHandled = true;

    const msg = message || "Operation failed";
    let failureCode = code ?? parseErrorCode(msg);
    if (
      code === undefined && failureCode === "transaction_failed" && signatureFailure &&
      msg.toLowerCase().includes("invalid or corrupted package")
    ) {
      failureCode = "signature_error";
    }

    clearProgressTimer();
    if (registered) {
      ownRunEpoch++;
          transactionOutcome = {
        command,
        target: registered.target,
        status: success ? "success" : failureCode === "cancelled" ? "stopped" : "failed",
        endedAt: Date.now(),
      };
    }
    // Cleared before the callbacks so a follow-up mutation they start is not gated on this one.
    if (registered && activeTransaction === registered) {
      setActiveTransaction(null);
    } else if (registered) {
      setActiveTransaction(activeTransaction);
    }

    try {
      if (success) {
        callbacks.onComplete();
      } else {
        callbacks.onError(msg, failureCode, details);
      }
    } catch (callbackError) {
      console.error("Callback error in markComplete:", callbackError);
    }

    const changeKind = SYSTEM_CHANGE_COMMANDS[command];
    if (changeKind) notifySystemChanged(changeKind);
  };

  // A handler that returns Err (rather than emitting a complete event) makes
  // main.rs print a structured error envelope on stdout. It has a known code
  // and message but no StreamEvent `type`; treat it as a terminal error so the
  // backend's classification is not lost as an unknown event.
  const asErrorEnvelope = (
    parsed: Record<string, unknown>,
  ): { code: ErrorCode; message: string; details?: string } | null => {
    if (
      !("type" in parsed) &&
      typeof parsed.message === "string" &&
      typeof parsed.code === "string"
    ) {
      return {
        code: asErrorCode(parsed.code),
        message: parsed.message,
        details: typeof parsed.details === "string" ? parsed.details : undefined,
      };
    }
    return null;
  };

  const recordErrorEnvelope = (envelope: { code: ErrorCode; message: string; details?: string }) => {
    terminal = {
      success: false,
      ...envelope,
      code: terminal && !terminal.success ? terminal.code ?? envelope.code : envelope.code,
      details: envelope.details ?? terminal?.details,
    };
  };

  const su = callbacks.superuser ?? "require";
  let registered: ActiveTransaction | null = null;
  let progress: ProgressState = initialProgress;
  let progressPublishedAt = 0;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

  const clearProgressTimer = () => {
    if (progressTimer !== undefined) {
      clearTimeout(progressTimer);
      progressTimer = undefined;
    }
  };

  const publishProgress = () => {
    progressTimer = undefined;
    if (!registered || activeTransaction !== registered) return;
    progressPublishedAt = Date.now();
    const percent = progressPercent(progress);
    if (registered.phase === progress.phaseLabel && registered.percent === percent) return;
    registered = { ...registered, phase: progress.phaseLabel, percent };
    setActiveTransaction(registered);
  };

  // Database files are not package downloads, so the reducer's labels do not fit a sync.
  const tracksProgress = command in SYSTEM_CHANGE_COMMANDS && command !== "sync-database";
  const trackProgress = (event: StreamEvent) => {
    if (!tracksProgress || completionHandled) return;
    progress = reduceProgress(progress, event, { downloadBytes: 0, packages: 0 });
    if (progressTimer !== undefined) return;
    progressTimer = setTimeout(publishProgress, Math.max(0, progressPublishedAt + PROGRESS_PUBLISH_MS - Date.now()));
  };

  const proc = cockpit.spawn(
    [backendPath(), command, ...args],
    su === "none" ? { err: "out" } : { superuser: su, err: "out" }
  );

  let firstOutputTimer: ReturnType<typeof setTimeout> | undefined;
  let outputSeen = false;

  const clearFirstOutputTimer = () => {
    outputSeen = true;
    if (firstOutputTimer !== undefined) {
      clearTimeout(firstOutputTimer);
      firstOutputTimer = undefined;
    }
  };

  proc.stream((data) => {
    clearFirstOutputTimer();
    buffer += data;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;

        if (callbacks.onRawEvent?.(parsed)) continue;

        const envelope = asErrorEnvelope(parsed);
        if (envelope) {
          recordErrorEnvelope(envelope);
          continue;
        }

        const event = parsed as unknown as StreamEvent;
        callbacks.onEvent?.(event);
        trackProgress(event);

        if (event.type === "log") {
          // libalpm can replace a signature error with a generic integrity error at commit.
          if (event.level === "error" && parseErrorCode(event.message) === "signature_error") {
            signatureFailure = true;
          }
          callbacks.onData?.(`[${event.level}] ${event.message}\n`);
        } else if (event.type === "progress") {
          callbacks.onData?.(`[${event.operation}] ${event.package} ${event.percent}%\n`);
        } else if (event.type === "download") {
          if (event.event === "progress" && event.downloaded && event.total) {
            const pct = Math.round((event.downloaded / event.total) * 100);
            callbacks.onData?.(`Downloading ${event.filename}: ${pct}%\n`);
          } else if (event.event === "completed") {
            callbacks.onData?.(`Downloaded ${event.filename}\n`);
          }
        } else if (event.type === "event") {
          callbacks.onData?.(`${event.event}${event.package ? `: ${event.package}` : ""}\n`);
        } else if (event.type === "complete") {
          terminal = { success: event.success, message: event.message, code: event.code ? asErrorCode(event.code) : undefined, details: event.details };
        } else if (event.type === "mirror_test") {
          callbacks.onData?.(
            `[${event.current}/${event.total}] ${event.url}: ${event.result.success ? `${event.result.latency_ms}ms` : event.result.error}\n`,
          );
        } else {
          const unhandled: never = event;
          console.warn("Unknown StreamEvent type:", (unhandled as StreamEvent).type);
        }
      } catch {
        callbacks.onData?.(line + "\n");
      }
    }
  });

  const finish = (failure?: unknown) => {
    if (completionHandled) return;
    clearFirstOutputTimer();
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer) as Record<string, unknown>;
        const envelope = asErrorEnvelope(parsed);
        if (envelope) {
          recordErrorEnvelope(envelope);
        } else {
          const event = parsed as unknown as StreamEvent;
          if (event.type === "complete") {
            terminal = { success: event.success, message: event.message, code: event.code ? asErrorCode(event.code) : undefined, details: event.details };
          }
        }
      } catch {
        callbacks.onData?.(buffer + "\n");
      }
    }
    const problem = failure && typeof failure === "object" && "problem" in failure ? failure.problem : undefined;
    if (problem === "disconnected" || problem === "connection-lost" || problem === "connection-closed") {
      markComplete(false,
        "Connection to the backend was lost. The operation may still be finishing; check its state before retrying.",
        "internal_error",
        terminal?.details ?? extractErrorMessage(failure));
      return;
    }
    // Complete may arrive while the transaction still holds db.lck.
    const result = terminal && (!terminal.success || failure === undefined) ? terminal : startupTimeout;
    if (result) {
      markComplete(result.success, result.message, result.code, result.details);
    } else if (failure !== undefined) {
      markComplete(false, extractErrorMessage(failure));
    } else {
      markComplete(false, "Backend process ended without sending completion status");
    }
  };
  proc.then(() => finish());
  proc.catch((ex: unknown) => finish(ex));

  // Armed only once every handler is attached, so a spawn that throws leaves no timer behind.
  if (!outputSeen && !completionHandled) {
    firstOutputTimer = setTimeout(() => {
    firstOutputTimer = undefined;
    startupTimeout = {
      success: false,
      message: `Backend command '${command}' produced no output within ${STREAM_FIRST_OUTPUT_TIMEOUT_MS / 1000}s.` +
        (su === "none" ? "" : " The privileged bridge may be waiting for administrative access."),
      code: "timeout",
    };
    if (options?.gracefulCancel) proc.input("cancel\n", true);
    else proc.close("timeout");
    }, STREAM_FIRST_OUTPUT_TIMEOUT_MS);
  }

  if (command in SYSTEM_CHANGE_COMMANDS && !completionHandled) {
    registered = {
      command,
      target: TARGETED_COMMANDS.has(command) ? args[0] : undefined,
      startedAt: Date.now(),
    };
    ownRunEpoch++;
    transactionOutcome = null;
    setActiveTransaction(registered);
  }

  const forceStop = () => proc.close("cancelled");
  const setReopen = (reopen: (() => void) | undefined) => {
    if (!registered || activeTransaction !== registered) return;
    registered = { ...registered, reopen };
    setActiveTransaction(registered);
  };
  return {
    cancel: options?.gracefulCancel ? () => proc.input("cancel\n", true) : forceStop,
    forceStop,
    setReopen,
  };
}

export function runUpgrade(callbacks: UpgradeCallbacks, ignore?: string[], approvedRemovals: string[] = []): StreamingHandle {
  const args = [
    (ignore ?? []).map(pkg => sanitizeSearchInput(pkg)).join(","),
    callbacks.timeout === undefined ? "" : String(callbacks.timeout),
    approvedRemovals.map(pkg => sanitizeSearchInput(pkg)).join(","),
  ];
  return runStreamingBackend("upgrade", args, callbacks, { gracefulCancel: true });
}

export function syncDatabase(callbacks: UpgradeCallbacks, force = false): StreamingHandle {
  const args = [String(force)];
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }
  return runStreamingBackend("sync-database", args, callbacks, { gracefulCancel: true });
}

export function formatSize(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MiB`;
  return `${sign}${(abs / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export async function getKeyringStatus(): Promise<KeyringStatusResponse> {
  return runBackend<KeyringStatusResponse>("keyring-status");
}

export function refreshKeyring(callbacks: UpgradeCallbacks): StreamingHandle {
  return runStreamingBackend("refresh-keyring", [], callbacks, { gracefulCancel: true });
}

export function initKeyring(callbacks: UpgradeCallbacks): StreamingHandle {
  return runStreamingBackend("init-keyring", [], callbacks, { gracefulCancel: true });
}

export async function listOrphans(): Promise<OrphanResponse> {
  return runBackend<OrphanResponse>("list-orphans", [], { superuser: "none" });
}

export function installPackage(
  callbacks: UpgradeCallbacks,
  name: string,
  approvedRemovals: string[] = [],
  target?: InstallTarget,
): StreamingHandle {
  const args = [sanitizeSearchInput(name)];
  args.push(callbacks.timeout === undefined ? "" : String(callbacks.timeout));
  args.push(approvedRemovals.map(pkg => sanitizeSearchInput(pkg)).join(","));
  if (target) args.push(...installTargetArgs(target));
  return runStreamingBackend("install-package", args, callbacks, { gracefulCancel: true });
}

export function removePackage(
  callbacks: UpgradeCallbacks,
  name: string,
  approvedRemovals: string[] = [],
): StreamingHandle {
  const args = [sanitizeSearchInput(name), callbacks.timeout === undefined ? "" : String(callbacks.timeout),
    approvedRemovals.map(pkg => sanitizeSearchInput(pkg)).join(",")];
  return runStreamingBackend("remove-package", args, callbacks, { gracefulCancel: true });
}

/** Removes the given orphans, or every orphan when `names` is empty. */
export function removeOrphans(callbacks: UpgradeCallbacks, names?: string[], approvedRemovals: string[] = []): StreamingHandle {
  const args = [callbacks.timeout === undefined ? "" : String(callbacks.timeout),
    (names ?? []).map(sanitizeSearchInput).join(","),
    approvedRemovals.map(sanitizeSearchInput).join(",")];
  return runStreamingBackend("remove-orphans", args, callbacks, { gracefulCancel: true });
}

export async function listIgnoredPackages(): Promise<IgnoredPackagesResponse> {
  return runBackend<IgnoredPackagesResponse>("list-ignored", [], { superuser: "none" });
}

export async function addIgnoredPackage(name: string): Promise<IgnoreOperationResponse> {
  return runBackend<IgnoreOperationResponse>("add-ignored", [name]);
}

export async function removeIgnoredPackage(name: string): Promise<IgnoreOperationResponse> {
  return runBackend<IgnoreOperationResponse>("remove-ignored", [name]);
}

export interface CacheParams {
  offset?: number;
  limit?: number;
  search?: string;
  sortBy?: "name" | "version" | "size";
  sortDir?: SortDirection;
}

export async function getCacheInfo(params: CacheParams = {}): Promise<CacheInfo> {
  const { offset = 0, limit = 50, search = "", sortBy = "name", sortDir = "asc" } = params;
  return runBackend<CacheInfo>("cache-info", [String(offset), String(limit), sanitizeSearchInput(search), sortBy, sortDir], { superuser: "none" });
}

export async function getCacheFiles(name: string, offset = 0, limit = 50): Promise<CacheFiles> {
  return runBackend<CacheFiles>("cache-files", [name, String(offset), String(limit)], { superuser: "none" });
}

export type CacheSelection = { mode: "all" } | { mode: "only" | "except"; names: string[] };

export function cleanCache(callbacks: UpgradeCallbacks, keepVersions = 3, selection: CacheSelection = { mode: "all" }): StreamingHandle {
  const names = selection.mode === "all" ? [] : selection.names;
  if (selection.mode === "only" && names.length === 0) {
    throw new Error("Select at least one package to clean");
  }
  return runStreamingBackend("clean-cache", [String(keepVersions), names.join(","), selection.mode], callbacks, { gracefulCancel: true });
}

export type HistoryFilterType = "all" | "upgraded" | "installed" | "removed";

export interface HistoryParams {
  offset?: number;
  limit?: number;
  filter?: HistoryFilterType;
  search?: string;
}

export async function getGroupedHistory(params: HistoryParams = {}): Promise<GroupedLogResponse> {
  const { offset = 0, limit = 20, filter = "all", search = "" } = params;
  return runBackend<GroupedLogResponse>("history-grouped", [
    String(offset),
    String(limit),
    filter,
    search,
  ], { superuser: "none" });
}

export async function getHistory(params: HistoryParams = {}): Promise<LogResponse> {
  const { offset = 0, limit = 20, filter = "all", search = "" } = params;
  return runBackend<LogResponse>("history", [String(offset), String(limit), filter, search], { superuser: "none" });
}

export async function listDowngrades(packageName?: string): Promise<DowngradeResponse> {
  const args = packageName ? [sanitizeSearchInput(packageName)] : [];
  return runBackend<DowngradeResponse>("list-downgrades", args, { superuser: "none" });
}

export function downgradePackage(
  callbacks: UpgradeCallbacks,
  name: string,
  version: string,
  approvedRemovals: string[] = [],
): StreamingHandle {
  return runStreamingBackend("downgrade", [sanitizeSearchInput(name), sanitizeSearchInput(version), "", approvedRemovals.map(sanitizeSearchInput).join(",")], callbacks, { gracefulCancel: true });
}

/** Resolves `downgrade NAME VERSION` from the cached file without committing. */
export async function previewDowngrade(name: string, version: string): Promise<TransactionPreview> {
  return runBackend<TransactionPreview>("preflight-downgrade", [sanitizeSearchInput(name), sanitizeSearchInput(version)]);
}

/**
 * Downloads an archive package into the cache, then resolves
 * `downgrade-archive NAME FILENAME` without committing. Download events reach
 * `onEvent`; aborting `signal` stops the backend and rejects with "cancelled".
 */
export function previewDowngradeArchive(
  name: string,
  filename: string,
  options: { onEvent?: (event: StreamEvent) => void; signal?: AbortController["signal"] } = {},
): Promise<TransactionPreview> {
  return new Promise((resolve, reject) => {
    const command = "preflight-downgrade-archive";
    const proc = cockpit.spawn(
      [backendPath(), command, sanitizeSearchInput(name), filename],
      { superuser: "try", err: "message" },
    );
    beginOwnLockCall();
    let lockCallEnded = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const endLockCall = () => {
      if (lockCallEnded) return;
      lockCallEnded = true;
      clearTimeout(deadline);
      endOwnLockCall();
    };
    let buffer = "";
    let preview: TransactionPreview | null = null;
    let failure: BackendError | null = null;

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof parsed.type === "string") {
        options.onEvent?.(parsed as unknown as StreamEvent);
      } else if (typeof parsed.code === "string" && typeof parsed.message === "string") {
        failure = BackendError.fromStructured({
          code: asErrorCode(parsed.code),
          message: parsed.message,
          details: typeof parsed.details === "string" ? parsed.details : undefined,
        });
      } else {
        preview = parsed as unknown as TransactionPreview;
      }
    };

    const abort = () => proc.close("cancelled");

    proc.stream((data) => {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(handleLine);
    });
    proc.then(() => {
      endLockCall();
      options.signal?.removeEventListener("abort", abort);
      handleLine(buffer);
      if (failure) reject(failure);
      else if (preview) resolve(preview);
      else reject(new BackendError(`Backend returned no preview for ${command}`, "internal_error"));
    });
    proc.catch((ex: unknown) => {
      endLockCall();
      options.signal?.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
        return;
      }
      const message = options.signal?.aborted ? "cancelled" : extractErrorMessage(ex);
      reject(new BackendError(`Backend command '${command}' failed: ${message}`, parseErrorCode(message)));
    });
    options.signal?.addEventListener("abort", abort);
    if (options.signal?.aborted) abort();
    else if (!lockCallEnded) deadline = setTimeout(() => {
      failure = new BackendError("Archive preview timed out.", "timeout");
      proc.close("timeout");
    }, 300_000);
  });
}

export async function listArchiveVersions(packageName: string, query?: string): Promise<DowngradeResponse> {
  const args = [sanitizeSearchInput(packageName)];
  if (query && query.trim()) {
    args.push(sanitizeSearchInput(query));
  }
  return runBackend<DowngradeResponse>("list-archive-versions", args, { superuser: "none" });
}

export function downgradeFromArchive(
  callbacks: UpgradeCallbacks,
  name: string,
  filename: string,
  approvedRemovals: string[] = [],
): StreamingHandle {
  return runStreamingBackend("downgrade-archive", [sanitizeSearchInput(name), filename, "", approvedRemovals.map(sanitizeSearchInput).join(",")], callbacks, { gracefulCancel: true });
}

export interface ScheduledRunsParams {
  offset?: number;
  limit?: number;
}

export async function getScheduleConfig(): Promise<ScheduleConfig> {
  return runBackend<ScheduleConfig>("get-schedule", [], { superuser: "none" });
}

export interface SetScheduleParams {
  enabled?: boolean;
  mode?: ScheduleMode;
  schedule?: string;
  max_packages?: number;
}

export async function setScheduleConfig(params: SetScheduleParams): Promise<ScheduleSetResponse> {
  const args: string[] = [
    params.enabled !== undefined ? String(params.enabled) : "",
    params.mode || "",
    params.schedule || "",
    params.max_packages !== undefined ? String(params.max_packages) : "",
  ];
  return runBackend<ScheduleSetResponse>("set-schedule", args);
}

export async function getScheduledRuns(params: ScheduledRunsParams = {}): Promise<ScheduledRunsResponse> {
  const { offset = 0, limit = 50 } = params;
  return runBackend<ScheduledRunsResponse>("list-scheduled-runs", [String(offset), String(limit)], { superuser: "none" });
}

export type RebootReason = "kernel_update" | "critical_packages" | "none";

export async function getRebootStatus(): Promise<RebootStatus> {
  return runBackend<RebootStatus>("reboot-status", [], { superuser: "none" });
}

export type PacnewKind = "pacnew" | "pacsave";

export async function getPacnewStatus(): Promise<PacnewStatus> {
  return runBackend<PacnewStatus>("pacnew-status", [], { superuser: "none" });
}

export async function getBackendVersion(): Promise<string> {
  const { version } = await runBackend<{ version: string }>("version", [], { superuser: "none" });
  return version;
}

export function rebootSystem(): Promise<void> {
  const client = cockpit.dbus("org.freedesktop.login1", { bus: "system", superuser: "try" });
  return client
    .call(
      "/org/freedesktop/login1",
      "org.freedesktop.login1.Manager",
      "Reboot",
      [false],
    )
    .finally(() => client.close())
    .then(() => undefined);
}

export async function getServicesStatus(): Promise<ServicesStatus> {
  return runBackend<ServicesStatus>("services-status");
}

const UNIT_NAME_RE = /^[A-Za-z0-9@:._-]+\.(service|socket|target|path|timer|mount)$/;

export function restartServices(units: string[]): Promise<void> {
  for (const unit of units) {
    if (!UNIT_NAME_RE.test(unit)) {
      return Promise.reject(new Error(`refusing to restart unsafe unit name: ${unit}`));
    }
  }
  const client = cockpit.dbus("org.freedesktop.systemd1", { bus: "system", superuser: "try" });
  return Promise.all(
    units.map((u) =>
      client.call(
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "RestartUnit",
        [u, "replace"],
      ),
    ),
  )
    .finally(() => client.close())
    .then(() => undefined);
}

export interface MirrorTestCallbacks {
  onTestResult?: (result: MirrorTestResult, current: number, total: number) => void;
  onData?: (data: string) => void;
  onComplete: () => void;
  onError: (error: string, code?: ErrorCode, details?: string) => void;
  timeout?: number;
}

export async function listMirrors(): Promise<MirrorListResponse> {
  return runBackend<MirrorListResponse>("list-mirrors", [], { superuser: "none" });
}

export async function fetchMirrorStatus(): Promise<MirrorStatusResponse> {
  return runBackend<MirrorStatusResponse>("fetch-mirror-status", [], { superuser: "none" });
}

export function testMirrors(
  callbacks: MirrorTestCallbacks,
  urls?: string[]
): StreamingHandle {
  const args: string[] = [];
  args.push(urls && urls.length > 0 ? urls.join(",") : "");
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }

  return runStreamingBackend("test-mirrors", args, {
    onData: callbacks.onData,
    onComplete: callbacks.onComplete,
    onError: callbacks.onError,
    timeout: callbacks.timeout,
    superuser: "none",
    onRawEvent: (event) => {
      if (event.type === "mirror_test") {
        const e = event as unknown as Extract<StreamEvent, { type: "mirror_test" }>;
        callbacks.onTestResult?.(e.result, e.current, e.total);
      }
      return false;
    },
  });
}

export async function saveMirrorlist(mirrors: MirrorEntry[]): Promise<SaveMirrorlistResponse> {
  return runBackend<SaveMirrorlistResponse>("save-mirrorlist", [JSON.stringify(mirrors)]);
}

export type RefreshMirrorsSortBy = "score" | "delay" | "age";
export type RefreshMirrorsProtocol = "https" | "http" | "all";

export interface RefreshMirrorsParams {
  count?: number;
  country?: string;
  protocol?: RefreshMirrorsProtocol;
  sortBy?: RefreshMirrorsSortBy;
}

export async function refreshMirrors(params: RefreshMirrorsParams = {}): Promise<RefreshMirrorsResponse> {
  const { count = 20, country = "", protocol = "https", sortBy = "score" } = params;
  return runBackend<RefreshMirrorsResponse>("refresh-mirrors", [
    String(count),
    country,
    protocol,
    sortBy,
  ], { superuser: "none" });
}

export async function listMirrorBackups(): Promise<MirrorBackupListResponse> {
  return runBackend<MirrorBackupListResponse>("list-mirror-backups", [], { superuser: "require" });
}

export async function restoreMirrorBackup(timestamp: number): Promise<RestoreMirrorBackupResponse> {
  return runBackend<RestoreMirrorBackupResponse>("restore-mirror-backup", [String(timestamp)], { superuser: "require" });
}

export async function deleteMirrorBackup(timestamp: number): Promise<RestoreMirrorBackupResponse> {
  return runBackend<RestoreMirrorBackupResponse>("delete-mirror-backup", [String(timestamp)], { superuser: "require" });
}

export async function fetchNews(days: number = 30, force = false): Promise<NewsResponse> {
  return runBackend<NewsResponse>("fetch-news", force ? [String(days), "true"] : [String(days)], { superuser: "none" });
}

export async function getNewsReadState(): Promise<NewsReadState> {
  return runBackend<NewsReadState>("news-read-state", [], { superuser: "none" });
}

export async function markNewsRead(link: string): Promise<void> {
  await runBackend<NewsReadState>("news-mark-read", [link], { superuser: "none" });
}

function makeDismissalApi(kind: string) {
  return {
    get: (): Promise<DismissalState> =>
      runBackend<DismissalState>("dismissal-state", [kind], { superuser: "none" }),
    mark: async (signature: string): Promise<void> => {
      await runBackend<DismissalState>("mark-dismissed", [kind, signature], { superuser: "none" });
    },
  };
}

export const servicesDismissal = makeDismissalApi("services");
export const rebootDismissal = makeDismissalApi("reboot");
export const pacnewDismissal = makeDismissalApi("pacnew");
export const scheduledDismissal = makeDismissalApi("scheduled");

export type ScheduledRunStatus = "ok" | "skipped" | "failed" | "unrecorded";

export type DependencyDirection = "forward" | "reverse" | "both";

export interface DependencyTreeParams {
  name: string;
  depth?: number;
  direction?: DependencyDirection;
  optionalDepth?: number;
}

export async function getDependencyTree(params: DependencyTreeParams): Promise<DependencyTreeResponse> {
  const { name, depth = 3, direction = "forward", optionalDepth = 0 } = params;
  return runBackend<DependencyTreeResponse>("dependency-tree", [
    sanitizeSearchInput(name),
    String(depth),
    direction,
    String(optionalDepth),
  ], { superuser: "none" });
}

// Signoff types

export interface KeyringCredentials {
  username: string;
  password: string;
}

function encodeCredentials(credentials: KeyringCredentials): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ username: credentials.username, password: credentials.password }));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

export async function getSignoffList(credentials: KeyringCredentials): Promise<SignoffListResponse> {
  return runBackend<SignoffListResponse>("signoff-list", [], { superuser: "none", stdin: encodeCredentials(credentials) });
}

export async function signoffPackage(
  pkgbase: string,
  repo: string,
  arch: string,
  credentials: KeyringCredentials,
): Promise<SignoffActionResponse> {
  return runBackend<SignoffActionResponse>("signoff-sign", [pkgbase, repo, arch], { superuser: "none", stdin: encodeCredentials(credentials) });
}

export const SIGNOFF_BATCH_LIMIT = 100;

export async function signoffPackages(targets: SignoffTarget[], credentials: KeyringCredentials): Promise<SignoffBatchResponse> {
  if (targets.length === 0 || targets.length > SIGNOFF_BATCH_LIMIT) {
    throw new BackendError(`Select between 1 and ${SIGNOFF_BATCH_LIMIT} packages`, "validation_error");
  }
  return runBackend<SignoffBatchResponse>("signoff-batch", [JSON.stringify(targets)], {
    superuser: "none",
    stdin: encodeCredentials(credentials),
    timeoutMs: (targets.length + 3) * 20_000,
  });
}

export async function revokeSignoff(
  pkgbase: string,
  repo: string,
  arch: string,
  credentials: KeyringCredentials,
): Promise<SignoffActionResponse> {
  return runBackend<SignoffActionResponse>("signoff-revoke", [pkgbase, repo, arch], { superuser: "none", stdin: encodeCredentials(credentials) });
}

export async function listRepos(): Promise<ListReposResponse> {
  return runBackend<ListReposResponse>("list-repos", [], { superuser: "none" });
}

export async function saveRepos(repos: RepoEntry[], revision: string): Promise<SaveReposResponse> {
  return runBackend<SaveReposResponse>("save-repos", [JSON.stringify(repos), revision], { superuser: "require" });
}

export async function listRepoBackups(): Promise<RepoBackupListResponse> {
  return runBackend<RepoBackupListResponse>("list-repo-backups", [], { superuser: "require" });
}

export async function restoreRepoBackup(timestamp: number): Promise<RestoreRepoBackupResponse> {
  return runBackend<RestoreRepoBackupResponse>("restore-repo-backup", [String(timestamp)], { superuser: "require" });
}

export async function deleteRepoBackup(timestamp: number): Promise<RestoreRepoBackupResponse> {
  return runBackend<RestoreRepoBackupResponse>("delete-repo-backup", [String(timestamp)], { superuser: "require" });
}

export type InstallReason = "explicit" | "dependency";

export interface InstallReasonResponse {
  success: boolean;
  name: string;
  reason: InstallReason;
  previous: InstallReason;
}

export async function setInstallReason(name: string, reason: InstallReason): Promise<InstallReasonResponse> {
  const result = await runBackend<InstallReasonResponse>("set-install-reason", [name, reason]);
  notifySystemChanged("system");
  return result;
}

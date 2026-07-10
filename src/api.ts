import { BACKEND_TIMEOUT_MS } from "./constants";
import { isDbLockError, sanitizeSearchInput } from "./utils";

// Wire types are generated from the Rust serde structs via ts-rs (see
// backend/src + src/bindings). Imported for local use and re-exported so
// consumers keep importing them from "../api".
import type {
  CacheInfo,
  CachePackage,
  CachedVersion,
  ConflictInfo,
  DependencyEdge,
  DependencyNode,
  DependencyTreeResponse,
  DismissalState,
  DowngradeResponse,
  GroupedLogResponse,
  IgnoreOperationResponse,
  IgnoredPackagesResponse,
  KeyringKey,
  KeyringStatusResponse,
  ListReposResponse,
  LockRemoveResult,
  LockStatus,
  LogEntry,
  LogGroup,
  LogResponse,
  MirrorBackup,
  MirrorBackupListResponse,
  MirrorEntry,
  MirrorListResponse,
  MirrorStatus,
  MirrorStatusResponse,
  MirrorTestResult,
  NewsItem,
  NewsReadState,
  NewsResponse,
  OrphanPackage,
  OrphanResponse,
  Package,
  PackageDetails,
  PackageListResponse,
  PackageSecurityAdvisory,
  PacnewFile,
  PacnewStatus,
  PreflightKeyInfo,
  PreflightResponse,
  PreflightWarning,
  ProviderChoice,
  RebootStatus,
  RefreshMirrorsResponse,
  ReplacementInfo,
  RepoBackup,
  RepoBackupListResponse,
  RepoDirectiveFull,
  RepoEntry,
  RestartBlocked,
  RestoreMirrorBackupResponse,
  RestoreRepoBackupResponse,
  SaveMirrorlistResponse,
  SaveReposResponse,
  ScheduleConfig,
  ScheduleMode,
  ScheduleSetResponse,
  ScheduledRunEntry,
  ScheduledRunsResponse,
  SearchResponse,
  SearchResult,
  SecurityInfoAdvisory,
  SecurityInfoGroup,
  SecurityInfoIssue,
  SecurityInfoResponse,
  SecurityResponse,
  ServiceRestart,
  ServicesStatus,
  Signoff,
  SignoffActionResponse,
  SignoffGroupWithLocal,
  SignoffListResponse,
  StreamEvent,
  SyncPackageDetails,
  UpdateInfo,
  UpdateStats,
  UpdatesResponse,
  VersionMatch,
  WarningSeverity,
} from "./bindings";
export type {
  CacheInfo,
  CachePackage,
  CachedVersion,
  ConflictInfo,
  DependencyEdge,
  DependencyNode,
  DependencyTreeResponse,
  DismissalState,
  DowngradeResponse,
  GroupedLogResponse,
  IgnoreOperationResponse,
  IgnoredPackagesResponse,
  KeyringKey,
  KeyringStatusResponse,
  ListReposResponse,
  LockRemoveResult,
  LockStatus,
  LogEntry,
  LogGroup,
  LogResponse,
  MirrorBackup,
  MirrorBackupListResponse,
  MirrorEntry,
  MirrorListResponse,
  MirrorStatus,
  MirrorStatusResponse,
  MirrorTestResult,
  NewsItem,
  NewsReadState,
  NewsResponse,
  OrphanPackage,
  OrphanResponse,
  Package,
  PackageDetails,
  PackageListResponse,
  PackageSecurityAdvisory,
  PacnewFile,
  PacnewStatus,
  PreflightKeyInfo,
  PreflightResponse,
  PreflightWarning,
  ProviderChoice,
  RebootStatus,
  RefreshMirrorsResponse,
  ReplacementInfo,
  RepoBackup,
  RepoBackupListResponse,
  RepoDirectiveFull,
  RepoEntry,
  RestartBlocked,
  RestoreMirrorBackupResponse,
  RestoreRepoBackupResponse,
  SaveMirrorlistResponse,
  SaveReposResponse,
  ScheduleConfig,
  ScheduleMode,
  ScheduleSetResponse,
  ScheduledRunEntry,
  ScheduledRunsResponse,
  SearchResponse,
  SearchResult,
  SecurityInfoAdvisory,
  SecurityInfoGroup,
  SecurityInfoIssue,
  SecurityInfoResponse,
  SecurityResponse,
  ServiceRestart,
  ServicesStatus,
  Signoff,
  SignoffActionResponse,
  SignoffGroupWithLocal,
  SignoffListResponse,
  StreamEvent,
  SyncPackageDetails,
  UpdateInfo,
  UpdateStats,
  UpdatesResponse,
  VersionMatch,
  WarningSeverity,
};

const BACKEND_PATH = "/usr/libexec/cockpit-pacman/cockpit-pacman-backend";

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
}

export type InstalledFilterType = "all" | "installed" | "not-installed";

export interface SearchParams {
  query: string;
  offset?: number;
  limit?: number;
  installed?: InstalledFilterType;
  sortBy?: string;
  sortDir?: SortDirection;
}

export type ErrorCode =
  | "timeout"
  | "database_locked"
  | "network_error"
  | "transaction_failed"
  | "validation_error"
  | "cancelled"
  | "not_found"
  | "permission_denied"
  | "internal_error";

export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "timeout",
  "database_locked",
  "network_error",
  "transaction_failed",
  "validation_error",
  "cancelled",
  "not_found",
  "permission_denied",
  "internal_error",
]);

// Any envelope-shaped payload is an error; an unrecognized code maps to
// internal_error so it surfaces instead of being read back as a success value.
function asErrorCode(code: string): ErrorCode {
  return KNOWN_ERROR_CODES.has(code) ? (code as ErrorCode) : "internal_error";
}

export function isNetworkErrorCode(code: ErrorCode): boolean {
  return code === "network_error" || code === "timeout";
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

async function runBackend<T>(command: string, args: string[] = [], options?: { superuser?: "try" | "require" | "none"; stdin?: string }): Promise<T> {
  const su = options?.superuser ?? "try";
  const spawnOpts: Record<string, unknown> = { err: "message" };
  if (su !== "none") {
    spawnOpts.superuser = su;
  }
  const spawnPromise = cockpit.spawn(
    [BACKEND_PATH, command, ...args],
    spawnOpts,
  );

  // Secrets go over stdin, never argv: /proc/<pid>/cmdline is world-readable.
  if (options?.stdin !== undefined) {
    spawnPromise.input(options.stdin);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  // Handle abort signal by closing the spawn process
  controller.signal.addEventListener("abort", () => {
    spawnPromise.close("timeout");
  });

  let output: string;
  try {
    output = await spawnPromise;
  } catch (ex) {
    if (controller.signal.aborted) {
      throw new BackendError(
        `Backend operation timed out after ${BACKEND_TIMEOUT_MS / 1000}s`,
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
  ]);
}

export async function checkUpdates(): Promise<UpdatesResponse> {
  return runBackend<UpdatesResponse>("check-updates");
}

export async function checkLock(): Promise<LockStatus> {
  return runBackend<LockStatus>("check-lock");
}

export async function removeStaleLock(): Promise<LockRemoveResult> {
  return runBackend<LockRemoveResult>("remove-stale-lock", [], { superuser: "require" });
}

export async function checkSecurity(): Promise<SecurityResponse> {
  return runBackend<SecurityResponse>("check-security", [], { superuser: "none" });
}

export async function getPackageInfo(name: string): Promise<PackageDetails> {
  return runBackend<PackageDetails>("local-package-info", [name]);
}

export async function searchPackages(params: SearchParams): Promise<SearchResponse> {
  const { query, offset = 0, limit = 100, installed = "all", sortBy = "", sortDir = "" } = params;
  return runBackend<SearchResponse>("search", [sanitizeSearchInput(query), String(offset), String(limit), installed, sortBy, sortDir]);
}

export async function getSyncPackageInfo(name: string, repo?: string): Promise<SyncPackageDetails> {
  const args = repo ? [name, repo] : [name];
  return runBackend<SyncPackageDetails>("sync-package-info", args);
}

export async function preflightUpgrade(ignore?: string[]): Promise<PreflightResponse> {
  const args = ignore && ignore.length > 0 ? [ignore.map(pkg => sanitizeSearchInput(pkg)).join(",")] : [];
  return runBackend<PreflightResponse>("preflight-upgrade", args);
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
  onError: (error: string, code?: ErrorCode) => void;
  /** Timeout in seconds for the operation (default: 300) */
  timeout?: number;
  /** Superuser mode for cockpit.spawn (default: "require") */
  superuser?: "try" | "require";
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
  /** Hard abort: close the channel. Same as cancel() unless gracefulCancel. */
  forceStop: () => void;
}

function runStreamingBackend(
  command: string,
  args: string[],
  callbacks: UpgradeCallbacks,
  options?: { gracefulCancel?: boolean }
): StreamingHandle {
  let buffer = "";
  let completionHandled = false;

  const markComplete = (success: boolean, message?: string, code?: ErrorCode) => {
    // Guard against duplicate callbacks from concurrent paths (stream, then, catch)
    // Set flag immediately before any other work to prevent re-entry
    if (completionHandled) return;
    completionHandled = true;

    // Execute callback outside the guard check to avoid issues if callback throws
    try {
      if (success) {
        callbacks.onComplete();
      } else {
        const msg = message || "Operation failed";
        callbacks.onError(msg, code ?? parseErrorCode(msg));
      }
    } catch (callbackError) {
      console.error("Callback error in markComplete:", callbackError);
    }
  };

  // A handler that returns Err (rather than emitting a complete event) makes
  // main.rs print a structured error envelope on stdout. It has a known code
  // and message but no StreamEvent `type`; treat it as a terminal error so the
  // backend's classification is not lost as an unknown event.
  const asErrorEnvelope = (parsed: Record<string, unknown>): { code: ErrorCode; message: string } | null => {
    if (
      !("type" in parsed) &&
      typeof parsed.message === "string" &&
      typeof parsed.code === "string"
    ) {
      return { code: asErrorCode(parsed.code), message: parsed.message };
    }
    return null;
  };

  const proc = cockpit.spawn(
    [BACKEND_PATH, command, ...args],
    { superuser: callbacks.superuser || "require", err: "out" }
  );

  proc.stream((data) => {
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
          markComplete(false, envelope.message, envelope.code);
          continue;
        }

        const event = parsed as unknown as StreamEvent;
        callbacks.onEvent?.(event);

        if (event.type === "log") {
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
          markComplete(event.success, event.message);
        } else {
          console.warn("Unknown StreamEvent type:", (event as { type: string }).type);
        }
      } catch {
        callbacks.onData?.(line + "\n");
      }
    }
  });

  proc.then(() => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer) as Record<string, unknown>;
        const envelope = asErrorEnvelope(parsed);
        if (envelope) {
          markComplete(false, envelope.message, envelope.code);
          return;
        }
        const event = parsed as unknown as StreamEvent;
        if (event.type === "complete") {
          markComplete(event.success, event.message);
          return;
        }
      } catch {
        // Not valid JSON - fall through to error handling
      }
    }
    // If no complete event was received, this is an error condition
    // The backend should always emit a complete event
    if (!completionHandled) {
      markComplete(false, "Backend process ended without sending completion status");
    }
  });

  proc.catch((ex: unknown) => {
    markComplete(false, extractErrorMessage(ex));
  });

  const forceStop = () => proc.close("cancelled");
  return {
    cancel: options?.gracefulCancel ? () => proc.input("cancel\n", true) : forceStop,
    forceStop,
  };
}

export function runUpgrade(callbacks: UpgradeCallbacks, ignore?: string[]): StreamingHandle {
  const args: string[] = [];
  args.push(ignore && ignore.length > 0 ? ignore.map(pkg => sanitizeSearchInput(pkg)).join(",") : "");
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }
  return runStreamingBackend("upgrade", args, callbacks, { gracefulCancel: true });
}

export function syncDatabase(callbacks: UpgradeCallbacks): StreamingHandle {
  const args = ["true"];
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }
  return runStreamingBackend("sync-database", args, callbacks);
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
  return runStreamingBackend("refresh-keyring", [], callbacks);
}

export function initKeyring(callbacks: UpgradeCallbacks): StreamingHandle {
  return runStreamingBackend("init-keyring", [], callbacks);
}

export async function listOrphans(): Promise<OrphanResponse> {
  return runBackend<OrphanResponse>("list-orphans");
}

export function installPackage(
  callbacks: UpgradeCallbacks,
  name: string
): StreamingHandle {
  const args = [sanitizeSearchInput(name)];
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }
  return runStreamingBackend("install-package", args, callbacks);
}

export function removePackage(
  callbacks: UpgradeCallbacks,
  name: string
): StreamingHandle {
  const args = [sanitizeSearchInput(name)];
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }
  return runStreamingBackend("remove-package", args, callbacks);
}

export function removeOrphans(callbacks: UpgradeCallbacks): StreamingHandle {
  const args: string[] = [];
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }
  return runStreamingBackend("remove-orphans", args, callbacks);
}

export async function listIgnoredPackages(): Promise<IgnoredPackagesResponse> {
  return runBackend<IgnoredPackagesResponse>("list-ignored");
}

export async function addIgnoredPackage(name: string): Promise<IgnoreOperationResponse> {
  return runBackend<IgnoreOperationResponse>("add-ignored", [name]);
}

export async function removeIgnoredPackage(name: string): Promise<IgnoreOperationResponse> {
  return runBackend<IgnoreOperationResponse>("remove-ignored", [name]);
}

export async function getCacheInfo(): Promise<CacheInfo> {
  return runBackend<CacheInfo>("cache-info");
}

export function cleanCache(callbacks: UpgradeCallbacks, keepVersions: number = 3, packages?: string[]): StreamingHandle {
  const pkgArg = packages && packages.length > 0 ? packages.map(pkg => sanitizeSearchInput(pkg)).join(",") : "";
  return runStreamingBackend("clean-cache", [String(keepVersions), pkgArg], callbacks);
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
  ]);
}

export async function getHistory(params: HistoryParams = {}): Promise<LogResponse> {
  const { offset = 0, limit = 20, filter = "all", search = "" } = params;
  return runBackend<LogResponse>("history", [String(offset), String(limit), filter, search]);
}

export async function listDowngrades(packageName?: string): Promise<DowngradeResponse> {
  const args = packageName ? [sanitizeSearchInput(packageName)] : [];
  return runBackend<DowngradeResponse>("list-downgrades", args);
}

export function downgradePackage(
  callbacks: UpgradeCallbacks,
  name: string,
  version: string
): StreamingHandle {
  return runStreamingBackend("downgrade", [sanitizeSearchInput(name), sanitizeSearchInput(version)], callbacks);
}

export async function listArchiveVersions(packageName: string, query?: string): Promise<DowngradeResponse> {
  const args = [sanitizeSearchInput(packageName)];
  if (query && query.trim()) {
    args.push(sanitizeSearchInput(query));
  }
  return runBackend<DowngradeResponse>("list-archive-versions", args);
}

export function downgradeFromArchive(
  callbacks: UpgradeCallbacks,
  name: string,
  filename: string
): StreamingHandle {
  return runStreamingBackend("downgrade-archive", [sanitizeSearchInput(name), filename], callbacks);
}

export interface ScheduledRunsParams {
  offset?: number;
  limit?: number;
}

export async function getScheduleConfig(): Promise<ScheduleConfig> {
  return runBackend<ScheduleConfig>("get-schedule");
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
  return runBackend<ScheduledRunsResponse>("list-scheduled-runs", [String(offset), String(limit)]);
}

export type RebootReason = "kernel_update" | "critical_packages" | "none";

export async function getRebootStatus(): Promise<RebootStatus> {
  return runBackend<RebootStatus>("reboot-status");
}

export type PacnewKind = "pacnew" | "pacsave";

export async function getPacnewStatus(): Promise<PacnewStatus> {
  return runBackend<PacnewStatus>("pacnew-status", [], { superuser: "none" });
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
  onError: (error: string, code?: ErrorCode) => void;
  timeout?: number;
}

export async function listMirrors(): Promise<MirrorListResponse> {
  return runBackend<MirrorListResponse>("list-mirrors");
}

export async function fetchMirrorStatus(): Promise<MirrorStatusResponse> {
  return runBackend<MirrorStatusResponse>("fetch-mirror-status");
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
    superuser: "try",
    onRawEvent: (event) => {
      if (event.type === "mirror_test") {
        const e = event as unknown as Extract<StreamEvent, { type: "mirror_test" }>;
        callbacks.onTestResult?.(e.result, e.current, e.total);
        callbacks.onData?.(`[${e.current}/${e.total}] ${e.url}: ${e.result.success ? `${e.result.latency_ms}ms` : e.result.error}\n`);
        return true;
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
  ]);
}

export async function listMirrorBackups(): Promise<MirrorBackupListResponse> {
  return runBackend<MirrorBackupListResponse>("list-mirror-backups");
}

export async function restoreMirrorBackup(timestamp: number): Promise<RestoreMirrorBackupResponse> {
  return runBackend<RestoreMirrorBackupResponse>("restore-mirror-backup", [String(timestamp)], { superuser: "require" });
}

export async function deleteMirrorBackup(timestamp: number): Promise<RestoreMirrorBackupResponse> {
  return runBackend<RestoreMirrorBackupResponse>("delete-mirror-backup", [String(timestamp)], { superuser: "require" });
}

export async function fetchNews(days: number = 30): Promise<NewsResponse> {
  return runBackend<NewsResponse>("fetch-news", [String(days)]);
}

export async function getNewsReadState(): Promise<NewsReadState> {
  return runBackend<NewsReadState>("news-read-state", [], { superuser: "none" });
}

export async function markNewsRead(link: string): Promise<void> {
  await runBackend<NewsReadState>("news-mark-read", [link], { superuser: "none" });
}

function makeDismissalApi(prefix: string) {
  return {
    get: (): Promise<DismissalState> =>
      runBackend<DismissalState>(`${prefix}-dismissal-state`, [], { superuser: "none" }),
    mark: async (signature: string): Promise<void> => {
      await runBackend<DismissalState>(`${prefix}-mark-dismissed`, [signature], { superuser: "none" });
    },
  };
}

export const servicesDismissal = makeDismissalApi("services");
export const rebootDismissal = makeDismissalApi("reboot");
export const pacnewDismissal = makeDismissalApi("pacnew");
export const scheduledDismissal = makeDismissalApi("scheduled");

export type ScheduledRunStatus = "ok" | "skipped" | "failed";

export type DependencyDirection = "forward" | "reverse" | "both";

export interface DependencyTreeParams {
  name: string;
  depth?: number;
  direction?: DependencyDirection;
}

export async function getDependencyTree(params: DependencyTreeParams): Promise<DependencyTreeResponse> {
  const { name, depth = 3, direction = "forward" } = params;
  return runBackend<DependencyTreeResponse>("dependency-tree", [
    sanitizeSearchInput(name),
    String(depth),
    direction,
  ]);
}

// Signoff types

export interface KeyringCredentials {
  username: string;
  password: string;
}

function encodeCredentials(credentials: KeyringCredentials): string {
  return btoa(JSON.stringify({ username: credentials.username, password: credentials.password }));
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

export async function revokeSignoff(
  pkgbase: string,
  repo: string,
  arch: string,
  credentials: KeyringCredentials,
): Promise<SignoffActionResponse> {
  return runBackend<SignoffActionResponse>("signoff-revoke", [pkgbase, repo, arch], { superuser: "none", stdin: encodeCredentials(credentials) });
}

export async function listRepos(): Promise<ListReposResponse> {
  return runBackend<ListReposResponse>("list-repos", [], { superuser: "require" });
}

export async function saveRepos(repos: RepoEntry[]): Promise<SaveReposResponse> {
  return runBackend<SaveReposResponse>("save-repos", [JSON.stringify(repos)], { superuser: "require" });
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

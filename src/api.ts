import { BACKEND_TIMEOUT_MS } from "./constants";
import { sanitizeSearchInput } from "./utils";

declare const cockpit: {
  spawn(args: string[], options?: {
    superuser?: "try" | "require";
    err?: "out" | "message";
  }): Promise<string> & {
    stream(callback: (data: string) => void): void;
    close(problem?: string): void;
  };
};

const BACKEND_PATH = "/usr/libexec/cockpit-pacman/cockpit-pacman-backend";

export interface Package {
  name: string;
  version: string;
  description: string | null;
  installed_size: number;
  install_date: number | null;
  reason: "explicit" | "dependency";
  repository: string | null;
}

export interface PackageListResponse {
  packages: Package[];
  total: number;
  total_explicit: number;
  total_dependency: number;
  repositories: string[];
  warnings: string[];
}

export interface UpdatesResponse {
  updates: UpdateInfo[];
  warnings: string[];
}

export type FilterType = "all" | "explicit" | "dependency";

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

export interface UpdateInfo {
  name: string;
  current_version: string;
  new_version: string;
  download_size: number;
  current_size: number;
  new_size: number;
  repository: string;
}

export interface PackageDetails {
  name: string;
  version: string;
  description: string | null;
  url: string | null;
  licenses: string[];
  groups: string[];
  provides: string[];
  depends: string[];
  optdepends: string[];
  conflicts: string[];
  replaces: string[];
  installed_size: number;
  packager: string | null;
  architecture: string | null;
  build_date: number | null;
  install_date: number | null;
  reason: string;
  validation: string[];
  repository: string | null;
}

export interface SearchResult {
  name: string;
  version: string;
  description: string | null;
  repository: string;
  installed: boolean;
  installed_version: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  total_installed: number;
  total_not_installed: number;
  repositories: string[];
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

export interface SyncPackageDetails {
  name: string;
  version: string;
  description: string | null;
  url: string | null;
  licenses: string[];
  groups: string[];
  provides: string[];
  depends: string[];
  optdepends: string[];
  conflicts: string[];
  replaces: string[];
  download_size: number;
  installed_size: number;
  packager: string | null;
  architecture: string | null;
  build_date: number | null;
  repository: string;
}

// Preflight upgrade types
export interface ConflictInfo {
  package1: string;
  package2: string;
}

export interface ReplacementInfo {
  old_package: string;
  new_package: string;
}

export interface ProviderChoice {
  dependency: string;
  providers: string[];
}

export interface PreflightKeyInfo {
  fingerprint: string;
  uid: string;
}

export interface PreflightResponse {
  success: boolean;
  error?: string;
  conflicts?: ConflictInfo[];
  replacements?: ReplacementInfo[];
  removals?: string[];
  providers?: ProviderChoice[];
  import_keys?: PreflightKeyInfo[];
  packages_to_upgrade: number;
  total_download_size: number;
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

  static isTimeout(err: unknown): boolean {
    return err instanceof BackendError && err.code === "timeout";
  }

  static isDatabaseLocked(err: unknown): boolean {
    if (err instanceof BackendError) {
      return err.code === "database_locked";
    }
    if (err instanceof Error) {
      return err.message.toLowerCase().includes("unable to lock database");
    }
    return false;
  }

  static isNetworkError(err: unknown): boolean {
    return err instanceof BackendError && err.code === "network_error";
  }

  static isCancelled(err: unknown): boolean {
    return err instanceof BackendError && err.code === "cancelled";
  }
}

function parseErrorCode(message: string): ErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }
  if (lower.includes("unable to lock database") || lower.includes("database is locked")) {
    return "database_locked";
  }
  if (lower.includes("connection") || lower.includes("network") || lower.includes("resolve host")) {
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

async function runBackend<T>(command: string, args: string[] = []): Promise<T> {
  const spawnPromise = cockpit.spawn(
    [BACKEND_PATH, command, ...args],
    { superuser: "try", err: "message" }
  );

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      spawnPromise.close("timeout");
      reject(new BackendError(
        `Backend operation timed out after ${BACKEND_TIMEOUT_MS / 1000}s`,
        "timeout"
      ));
    }, BACKEND_TIMEOUT_MS);
  });

  let output: string;
  try {
    output = await Promise.race([spawnPromise, timeoutPromise]);
    settled = true;
  } catch (ex) {
    settled = true;
    if (ex instanceof BackendError) {
      throw ex;
    }
    const message = ex instanceof Error ? ex.message : String(ex);
    const code = parseErrorCode(message);
    throw new BackendError(`Backend command '${command}' failed: ${message}`, code);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }

  if (!output || output.trim() === "") {
    throw new BackendError(
      `Backend returned empty response for command: ${command}`,
      "internal_error"
    );
  }

  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object" && "code" in parsed && "message" in parsed) {
      throw BackendError.fromStructured(parsed as StructuredError);
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

// Stream event types from backend
export interface StreamEventLog {
  type: "log";
  level: string;
  message: string;
}

export interface StreamEventProgress {
  type: "progress";
  operation: string;
  package: string;
  percent: number;
  current: number;
  total: number;
}

export interface StreamEventDownload {
  type: "download";
  filename: string;
  event: string;
  downloaded?: number;
  total?: number;
}

export interface StreamEventEvent {
  type: "event";
  event: string;
  package?: string;
}

export interface StreamEventComplete {
  type: "complete";
  success: boolean;
  message?: string;
}

export type StreamEvent =
  | StreamEventLog
  | StreamEventProgress
  | StreamEventDownload
  | StreamEventEvent
  | StreamEventComplete;

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
  /** Called when the operation fails with an error message */
  onError: (error: string) => void;
  /** Timeout in seconds for the operation (default: 300) */
  timeout?: number;
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

function runStreamingBackend(
  command: string,
  args: string[],
  callbacks: UpgradeCallbacks
): { cancel: () => void } {
  let buffer = "";
  let completionHandled = false;

  const markComplete = (success: boolean, message?: string) => {
    // Guard against duplicate callbacks from concurrent paths (stream, then, catch)
    // Set flag immediately before any other work to prevent re-entry
    if (completionHandled) return;
    completionHandled = true;

    // Execute callback outside the guard check to avoid issues if callback throws
    try {
      if (success) {
        callbacks.onComplete();
      } else {
        callbacks.onError(message || "Operation failed");
      }
    } catch (callbackError) {
      console.error("Callback error in markComplete:", callbackError);
    }
  };

  const proc = cockpit.spawn(
    [BACKEND_PATH, command, ...args],
    { superuser: "require", err: "out" }
  );

  proc.stream((data) => {
    buffer += data;
    // Process complete JSON lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as StreamEvent;
        callbacks.onEvent?.(event);

        // Also provide raw data callback for backward compatibility
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
        }
      } catch {
        // Not valid JSON, treat as raw output
        callbacks.onData?.(line + "\n");
      }
    }
  });

  proc.then(() => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer) as StreamEvent;
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

  return {
    cancel: () => proc.close("cancelled"),
  };
}

export function runUpgrade(callbacks: UpgradeCallbacks, ignore?: string[]): { cancel: () => void } {
  const args: string[] = [];
  args.push(ignore && ignore.length > 0 ? ignore.map(pkg => sanitizeSearchInput(pkg)).join(",") : "");
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }
  return runStreamingBackend("upgrade", args, callbacks);
}

export function syncDatabase(callbacks: UpgradeCallbacks): { cancel: () => void } {
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

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatDate(timestamp: number | null): string {
  if (timestamp === null || timestamp === undefined) return "Unknown";
  return new Date(timestamp * 1000).toLocaleString();
}

// Keyring types
export interface KeyringKey {
  fingerprint: string;
  uid: string;
  created: string | null;
  expires: string | null;
  trust: string;
}

export interface KeyringStatusResponse {
  keys: KeyringKey[];
  total: number;
  master_key_initialized: boolean;
  warnings: string[];
}

export async function getKeyringStatus(): Promise<KeyringStatusResponse> {
  return runBackend<KeyringStatusResponse>("keyring-status");
}

export function refreshKeyring(callbacks: UpgradeCallbacks): { cancel: () => void } {
  return runStreamingBackend("refresh-keyring", [], callbacks);
}

export function initKeyring(callbacks: UpgradeCallbacks): { cancel: () => void } {
  return runStreamingBackend("init-keyring", [], callbacks);
}

// Orphan package types
export interface OrphanPackage {
  name: string;
  version: string;
  description: string | null;
  installed_size: number;
  install_date: number | null;
  repository: string | null;
}

export interface OrphanResponse {
  orphans: OrphanPackage[];
  total_size: number;
}

export async function listOrphans(): Promise<OrphanResponse> {
  return runBackend<OrphanResponse>("list-orphans");
}

export function removeOrphans(callbacks: UpgradeCallbacks): { cancel: () => void } {
  const args: string[] = [];
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }
  return runStreamingBackend("remove-orphans", args, callbacks);
}

export interface IgnoredPackagesResponse {
  packages: string[];
  total: number;
}

export interface IgnoreOperationResponse {
  success: boolean;
  package: string;
  message: string;
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

export interface CachePackage {
  name: string;
  version: string;
  filename: string;
  size: number;
}

export interface CacheInfo {
  total_size: number;
  package_count: number;
  packages: CachePackage[];
  path: string;
}

export async function getCacheInfo(): Promise<CacheInfo> {
  return runBackend<CacheInfo>("cache-info");
}

export function cleanCache(callbacks: UpgradeCallbacks, keepVersions: number = 3): { cancel: () => void } {
  return runStreamingBackend("clean-cache", [String(keepVersions)], callbacks);
}

export interface LogEntry {
  timestamp: string;
  action: string;
  package: string;
  old_version: string | null;
  new_version: string | null;
}

export interface LogResponse {
  entries: LogEntry[];
  total: number;
  total_upgraded: number;
  total_installed: number;
  total_removed: number;
  total_other: number;
}

export type HistoryFilterType = "all" | "upgraded" | "installed" | "removed";

export interface HistoryParams {
  offset?: number;
  limit?: number;
  filter?: HistoryFilterType;
}

export async function getHistory(params: HistoryParams = {}): Promise<LogResponse> {
  const { offset = 0, limit = 100, filter = "all" } = params;
  return runBackend<LogResponse>("history", [String(offset), String(limit), filter]);
}

export interface LogGroup {
  id: string;
  start_time: string;
  end_time: string;
  entries: LogEntry[];
  upgraded_count: number;
  installed_count: number;
  removed_count: number;
  downgraded_count: number;
  reinstalled_count: number;
}

export interface GroupedLogResponse {
  groups: LogGroup[];
  total_groups: number;
  total_upgraded: number;
  total_installed: number;
  total_removed: number;
  total_other: number;
}

export async function getGroupedHistory(params: HistoryParams = {}): Promise<GroupedLogResponse> {
  const { offset = 0, limit = 20, filter = "all" } = params;
  return runBackend<GroupedLogResponse>("history-grouped", [
    String(offset),
    String(limit),
    filter,
  ]);
}

export interface CachedVersion {
  name: string;
  version: string;
  filename: string;
  size: number;
  installed_version: string | null;
  is_older: boolean;
}

export interface DowngradeResponse {
  packages: CachedVersion[];
  total: number;
}

export async function listDowngrades(packageName?: string): Promise<DowngradeResponse> {
  const args = packageName ? [sanitizeSearchInput(packageName)] : [];
  return runBackend<DowngradeResponse>("list-downgrades", args);
}

export function downgradePackage(
  callbacks: UpgradeCallbacks,
  name: string,
  version: string
): { cancel: () => void } {
  return runStreamingBackend("downgrade", [sanitizeSearchInput(name), sanitizeSearchInput(version)], callbacks);
}

export type ScheduleMode = "check" | "upgrade";

export interface ScheduleConfig {
  enabled: boolean;
  mode: ScheduleMode;
  schedule: string;
  max_packages: number;
  timer_active: boolean;
  timer_next_run: string | null;
}

export interface ScheduleSetResponse {
  success: boolean;
  message: string;
}

export interface ScheduledRunEntry {
  timestamp: string;
  mode: string;
  success: boolean;
  packages_checked: number;
  packages_upgraded: number;
  error: string | null;
  details: string[];
}

export interface ScheduledRunsResponse {
  runs: ScheduledRunEntry[];
  total: number;
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

export interface RebootStatus {
  requires_reboot: boolean;
  reason: RebootReason;
  running_kernel: string | null;
  installed_kernel: string | null;
  kernel_package: string | null;
  updated_packages: string[];
}

export async function getRebootStatus(): Promise<RebootStatus> {
  return runBackend<RebootStatus>("reboot-status");
}

export interface MirrorEntry {
  url: string;
  enabled: boolean;
  comment: string | null;
}

export interface MirrorListResponse {
  mirrors: MirrorEntry[];
  total: number;
  enabled_count: number;
  path: string;
  last_modified: number | null;
}

export interface MirrorStatus {
  url: string;
  country: string | null;
  country_code: string | null;
  last_sync: string | null;
  delay: number | null;
  score: number | null;
  completion_pct: number | null;
  active: boolean;
  ipv4: boolean;
  ipv6: boolean;
}

export interface MirrorStatusResponse {
  mirrors: MirrorStatus[];
  total: number;
  last_check: string | null;
}

export interface MirrorTestResult {
  url: string;
  success: boolean;
  speed_bps: number | null;
  latency_ms: number | null;
  error: string | null;
}

export interface SaveMirrorlistResponse {
  success: boolean;
  backup_path: string | null;
  message: string;
}

export interface StreamEventMirrorTest {
  type: "mirror_test";
  url: string;
  current: number;
  total: number;
  result: MirrorTestResult;
}

export type MirrorStreamEvent = StreamEvent | StreamEventMirrorTest;

export interface MirrorTestCallbacks {
  onTestResult?: (result: MirrorTestResult, current: number, total: number) => void;
  onData?: (data: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
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
): { cancel: () => void } {
  let buffer = "";
  let completionHandled = false;

  const markComplete = (success: boolean, message?: string) => {
    if (completionHandled) return;
    completionHandled = true;
    try {
      if (success) {
        callbacks.onComplete();
      } else {
        callbacks.onError(message || "Mirror testing failed");
      }
    } catch (callbackError) {
      console.error("Callback error in markComplete:", callbackError);
    }
  };

  const args: string[] = [];
  if (urls && urls.length > 0) {
    args.push(urls.join(","));
  }
  if (callbacks.timeout !== undefined) {
    args.push(String(callbacks.timeout));
  }

  const proc = cockpit.spawn(
    [BACKEND_PATH, "test-mirrors", ...args],
    { superuser: "try", err: "out" }
  );

  proc.stream((data) => {
    buffer += data;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as MirrorStreamEvent;

        if (event.type === "mirror_test") {
          callbacks.onTestResult?.(event.result, event.current, event.total);
          callbacks.onData?.(`[${event.current}/${event.total}] ${event.url}: ${event.result.success ? `${event.result.latency_ms}ms` : event.result.error}\n`);
        } else if (event.type === "complete") {
          markComplete(event.success, event.message);
        } else if (event.type === "log") {
          callbacks.onData?.(`[${event.level}] ${event.message}\n`);
        }
      } catch {
        callbacks.onData?.(line + "\n");
      }
    }
  });

  proc.then(() => {
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer) as MirrorStreamEvent;
        if (event.type === "complete") {
          markComplete(event.success, event.message);
          return;
        }
      } catch {
        // Not valid JSON
      }
    }
    if (!completionHandled) {
      markComplete(false, "Backend process ended without sending completion status");
    }
  });

  proc.catch((ex: unknown) => {
    markComplete(false, extractErrorMessage(ex));
  });

  return {
    cancel: () => proc.close("cancelled"),
  };
}

export async function saveMirrorlist(mirrors: MirrorEntry[]): Promise<SaveMirrorlistResponse> {
  return runBackend<SaveMirrorlistResponse>("save-mirrorlist", [JSON.stringify(mirrors)]);
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MiB/s`;
}

import { BACKEND_TIMEOUT_MS } from "./constants";

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
    search,
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
  return runBackend<SearchResponse>("search", [query, String(offset), String(limit), installed, sortBy, sortDir]);
}

export async function getSyncPackageInfo(name: string, repo?: string): Promise<SyncPackageDetails> {
  const args = repo ? [name, repo] : [name];
  return runBackend<SyncPackageDetails>("sync-package-info", args);
}

export async function preflightUpgrade(ignore?: string[]): Promise<PreflightResponse> {
  const args = ignore && ignore.length > 0 ? [ignore.join(",")] : [];
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

export interface UpgradeCallbacks {
  onEvent?: (event: StreamEvent) => void;
  onData?: (data: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  timeout?: number;
}

function runStreamingBackend(
  command: string,
  args: string[],
  callbacks: UpgradeCallbacks
): { cancel: () => void } {
  let buffer = "";
  let receivedComplete = false;

  const markComplete = (success: boolean, message?: string) => {
    if (receivedComplete) return; // Prevent duplicate callbacks
    receivedComplete = true;
    if (success) {
      callbacks.onComplete();
    } else {
      callbacks.onError(message || "Operation failed");
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
    if (!receivedComplete) {
      markComplete(false, "Backend process ended without sending completion status");
    }
  });

  proc.catch((ex: unknown) => {
    const errObj = ex as { message?: string; exit_status?: number };
    const message = errObj.message || `Operation failed (exit ${errObj.exit_status ?? "unknown"})`;
    markComplete(false, message);
  });

  return {
    cancel: () => proc.close("cancelled"),
  };
}

export function runUpgrade(callbacks: UpgradeCallbacks, ignore?: string[]): { cancel: () => void } {
  const args: string[] = [];
  args.push(ignore && ignore.length > 0 ? ignore.join(",") : "");
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

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "Unknown";
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
  source: string;
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
  const args = packageName ? [packageName] : [];
  return runBackend<DowngradeResponse>("list-downgrades", args);
}

export function downgradePackage(
  callbacks: UpgradeCallbacks,
  name: string,
  version: string
): { cancel: () => void } {
  return runStreamingBackend("downgrade", [name, version], callbacks);
}

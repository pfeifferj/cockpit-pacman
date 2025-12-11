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

export interface ListInstalledParams {
  offset?: number;
  limit?: number;
  search?: string;
  filter?: FilterType;
  repo?: string;
}

export interface UpdateInfo {
  name: string;
  current_version: string;
  new_version: string;
  download_size: number;
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
  conflicts: ConflictInfo[];
  replacements: ReplacementInfo[];
  removals: string[];
  providers: ProviderChoice[];
  import_keys: PreflightKeyInfo[];
  packages_to_upgrade: number;
  total_download_size: number;
}

const BACKEND_TIMEOUT_MS = 30000;

class BackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendError";
  }
}

async function runBackend<T>(command: string, args: string[] = []): Promise<T> {
  const spawnPromise = cockpit.spawn(
    [BACKEND_PATH, command, ...args],
    { superuser: "try", err: "message" }
  );

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      spawnPromise.close("timeout");
      reject(new BackendError(`Backend operation timed out after ${BACKEND_TIMEOUT_MS / 1000}s`));
    }, BACKEND_TIMEOUT_MS);
  });

  let output: string;
  try {
    output = await Promise.race([spawnPromise, timeoutPromise]);
  } catch (ex) {
    if (ex instanceof BackendError) {
      throw ex;
    }
    const message = ex instanceof Error ? ex.message : String(ex);
    throw new BackendError(`Backend command '${command}' failed: ${message}`);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }

  if (!output || output.trim() === "") {
    throw new BackendError(`Backend returned empty response for command: ${command}`);
  }

  try {
    return JSON.parse(output) as T;
  } catch (ex) {
    throw new BackendError(
      `Backend returned invalid JSON for ${command}: ${ex instanceof Error ? ex.message : String(ex)}`
    );
  }
}

export async function listInstalled(
  params: ListInstalledParams = {}
): Promise<PackageListResponse> {
  const { offset = 0, limit = 50, search = "", filter = "all", repo = "all" } = params;
  return runBackend<PackageListResponse>("list-installed", [
    String(offset),
    String(limit),
    search,
    filter,
    repo,
  ]);
}

export async function checkUpdates(): Promise<UpdatesResponse> {
  return runBackend<UpdatesResponse>("check-updates");
}

export async function getPackageInfo(name: string): Promise<PackageDetails> {
  return runBackend<PackageDetails>("local-package-info", [name]);
}

export async function searchPackages(params: SearchParams): Promise<SearchResponse> {
  const { query, offset = 0, limit = 100, installed = "all" } = params;
  return runBackend<SearchResponse>("search", [query, String(offset), String(limit), installed]);
}

export async function getSyncPackageInfo(name: string, repo?: string): Promise<SyncPackageDetails> {
  const args = repo ? [name, repo] : [name];
  return runBackend<SyncPackageDetails>("sync-package-info", args);
}

export async function preflightUpgrade(): Promise<PreflightResponse> {
  return runBackend<PreflightResponse>("preflight-upgrade");
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

export function runUpgrade(callbacks: UpgradeCallbacks): { cancel: () => void } {
  return runStreamingBackend("upgrade", [], callbacks);
}

export function syncDatabase(callbacks: UpgradeCallbacks): { cancel: () => void } {
  return runStreamingBackend("sync-database", ["true"], callbacks);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "Unknown";
  return new Date(timestamp * 1000).toLocaleString();
}

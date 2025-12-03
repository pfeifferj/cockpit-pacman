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

export interface UpgradeCallbacks {
  onData: (data: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

export function runUpgrade(callbacks: UpgradeCallbacks): { cancel: () => void } {
  let output = "";
  const proc = cockpit.spawn(
    ["pacman", "-Syu", "--noconfirm"],
    { superuser: "require", err: "out" }
  );

  proc.stream((data) => {
    output += data;
    callbacks.onData(data);
  });
  proc.then(() => callbacks.onComplete());
  proc.catch((ex: unknown) => {
    const errObj = ex as { message?: string; exit_status?: number };
    const message = errObj.message || output.trim() || `pacman -Syu failed (exit ${errObj.exit_status ?? "unknown"})`;
    callbacks.onError(message);
  });

  return {
    cancel: () => proc.close("cancelled"),
  };
}

export function syncDatabase(callbacks: UpgradeCallbacks): { cancel: () => void } {
  let output = "";
  const proc = cockpit.spawn(
    ["pacman", "-Sy"],
    { superuser: "require", err: "out" }
  );

  proc.stream((data) => {
    output += data;
    callbacks.onData(data);
  });
  proc.then(() => callbacks.onComplete());
  proc.catch((ex: unknown) => {
    const errObj = ex as { message?: string; exit_status?: number };
    const message = errObj.message || output.trim() || `pacman -Sy failed (exit ${errObj.exit_status ?? "unknown"})`;
    callbacks.onError(message);
  });

  return {
    cancel: () => proc.close("cancelled"),
  };
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

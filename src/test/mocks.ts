import type {
  PackageListResponse,
  UpdatesResponse,
  PackageDetails,
  SearchResult,
  PreflightResponse,
  SyncPackageDetails,
  RebootStatus,
  GroupedLogResponse,
  LogGroup,
} from "../api";

export const mockPackageListResponse: PackageListResponse = {
  packages: [
    {
      name: "linux",
      version: "6.7.0-arch1-1",
      description: "The Linux kernel and modules",
      installed_size: 142000000,
      install_date: 1704067200,
      reason: "explicit",
      repository: "core",
    },
    {
      name: "glibc",
      version: "2.39-1",
      description: "GNU C Library",
      installed_size: 45000000,
      install_date: 1704067200,
      reason: "dependency",
      repository: "core",
    },
  ],
  total: 2,
  total_explicit: 1,
  total_dependency: 1,
  repositories: ["core", "extra", "multilib"],
  warnings: [],
};

export const mockUpdatesResponse: UpdatesResponse = {
  updates: [
    {
      name: "linux",
      current_version: "6.7.0-arch1-1",
      new_version: "6.7.1-arch1-1",
      download_size: 150000000,
      current_size: 142000000,
      new_size: 145000000,
      repository: "core",
    },
  ],
  warnings: [],
};

export const mockPackageDetails: PackageDetails = {
  name: "linux",
  version: "6.7.0-arch1-1",
  description: "The Linux kernel and modules",
  url: "https://kernel.org/",
  licenses: ["GPL-2.0-only"],
  groups: [],
  provides: ["VIRTUALBOX-GUEST-MODULES", "WIREGUARD-MODULE"],
  depends: ["coreutils", "initramfs", "kmod"],
  optdepends: ["wireless-regdb: to set the correct wireless channels"],
  conflicts: [],
  replaces: [],
  installed_size: 142000000,
  packager: "Jan Alexander Steffens (heftig) <heftig@archlinux.org>",
  architecture: "x86_64",
  build_date: 1704067200,
  install_date: 1704067200,
  reason: "explicit",
  validation: ["pgp"],
  repository: "core",
};

export const mockSearchResults: SearchResult[] = [
  {
    name: "linux",
    version: "6.7.1-arch1-1",
    description: "The Linux kernel and modules",
    repository: "core",
    installed: true,
    installed_version: "6.7.0-arch1-1",
  },
  {
    name: "linux-lts",
    version: "6.6.10-1",
    description: "The LTS Linux kernel and modules",
    repository: "core",
    installed: false,
    installed_version: null,
  },
];

export const mockSearchResponse = {
  results: mockSearchResults,
  total: 2,
  repositories: ["core"],
};

export function createMockSpawnPromise(
  result: string,
  shouldFail = false,
  error?: Error
): Promise<string> & { stream: () => void; close: () => void } {
  const promise = (
    shouldFail
      ? Promise.reject(error ?? new Error("spawn failed"))
      : Promise.resolve(result)
  ) as Promise<string> & { stream: () => void; close: () => void };

  promise.stream = () => {};
  promise.close = () => {};

  return promise;
}

interface StreamingMockProcess {
  stream: (callback: (data: string) => void) => StreamingMockProcess;
  then: (callback: () => void) => StreamingMockProcess;
  catch: (callback: (error: unknown) => void) => StreamingMockProcess;
  close: (reason?: string) => void;
  _streamCallback?: (data: string) => void;
  _thenCallback?: () => void;
  _catchCallback?: (error: unknown) => void;
  _emit: (data: string) => void;
  _complete: () => void;
  _fail: (error: unknown) => void;
}

export function createMockStreamingProcess(): StreamingMockProcess {
  const proc: StreamingMockProcess = {
    _streamCallback: undefined,
    _thenCallback: undefined,
    _catchCallback: undefined,
    stream(callback) {
      this._streamCallback = callback;
      return this;
    },
    then(callback) {
      this._thenCallback = callback;
      return this;
    },
    catch(callback) {
      this._catchCallback = callback;
      return this;
    },
    close() {},
    _emit(data: string) {
      if (this._streamCallback) {
        this._streamCallback(data);
      }
    },
    _complete() {
      if (this._thenCallback) {
        this._thenCallback();
      }
    },
    _fail(error: unknown) {
      if (this._catchCallback) {
        this._catchCallback(error);
      }
    },
  };
  return proc;
}

export const mockPreflightResponse: PreflightResponse = {
  success: true,
  packages_to_upgrade: 1,
  total_download_size: 150000000,
  conflicts: [],
  replacements: [],
  removals: [],
  providers: [],
  import_keys: [],
};

export const mockPreflightWithConflicts: PreflightResponse = {
  success: true,
  packages_to_upgrade: 2,
  total_download_size: 200000000,
  conflicts: [{ package1: "mesa", package2: "mesa-amber" }],
  replacements: [{ old_package: "old-pkg", new_package: "new-pkg" }],
  removals: [],
  providers: [],
  import_keys: [],
};

export const mockPreflightWithKeys: PreflightResponse = {
  success: true,
  packages_to_upgrade: 1,
  total_download_size: 150000000,
  conflicts: [],
  replacements: [],
  removals: [],
  providers: [],
  import_keys: [{ fingerprint: "ABCD1234", uid: "Test Packager <test@arch.org>" }],
};

export const mockSyncPackageDetails: SyncPackageDetails = {
  name: "linux",
  version: "6.7.1-arch1-1",
  description: "The Linux kernel and modules",
  url: "https://kernel.org/",
  licenses: ["GPL-2.0-only"],
  groups: [],
  provides: ["VIRTUALBOX-GUEST-MODULES", "WIREGUARD-MODULE"],
  depends: ["coreutils", "initramfs", "kmod"],
  optdepends: ["wireless-regdb: to set the correct wireless channels"],
  conflicts: [],
  replaces: [],
  download_size: 150000000,
  installed_size: 145000000,
  packager: "Jan Alexander Steffens (heftig) <heftig@archlinux.org>",
  architecture: "x86_64",
  build_date: 1704067200,
  repository: "core",
};

export const mockRebootStatusNoReboot: RebootStatus = {
  requires_reboot: false,
  reason: "none",
  running_kernel: "6.18.5-arch1-1",
  installed_kernel: "6.18.5.arch1-1",
  kernel_package: "linux",
  updated_packages: [],
};

export const mockRebootStatusKernelUpdate: RebootStatus = {
  requires_reboot: true,
  reason: "kernel_update",
  running_kernel: "6.18.4-arch1-1",
  installed_kernel: "6.18.5.arch1-1",
  kernel_package: "linux",
  updated_packages: [],
};

export const mockRebootStatusCriticalPackages: RebootStatus = {
  requires_reboot: true,
  reason: "critical_packages",
  running_kernel: "6.18.5-arch1-1",
  installed_kernel: "6.18.5.arch1-1",
  kernel_package: "linux",
  updated_packages: ["systemd", "linux-firmware"],
};

export const mockLogGroups: LogGroup[] = [
  {
    id: "group-0",
    start_time: "2026-01-22T10:30:00+0000",
    end_time: "2026-01-22T10:30:45+0000",
    entries: [
      {
        timestamp: "2026-01-22T10:30:45+0000",
        action: "upgraded",
        package: "linux",
        old_version: "6.18.4-arch1-1",
        new_version: "6.18.5-arch1-1",
      },
      {
        timestamp: "2026-01-22T10:30:30+0000",
        action: "upgraded",
        package: "linux-firmware",
        old_version: "20250115.9fc05f5b-1",
        new_version: "20260120.abc123-1",
      },
      {
        timestamp: "2026-01-22T10:30:00+0000",
        action: "upgraded",
        package: "systemd",
        old_version: "256.5-1",
        new_version: "256.6-1",
      },
    ],
    upgraded_count: 3,
    installed_count: 0,
    removed_count: 0,
    downgraded_count: 0,
    reinstalled_count: 0,
  },
  {
    id: "group-1",
    start_time: "2026-01-21T14:15:00+0000",
    end_time: "2026-01-21T14:15:30+0000",
    entries: [
      {
        timestamp: "2026-01-21T14:15:30+0000",
        action: "installed",
        package: "neovim",
        old_version: null,
        new_version: "0.10.0-1",
      },
      {
        timestamp: "2026-01-21T14:15:00+0000",
        action: "installed",
        package: "tree-sitter",
        old_version: null,
        new_version: "0.22.6-1",
      },
    ],
    upgraded_count: 0,
    installed_count: 2,
    removed_count: 0,
    downgraded_count: 0,
    reinstalled_count: 0,
  },
  {
    id: "group-2",
    start_time: "2026-01-20T09:00:00+0000",
    end_time: "2026-01-20T09:00:00+0000",
    entries: [
      {
        timestamp: "2026-01-20T09:00:00+0000",
        action: "removed",
        package: "deprecated-package",
        old_version: "1.0.0-1",
        new_version: null,
      },
    ],
    upgraded_count: 0,
    installed_count: 0,
    removed_count: 1,
    downgraded_count: 0,
    reinstalled_count: 0,
  },
];

export const mockGroupedLogResponse: GroupedLogResponse = {
  groups: mockLogGroups,
  total_groups: 3,
  total_upgraded: 3,
  total_installed: 2,
  total_removed: 1,
  total_other: 0,
};

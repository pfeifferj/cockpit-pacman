interface CockpitProcess extends Promise<string> {
  input(data: string, stream?: boolean): void;
  stream(callback: (data: string) => void): void;
  close(problem?: string): void;
}

interface CockpitDBusClient {
  call(
    path: string,
    iface: string,
    method: string,
    args: unknown[] | null,
    options?: { type?: string },
  ): Promise<unknown[]>;
  close(): void;
}

interface CockpitFileWatchHandle {
  remove(): void;
}

/** https://cockpit-project.org/guide/latest/cockpit-file */
interface CockpitFile {
  /** Resolves to null when the file does not exist. */
  read(): PromiseLike<string | null>;
  /**
   * Calls back on every change; content is null with read: false. A read
   * error arrives as the third argument.
   */
  watch(
    callback: (content: string | null, tag: string | null, error?: unknown) => void,
    options?: { read?: boolean },
  ): CockpitFileWatchHandle;
  close(): void;
}

interface CockpitUserInfo {
  id: number;
  gid: number;
  name: string;
  full: string;
  groups: string[];
  home: string;
  shell: string;
}

/**
 * cockpit.location: a view over window.location.hash. A fresh object replaces
 * it on every change, so read it at the time of use.
 * https://docs.cockpit-project.org/cockpit-guide/latest/guide/cockpit-location.html
 */
interface CockpitLocation {
  readonly href: string;
  /** Decoded path segments; empty for the root path. */
  readonly path: string[];
  /** An option given more than once is an array. */
  readonly options: Record<string, string | string[]>;
  /** A string path is parsed, and relative to the current path unless it starts with "/". */
  go(path: string | string[], options?: Record<string, string | string[]>): void;
  replace(path: string | string[], options?: Record<string, string | string[]>): void;
  encode(path: string | string[], options?: Record<string, string | string[]>): string;
  decode(href: string, options?: Record<string, string | string[]>): string[];
}

declare const cockpit: {
  manifests?: { pacman?: { config?: { backend?: unknown } } };
  /**
   * "locationchanged" fires asynchronously after the location changes.
   * "visibilitychange" fires when `hidden` changes.
   */
  addEventListener(event: "locationchanged" | "visibilitychange", handler: () => void): void;
  removeEventListener(event: "locationchanged" | "visibilitychange", handler: () => void): void;
  readonly location: CockpitLocation;
  /**
   * True while the browser tab or the shell hides this frame.
   * https://github.com/cockpit-project/cockpit/blob/main/pkg/lib/cockpit.js ("Cockpit Page Visibility")
   */
  readonly hidden: boolean;
  spawn(
    args: string[],
    options?: {
      superuser?: "try" | "require";
      err?: "out" | "message";
    },
  ): CockpitProcess;
  dbus(
    name: string,
    options?: {
      bus?: "session" | "system" | "none";
      address?: string;
      superuser?: "try" | "require";
    },
  ): CockpitDBusClient;
  file(path: string, options?: { superuser?: "try" | "require"; max_read_size?: number }): CockpitFile;
  permission(options?: { admin?: boolean }): {
    allowed: boolean | null;
    addEventListener(event: "changed", handler: () => void): void;
    removeEventListener(event: "changed", handler: () => void): void;
    close(): void;
  };
  variant(type: string, value: unknown): { t: string; v: unknown };
  user(): Promise<CockpitUserInfo>;
  transport: {
    control(command: string, options: Record<string, unknown>): void;
  };
};

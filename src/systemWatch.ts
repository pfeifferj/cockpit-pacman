export const PACMAN_LOG = "/var/log/pacman.log";
/** A burst of writes becomes one change this long after the last write. */
export const CHANGE_DEBOUNCE_MS = 1000;

type CockpitFileObject = ReturnType<typeof cockpit.file>;

export interface FileWatch {
  close(): void;
}

/**
 * Calls onChange debounceMs after the last change to path. Returns null when
 * cockpit.file or its watch is missing or throws; callers then rely on their
 * own polling. Read errors reported through the watch are ignored.
 */
export function watchFile(path: string, onChange: () => void, debounceMs = CHANGE_DEBOUNCE_MS): FileWatch | null {
  if (typeof cockpit === "undefined" || typeof cockpit.file !== "function") return null;
  let file: CockpitFileObject | undefined;
  let handle: ReturnType<CockpitFileObject["watch"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    file = cockpit.file(path);
    if (typeof file.watch !== "function") {
      file.close();
      return null;
    }
    handle = file.watch((_content, _tag, error) => {
      if (error) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    }, { read: false });
  } catch {
    try {
      file?.close();
    } catch {
      return null;
    }
    return null;
  }
  return {
    close() {
      clearTimeout(timer);
      try {
        handle?.remove();
        file?.close();
      } catch {
        // The channel may already be gone.
      }
    },
  };
}

export interface SystemWatchHooks {
  /** Whether this page runs a system-changing command. */
  ownActivity(): boolean;
  notify(): void;
}

/** Watches pacman.log for external changes. Active page mutations notify on completion instead. */
export function startSystemWatch(hooks: SystemWatchHooks): FileWatch | null {
  return watchFile(PACMAN_LOG, () => {
    if (hooks.ownActivity()) return;
    hooks.notify();
  });
}

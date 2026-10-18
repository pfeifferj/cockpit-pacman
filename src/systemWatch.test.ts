import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startSystemWatch, watchFile, PACMAN_LOG } from "./systemWatch";

type WatchCallback = (content: string | null, tag: string | null, error?: unknown) => void;

const cockpitGlobal = globalThis as unknown as { cockpit: Record<string, unknown> };

function installFileMock() {
  const callbacks: WatchCallback[] = [];
  const remove = vi.fn();
  const close = vi.fn();
  const watch = vi.fn((callback: WatchCallback) => {
    callbacks.push(callback);
    return { remove };
  });
  const file = vi.fn(() => ({ read: vi.fn(), watch, close }));
  cockpitGlobal.cockpit.file = file;
  return {
    file, watch, remove, close,
    change: () => callbacks.forEach((cb) => cb(null, "-")),
  };
}

describe("startSystemWatch", () => {
  const makeHooks = () => ({
    ownActivity: vi.fn<() => boolean>(() => false),
    notify: vi.fn<() => void>(),
  });
  let hooks: ReturnType<typeof makeHooks>;

  beforeEach(() => {
    vi.useFakeTimers();
    hooks = makeHooks();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete cockpitGlobal.cockpit.file;
  });

  it("watches pacman.log without reading it and notifies once, 1 s after a burst of changes", () => {
    const mock = installFileMock();
    const watch = startSystemWatch(hooks);
    expect(watch).not.toBeNull();
    expect(mock.file).toHaveBeenCalledWith(PACMAN_LOG);
    expect(mock.watch).toHaveBeenCalledWith(expect.any(Function), { read: false });

    mock.change();
    vi.advanceTimersByTime(500);
    mock.change();
    vi.advanceTimersByTime(999);
    expect(hooks.notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hooks.notify).toHaveBeenCalledTimes(1);
    watch?.close();
  });

  it("ignores an active page transaction but observes changes immediately afterward", () => {
    const mock = installFileMock();
    const watch = startSystemWatch(hooks);

    hooks.ownActivity.mockReturnValue(true);
    mock.change();
    vi.advanceTimersByTime(1000);
    expect(hooks.notify).not.toHaveBeenCalled();

    hooks.ownActivity.mockReturnValue(false);
    mock.change();
    vi.advanceTimersByTime(1000);
    expect(hooks.notify).toHaveBeenCalledTimes(1);
    watch?.close();
  });

  it("ignores read errors reported through the watch", () => {
    installFileMock();
    const callbacks: WatchCallback[] = [];
    const mockFile = cockpitGlobal.cockpit.file as ReturnType<typeof vi.fn>;
    mockFile.mockImplementation(() => ({
      read: vi.fn(),
      watch: (cb: WatchCallback) => { callbacks.push(cb); return { remove: vi.fn() }; },
      close: vi.fn(),
    }));
    const watch = startSystemWatch(hooks);
    callbacks[0](null, null, new Error("access denied"));
    vi.advanceTimersByTime(1000);
    expect(hooks.notify).not.toHaveBeenCalled();
    watch?.close();
  });

  it("closing removes the watch, closes the file and drops a pending change", () => {
    const mock = installFileMock();
    const watch = startSystemWatch(hooks);
    mock.change();
    watch?.close();
    expect(mock.remove).toHaveBeenCalledTimes(1);
    expect(mock.close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(hooks.notify).not.toHaveBeenCalled();
  });

  it("falls back silently when cockpit.file is missing or watch throws", () => {
    expect(startSystemWatch(hooks)).toBeNull();

    const close = vi.fn();
    cockpitGlobal.cockpit.file = vi.fn(() => ({
      read: vi.fn(),
      watch: () => { throw new Error("not supported"); },
      close,
    }));
    expect(startSystemWatch(hooks)).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(hooks.notify).not.toHaveBeenCalled();
  });
});

describe("watchFile", () => {
  afterEach(() => {
    delete cockpitGlobal.cockpit.file;
  });

  it("returns null for a file object without watch", () => {
    const close = vi.fn();
    cockpitGlobal.cockpit.file = vi.fn(() => ({ read: vi.fn(), close }));
    expect(watchFile("/etc/pacman.conf", vi.fn())).toBeNull();
    expect(close).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePageVisible } from "./usePageVisible";

const visibilityListeners = new Set<() => void>();

function setHidden(hidden: boolean, notify = true) {
  Object.defineProperty(cockpit, "hidden", { value: hidden, configurable: true, writable: true });
  if (notify) for (const l of [...visibilityListeners]) l();
}

function trackVisibilityListeners() {
  const add = cockpit.addEventListener;
  const remove = cockpit.removeEventListener;
  vi.spyOn(cockpit, "addEventListener").mockImplementation((event, handler) => {
    if (event === "visibilitychange") visibilityListeners.add(handler);
    else add(event, handler);
  });
  vi.spyOn(cockpit, "removeEventListener").mockImplementation((event, handler) => {
    if (event === "visibilitychange") visibilityListeners.delete(handler);
    else remove(event, handler);
  });
}

describe("usePageVisible", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    visibilityListeners.clear();
    delete (cockpit as { hidden?: boolean }).hidden;
  });

  it("counts a frame without the hidden flag as visible", () => {
    const { result } = renderHook(() => usePageVisible());
    expect(result.current).toEqual({ visible: true, hasBeenVisible: true });
  });

  it("turns visible on the event and stays hasBeenVisible after hiding again", () => {
    trackVisibilityListeners();
    setHidden(true, false);
    const { result } = renderHook(() => usePageVisible());
    expect(result.current).toEqual({ visible: false, hasBeenVisible: false });

    act(() => setHidden(false));
    expect(result.current).toEqual({ visible: true, hasBeenVisible: true });

    act(() => setHidden(true));
    expect(result.current).toEqual({ visible: false, hasBeenVisible: true });
  });

  it("unsubscribes on unmount", () => {
    trackVisibilityListeners();
    setHidden(true, false);
    const { unmount } = renderHook(() => usePageVisible());
    expect(visibilityListeners.size).toBe(1);
    unmount();
    expect(visibilityListeners.size).toBe(0);
  });
});

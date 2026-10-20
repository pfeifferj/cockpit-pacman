import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";

const listeners = vi.hoisted(() => new Set<{ fn: (kind: string) => void; kinds: string[] }>());

vi.mock("../api", () => ({
  onSystemChanged: (fn: (kind: string) => void, kinds: string[] = ["system", "sync"]) => {
    const entry = { fn, kinds };
    listeners.add(entry);
    return () => listeners.delete(entry);
  },
}));

import { TabActiveContext, useRefreshOnActivate } from "./useRefreshOnActivate";

const emit = (kind: string) => {
  for (const entry of [...listeners]) {
    if (entry.kinds.includes(kind)) entry.fn(kind);
  }
};

const renderInTab = (reload: (kind?: "system" | "sync") => void, active: boolean, kinds?: ("system" | "sync")[]) => {
  const tab = { active };
  const result = renderHook(() => useRefreshOnActivate(reload, kinds ? { kinds } : undefined), {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(TabActiveContext.Provider, { value: tab.active }, children),
  });
  const setActive = (next: boolean) => {
    tab.active = next;
    result.rerender();
  };
  return { ...result, setActive };
};

describe("useRefreshOnActivate", () => {
  beforeEach(() => {
    listeners.clear();
  });

  it("does not reload on mount", () => {
    const reload = vi.fn();
    renderInTab(reload, true);
    renderInTab(reload, false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("defers a change while inactive to one reload on activation", () => {
    const reload = vi.fn();
    const { setActive } = renderInTab(reload, false);

    act(() => emit("system"));
    act(() => emit("system"));
    expect(reload).not.toHaveBeenCalled();

    setActive(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once per change while active", () => {
    const reload = vi.fn();
    renderInTab(reload, true);

    act(() => emit("system"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("passes the change kind and leaves activation without one", () => {
    const reload = vi.fn();
    const { setActive } = renderInTab(reload, true, ["system", "sync"]);
    act(() => emit("system"));
    expect(reload).toHaveBeenLastCalledWith("system");
    act(() => emit("sync"));
    expect(reload).toHaveBeenLastCalledWith("sync");
    setActive(false);
    act(() => emit("system"));
    expect(reload).toHaveBeenCalledTimes(2);
    setActive(true);
    expect(reload).toHaveBeenLastCalledWith();
  });

  it("ignores kinds it did not subscribe to", () => {
    const reload = vi.fn();
    renderInTab(reload, true);
    act(() => emit("sync"));
    expect(reload).not.toHaveBeenCalled();

    const syncReload = vi.fn();
    renderInTab(syncReload, true, ["system", "sync"]);
    act(() => emit("sync"));
    expect(syncReload).toHaveBeenCalledTimes(1);
  });

  it("treats a view outside any tab as active", () => {
    const reload = vi.fn();
    renderHook(() => useRefreshOnActivate(reload));
    act(() => emit("system"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount", () => {
    const reload = vi.fn();
    const { unmount } = renderInTab(reload, true);
    unmount();
    act(() => emit("system"));
    expect(reload).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});

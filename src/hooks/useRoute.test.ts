import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRoute, useRouteOptionsSync, optionsKey, type RouteOptions } from "./useRoute";
import { mockLocationGo, mockLocationReplace, resetMockLocation, setMockLocation } from "../test/setup";

describe("useRoute", () => {
  it("reads the tab and options from the location", () => {
    resetMockLocation(["history"], { q: "linux" });
    const { result } = renderHook(() => useRoute());
    expect(result.current.tab).toBe("history");
    expect(result.current.options.q).toBe("linux");
  });

  it("treats the empty path as Updates", () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current.tab).toBe("updates");
    expect(result.current.options).toEqual({});
  });

  it("takes the first value of a repeated option", () => {
    resetMockLocation(["installed"], { q: ["vim", "emacs"] });
    const { result } = renderHook(() => useRoute());
    expect(result.current.options.q).toBe("vim");
  });

  it("follows locationchanged", () => {
    const { result } = renderHook(() => useRoute());
    act(() => setMockLocation(["keyring"]));
    expect(result.current.tab).toBe("keyring");
  });

  it("navigate adds a history entry and drops empty options", () => {
    const { result } = renderHook(() => useRoute());
    act(() => result.current.navigate("cache"));
    expect(mockLocationGo).toHaveBeenCalledWith(["cache"]);
    act(() => result.current.navigate("search", { q: "vim", pkg: undefined, repo: "" }));
    expect(mockLocationGo).toHaveBeenLastCalledWith(["search"], { q: "vim" });
    expect(mockLocationReplace).not.toHaveBeenCalled();
  });

  it("navigate to Updates goes to the empty path", () => {
    resetMockLocation(["cache"]);
    const { result } = renderHook(() => useRoute());
    act(() => result.current.navigate("updates"));
    expect(mockLocationGo).toHaveBeenCalledWith([]);
    expect(result.current.tab).toBe("updates");
  });

  it("setOptions replaces the options of the current path", () => {
    resetMockLocation(["installed"], { q: "vim" });
    const { result } = renderHook(() => useRoute());
    act(() => result.current.setOptions({ q: "vim", pkg: "bash" }));
    expect(mockLocationReplace).toHaveBeenCalledWith(["installed"], { q: "vim", pkg: "bash" });
    expect(mockLocationGo).not.toHaveBeenCalled();
    expect(result.current.options).toEqual({ q: "vim", pkg: "bash" });
  });
});

describe("useRouteOptionsSync", () => {
  const parse = (options: RouteOptions): RouteOptions =>
    options.filter === "bad" ? { ...options, filter: "" } : options;

  it("ignores the route while the tab is not routed", () => {
    const apply = vi.fn();
    const onChange = vi.fn();
    const { rerender } = renderHook(({ state }) => useRouteOptionsSync(undefined, onChange, state, parse, apply), {
      initialProps: { state: { q: "" } as Record<string, string> },
    });
    rerender({ state: { q: "vim" } });
    expect(apply).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies a new location and writes back a state change, without echoing", () => {
    const apply = vi.fn();
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ route, state }) => useRouteOptionsSync(route, onChange, state, parse, apply),
      { initialProps: { route: {} as RouteOptions, state: {} as Record<string, string> } },
    );
    rerender({ route: { q: "vim" }, state: {} });
    expect(apply).toHaveBeenCalledWith({ q: "vim" });
    rerender({ route: { q: "vim" }, state: { q: "vim" } });
    expect(onChange).not.toHaveBeenCalled();

    rerender({ route: { q: "vim" }, state: { q: "vim", pkg: "bash" } });
    expect(onChange).toHaveBeenCalledWith({ q: "vim", pkg: "bash" });
    rerender({ route: { q: "vim", pkg: "bash" }, state: { q: "vim", pkg: "bash" } });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("rewrites options that do not parse as given", () => {
    const apply = vi.fn();
    const onChange = vi.fn();
    renderHook(() => useRouteOptionsSync({ filter: "bad" }, onChange, {}, parse, apply));
    expect(apply).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({});
  });

  it("keys options independently of order and empty values", () => {
    expect(optionsKey({ a: "1", b: "2", c: "" })).toBe(optionsKey({ b: "2", a: "1", d: undefined }));
  });
});

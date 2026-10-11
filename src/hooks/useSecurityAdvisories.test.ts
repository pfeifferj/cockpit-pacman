import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkSecurity, getSettings, setSecurityAdvisories, type SecurityResponse, type SettingsResponse } from "../api";
import { useSecurityAdvisories } from "./useSecurityAdvisories";

vi.mock("../api", () => ({ checkSecurity: vi.fn(), getSettings: vi.fn(), setSecurityAdvisories: vi.fn() }));

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("advisory response ordering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSettings).mockResolvedValue({ security_advisories: true });
    vi.mocked(setSecurityAdvisories).mockResolvedValue({ success: true, message: "Saved" });
  });

  it.each(["resolve", "reject"] as const)("ignores a stale %s after disabling advisories", async (outcome) => {
    const old = pending<SecurityResponse>();
    vi.mocked(checkSecurity).mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ advisories: [], stale: false, disabled: true });
    const { result } = renderHook(useSecurityAdvisories);
    let first!: Promise<void>;
    act(() => { first = result.current.load(); });
    await waitFor(() => expect(checkSecurity).toHaveBeenCalledTimes(1));
    await act(() => result.current.setEnabled(false));
    await act(async () => {
      if (outcome === "resolve") old.resolve({ advisories: [], stale: false, disabled: false });
      else old.reject(new Error("Old request failed"));
      await first;
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.unavailable).toBe(false);
    expect(result.current.loadError).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("does not clear a newer request's loading state when an old request finishes", async () => {
    const old = pending<SecurityResponse>();
    const current = pending<SecurityResponse>();
    vi.mocked(checkSecurity).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { result } = renderHook(useSecurityAdvisories);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.load(); });
    await waitFor(() => expect(checkSecurity).toHaveBeenCalledTimes(1));
    act(() => { second = result.current.load(true); });
    await waitFor(() => expect(checkSecurity).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.resolve({ advisories: [], stale: true });
      await first;
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.stale).toBe(false);
    await act(async () => {
      current.resolve({ advisories: [], stale: false, disabled: true });
      await second;
    });
    expect(result.current.enabled).toBe(false);
  });

  it("ignores loads while saving and reports the actual read error afterward", async () => {
    vi.mocked(checkSecurity).mockResolvedValueOnce({ advisories: [] });
    const { result } = renderHook(useSecurityAdvisories);
    await act(() => result.current.load());
    const write = pending<{ success: boolean; message: string }>();
    vi.mocked(setSecurityAdvisories).mockReturnValueOnce(write.promise);
    vi.mocked(getSettings).mockRejectedValue(new Error("Saved settings could not be read"));
    let saving!: Promise<void>;
    act(() => { saving = result.current.setEnabled(false); });
    await act(() => result.current.load());
    expect(checkSecurity).toHaveBeenCalledTimes(1);
    expect(getSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      write.resolve({ success: true, message: "Saved" });
      await saving;
    });
    expect(result.current.enabled).toBeNull();
    expect(result.current.loadError).toBe("Saved settings could not be read");
    expect(result.current.toggleError).toBeNull();
  });

  it("keeps unreadable settings unknown until a saved value can be loaded", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({ security_advisories: null });
    const { result } = renderHook(useSecurityAdvisories);
    expect(result.current.enabled).toBeNull();
    await act(() => result.current.load());
    expect(result.current.enabled).toBeNull();
    expect(result.current.unavailable).toBe(true);
    expect(result.current.loadError).toBe("Saved advisory setting is unavailable");
    expect(checkSecurity).not.toHaveBeenCalled();
    await act(() => result.current.setEnabled(true));
    expect(setSecurityAdvisories).not.toHaveBeenCalled();

    vi.mocked(getSettings).mockResolvedValueOnce({ security_advisories: false });
    vi.mocked(checkSecurity).mockResolvedValueOnce({ advisories: [], disabled: true });
    await act(() => result.current.load());
    expect(result.current.enabled).toBe(false);
    expect(result.current.unavailable).toBe(false);
    expect(result.current.loadError).toBeNull();
  });

  it("keeps a known setting editable after the tracker fails", async () => {
    vi.mocked(checkSecurity).mockRejectedValueOnce(new Error("Tracker is unreachable"));
    const { result } = renderHook(useSecurityAdvisories);
    await act(() => result.current.load());
    expect(result.current.enabled).toBe(true);
    expect(result.current.unavailable).toBe(true);
    expect(result.current.loadError).toBe("Tracker is unreachable");
    vi.mocked(getSettings).mockResolvedValueOnce({ security_advisories: false });
    vi.mocked(checkSecurity).mockResolvedValueOnce({ advisories: [], disabled: true });
    await act(() => result.current.setEnabled(false));
    expect(setSecurityAdvisories).toHaveBeenCalledWith(false);
    expect(result.current.enabled).toBe(false);
    expect(result.current.unavailable).toBe(false);
  });

  it("discards an older settings read after a completed toggle", async () => {
    vi.mocked(checkSecurity).mockResolvedValue({ advisories: [] });
    const { result } = renderHook(useSecurityAdvisories);
    await act(() => result.current.load());
    const old = pending<SettingsResponse>();
    vi.mocked(getSettings).mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ security_advisories: false });
    vi.mocked(checkSecurity).mockResolvedValue({ advisories: [], disabled: true });
    let first!: Promise<void>;
    act(() => { first = result.current.load(); });
    await act(() => result.current.setEnabled(false));
    await act(async () => {
      old.resolve({ security_advisories: true });
      await first;
    });
    expect(result.current.enabled).toBe(false);
    expect(checkSecurity).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);
  });
});

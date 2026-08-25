import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSignatureDismissal } from "./useSignatureDismissal";

function mount(signature: string, stored: string | null, mark = vi.fn().mockResolvedValue(undefined)) {
  const get = vi.fn().mockResolvedValue({ signature: stored });
  const hook = renderHook(() => useSignatureDismissal(get, mark, "test", signature));
  return { hook, mark };
}

describe("useSignatureDismissal", () => {
  it("stays hidden until the stored state has loaded", async () => {
    const get = vi.fn(() => new Promise<{ signature: string | null }>(() => {}));
    const { result } = renderHook(() => useSignatureDismissal(get, vi.fn(), "test", "sig-1"));
    expect(result.current.undismissed).toBe(false);
  });

  it("shows when the signature differs from the dismissed one", async () => {
    const { hook } = mount("sig-2", "sig-1");
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));
  });

  it("hides when the current signature was already dismissed", async () => {
    const { hook } = mount("sig-1", "sig-1");
    await waitFor(() => expect(hook.result.current.undismissed).toBe(false));
    expect(hook.result.current.undismissed).toBe(false);
  });

  it("hides when there is nothing to report", async () => {
    const { hook } = mount("", null);
    await waitFor(() => expect(hook.result.current.undismissed).toBe(false));
  });

  it("stays dismissed even when persisting the dismissal fails", async () => {
    const mark = vi.fn().mockRejectedValue(new Error("no backend"));
    const { hook } = mount("sig-1", null, mark);
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));

    act(() => hook.result.current.dismiss());

    expect(hook.result.current.undismissed).toBe(false);
    await waitFor(() => expect(mark).toHaveBeenCalledWith("sig-1"));
    expect(hook.result.current.undismissed).toBe(false);
  });
});

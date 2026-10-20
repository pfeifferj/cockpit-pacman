import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSignatureDismissal } from "./useSignatureDismissal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mount(
  signature: string,
  stored: string | null,
  mark = vi.fn().mockResolvedValue(undefined),
  onError = vi.fn(),
) {
  const api = {
    get: vi.fn().mockResolvedValue({ signature: stored }),
    mark,
    restore: vi.fn().mockResolvedValue(undefined),
  };
  const hook = renderHook(() => useSignatureDismissal(api, signature, onError));
  return { hook, api, onError };
}

describe("useSignatureDismissal", () => {
  it("stays hidden until the stored state has loaded", async () => {
    const api = {
      get: vi.fn(() => new Promise<{ signature: string | null }>(() => {})),
      mark: vi.fn(),
      restore: vi.fn(),
    };
    const { result } = renderHook(() => useSignatureDismissal(api, "sig-1"));
    expect(result.current.undismissed).toBe(false);
    expect(result.current.dismissed).toBe(false);
  });

  it("shows when the signature differs from the dismissed one", async () => {
    const { hook } = mount("sig-2", "sig-1");
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));
    expect(hook.result.current.dismissed).toBe(false);
  });

  it("hides when the current signature was already dismissed", async () => {
    const { hook } = mount("sig-1", "sig-1");
    await waitFor(() => expect(hook.result.current.dismissed).toBe(true));
    expect(hook.result.current.undismissed).toBe(false);
  });

  it.each(["files\nwarning", "x".repeat(5000), "é".repeat(2100)])("stores a signature the backend would reject as a digest that still matches", async (raw) => {
    const { hook, api } = mount(raw, null);
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));
    act(() => { hook.result.current.dismiss(); });
    await waitFor(() => expect(api.mark).toHaveBeenCalledOnce());
    const sent: string = api.mark.mock.calls[0][0];
    expect(sent).not.toMatch(/\p{Cc}/u);
    expect(sent.length).toBeLessThanOrEqual(4096);
    const again = mount(raw, sent);
    await waitFor(() => expect(again.hook.result.current.dismissed).toBe(true));
  });

  it("resurfaces changed warnings that collided with the old digest", async () => {
    const first = "\nscan-incomplete:/etc/example-1284iaj30fh: Permission denied";
    const next = "\nscan-incomplete:/etc/example-1ne7vdm37x6: Permission denied";
    const { hook, api } = mount(first, null);
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));
    act(() => { hook.result.current.dismiss(); });
    await waitFor(() => expect(api.mark).toHaveBeenCalledOnce());
    const dismissed: string = api.mark.mock.calls[0][0];
    const changed = mount(next, dismissed);
    await waitFor(() => expect(changed.hook.result.current.undismissed).toBe(true));
    act(() => { changed.hook.result.current.dismiss(); });
    await waitFor(() => expect(changed.api.mark).toHaveBeenCalledOnce());
    expect(changed.api.mark.mock.calls[0][0]).not.toBe(dismissed);
  });

  it("hides when there is nothing to report", async () => {
    const { hook } = mount("", null);
    await waitFor(() => expect(hook.result.current.undismissed).toBe(false));
    expect(hook.result.current.dismissed).toBe(false);
  });

  it("undo writes back the signature stored before the dismissal", async () => {
    const { hook, api } = mount("sig-2", "sig-1");
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));

    act(() => hook.result.current.dismiss());
    expect(hook.result.current.undismissed).toBe(false);
    await waitFor(() => expect(api.mark).toHaveBeenCalledWith("sig-2"));

    act(() => hook.result.current.undo());
    expect(hook.result.current.undismissed).toBe(true);
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith("sig-1", "sig-2"));
  });

  it("undo of a first dismissal clears the stored signature", async () => {
    const { hook, api } = mount("sig-1", null);
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));

    act(() => hook.result.current.dismiss());
    act(() => hook.result.current.undo());

    expect(hook.result.current.undismissed).toBe(true);
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith(null, "sig-1"));
  });

  it("reverts and reports once when persisting the dismissal fails", async () => {
    const err = new Error("no backend");
    const mark = vi.fn().mockRejectedValue(err);
    const { hook, onError } = mount("sig-1", null, mark);
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));

    act(() => hook.result.current.dismiss());
    expect(hook.result.current.undismissed).toBe(false);

    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("a failed undo from a pre-dismissal closure keeps the alert dismissed", async () => {
    const { hook, api, onError } = mount("sig-2", "sig-1");
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));
    const staleUndo = hook.result.current.undo;
    api.restore.mockRejectedValueOnce(new Error("denied"));

    act(() => hook.result.current.dismiss());
    act(() => staleUndo());
    expect(hook.result.current.undismissed).toBe(true);

    await waitFor(() => expect(hook.result.current.dismissed).toBe(true));
    expect(api.restore).toHaveBeenCalledWith("sig-1", "sig-2");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("restore shows a dismissed alert again", async () => {
    const { hook, api } = mount("sig-1", "sig-1");
    await waitFor(() => expect(hook.result.current.dismissed).toBe(true));

    act(() => hook.result.current.restore());

    expect(hook.result.current.undismissed).toBe(true);
    expect(hook.result.current.dismissed).toBe(false);
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith(null, "sig-1"));
  });

  it("a failed restore hides the alert again and reports", async () => {
    const { hook, api, onError } = mount("sig-1", "sig-1");
    api.restore.mockRejectedValueOnce(new Error("denied"));
    await waitFor(() => expect(hook.result.current.dismissed).toBe(true));

    act(() => hook.result.current.restore());

    await waitFor(() => expect(hook.result.current.dismissed).toBe(true));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps Undo optimistic while persisting mark and restore in order", async () => {
    const mark = deferred<void>();
    const restore = deferred<void>();
    let persisted: string | null = "old";
    const api = {
      get: vi.fn(async () => ({ signature: persisted })),
      mark: vi.fn(async (signature: string) => { await mark.promise; persisted = signature; }),
      restore: vi.fn(async (previous?: string | null) => { await restore.promise; persisted = previous ?? null; }),
    };
    const { result } = renderHook(() => useSignatureDismissal(api, "new"));
    await waitFor(() => expect(result.current.undismissed).toBe(true));
    let undo!: () => void;
    act(() => { undo = result.current.dismiss(); });
    expect(result.current.dismissed).toBe(true);
    act(() => undo());
    expect(result.current.undismissed).toBe(true);
    await waitFor(() => expect(api.mark).toHaveBeenCalledWith("new"));
    expect(api.restore).not.toHaveBeenCalled();

    await act(async () => mark.resolve());
    expect(api.restore).toHaveBeenCalledWith("old", "new");
    expect(result.current.undismissed).toBe(true);
    await act(async () => restore.resolve());
    expect(persisted).toBe("old");
  });

  it.each([true, false])("rolls a failed Undo back to confirmed state when mark succeeds=%s", async (markSucceeds) => {
    const mark = deferred<void>();
    const { hook, api, onError } = mount("new", "old", vi.fn(() => mark.promise));
    api.restore.mockRejectedValueOnce(new Error("restore failed"));
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));
    act(() => hook.result.current.dismiss());
    act(() => hook.result.current.undo());
    expect(hook.result.current.undismissed).toBe(true);

    await act(async () => {
      if (markSucceeds) mark.resolve();
      else mark.reject(new Error("mark failed"));
    });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(markSucceeds ? 1 : 2));
    expect(hook.result.current.dismissed).toBe(markSucceeds);
    expect(api.restore).toHaveBeenCalledWith("old", "new");
  });

  it("does not let an older failed write or its Undo replace a newer dismissal", async () => {
    const first = deferred<void>();
    let persisted: string | null = null;
    const onError = vi.fn();
    const api = {
      get: vi.fn(async () => ({ signature: persisted })),
      mark: vi.fn(async (signature: string) => {
        if (signature === "first") await first.promise;
        persisted = signature;
      }),
      restore: vi.fn(async (previous?: string | null) => { persisted = previous ?? null; }),
    };
    const hook = renderHook(({ signature }) => useSignatureDismissal(api, signature, onError), {
      initialProps: { signature: "first" },
    });
    await waitFor(() => expect(hook.result.current.undismissed).toBe(true));
    let firstUndo!: () => void;
    act(() => { firstUndo = hook.result.current.dismiss(); });
    hook.rerender({ signature: "second" });
    act(() => hook.result.current.dismiss());
    expect(hook.result.current.dismissed).toBe(true);
    act(() => firstUndo());
    expect(api.restore).not.toHaveBeenCalled();

    await act(async () => first.reject(new Error("first failed")));
    await waitFor(() => expect(persisted).toBe("second"));
    expect(hook.result.current.dismissed).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    act(() => firstUndo());
    expect(api.restore).not.toHaveBeenCalled();
  });

  it("uses a delayed initial read as the baseline beneath pending dismissal and Undo", async () => {
    const read = deferred<{ signature: string | null }>();
    const api = {
      get: vi.fn(() => read.promise),
      mark: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
    };
    const { result } = renderHook(() => useSignatureDismissal(api, "new"));
    act(() => result.current.dismiss());
    act(() => result.current.undo());
    expect(result.current.undismissed).toBe(true);
    expect(api.mark).not.toHaveBeenCalled();

    await act(async () => read.resolve({ signature: "old" }));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith("old", "new"));
    expect(result.current.undismissed).toBe(true);
  });

  it.each([true, false])("drains queued writes before a remount reads, with restore succeeding=%s", async (restoreSucceeds) => {
    const mark = deferred<void>();
    const restore = deferred<void>();
    let persisted: string | null = "old";
    const onError = vi.fn();
    const api = {
      get: vi.fn(async () => ({ signature: persisted })),
      mark: vi.fn(async (signature: string) => { await mark.promise; persisted = signature; }),
      restore: vi.fn(async (previous?: string | null) => { await restore.promise; persisted = previous ?? null; }),
    };
    const first = renderHook(() => useSignatureDismissal(api, "new", onError));
    await waitFor(() => expect(first.result.current.undismissed).toBe(true));
    act(() => first.result.current.dismiss());
    act(() => first.result.current.undo());
    first.unmount();
    const next = renderHook(() => useSignatureDismissal(api, "new"));
    await act(async () => {});
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(next.result.current.dismissed).toBe(false);
    expect(next.result.current.undismissed).toBe(false);

    await act(async () => mark.resolve());
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (restoreSucceeds) restore.resolve();
      else restore.reject(new Error("restore failed"));
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(next.result.current.dismissed).toBe(!restoreSucceeds);
    expect(next.result.current.undismissed).toBe(restoreSucceeds);
    expect(persisted).toBe(restoreSucceeds ? "old" : "new");
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not block a separate dismissal resource and recovers after a failed read", async () => {
    const held = deferred<void>();
    const first = mount("one", null, vi.fn(() => held.promise));
    await waitFor(() => expect(first.hook.result.current.undismissed).toBe(true));
    act(() => first.hook.result.current.dismiss());
    const api = {
      get: vi.fn().mockRejectedValue(new Error("read failed")),
      mark: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
    };
    const second = renderHook(() => useSignatureDismissal(api, "two"));
    await waitFor(() => expect(second.result.current.undismissed).toBe(true));
    act(() => second.result.current.dismiss());
    await waitFor(() => expect(api.mark).toHaveBeenCalledWith("two"));
    expect(second.result.current.dismissed).toBe(true);
    await act(async () => held.resolve());
  });

  it("ignores an Undo retained from an unmounted owner", async () => {
    let persisted: string | null = null;
    const api = {
      get: vi.fn(async () => ({ signature: persisted })),
      mark: vi.fn(async (signature: string) => { persisted = signature; }),
      restore: vi.fn(async (previous?: string | null) => { persisted = previous ?? null; }),
    };
    const first = renderHook(() => useSignatureDismissal(api, "first"));
    await waitFor(() => expect(first.result.current.undismissed).toBe(true));
    let undo!: () => void;
    await act(async () => { undo = first.result.current.dismiss(); });
    first.unmount();
    const second = renderHook(() => useSignatureDismissal(api, "second"));
    await waitFor(() => expect(second.result.current.undismissed).toBe(true));
    await act(async () => { second.result.current.dismiss(); });
    await act(async () => undo());
    expect(api.restore).not.toHaveBeenCalled();
    expect(persisted).toBe("second");
    expect(second.result.current.dismissed).toBe(true);
  });
});

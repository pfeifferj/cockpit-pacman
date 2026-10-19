import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import * as api from "../api";
import { useArchNews, type NewsDismissal } from "./useArchNews";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    fetchNews: vi.fn(),
    getNewsReadState: vi.fn(),
    markNewsRead: vi.fn(),
    markNewsUnread: vi.fn(),
  };
});

const item = (n: number) => ({
  title: `Item ${n}`,
  link: `https://archlinux.org/news/${n}/`,
  published: "2026-01-01T00:00:00+00:00",
  summary: "",
});

const links = (items: { link: string }[]) => items.map((i) => i.link);

describe("useArchNews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchNews).mockResolvedValue({ items: [item(1), item(2), item(3)], stale: false });
    vi.mocked(api.getNewsReadState).mockResolvedValue({ dismissed: [item(3).link] });
    vi.mocked(api.markNewsRead).mockResolvedValue(undefined);
    vi.mocked(api.markNewsUnread).mockResolvedValue(undefined);
  });

  async function mount(onError = vi.fn()) {
    const hook = renderHook(() => useArchNews(onError));
    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    return { hook, onError };
  }

  it("separates visible items from dismissed ones in the window", async () => {
    const { hook } = await mount();
    expect(links(hook.result.current.items)).toEqual([item(1).link, item(2).link]);
    expect(links(hook.result.current.dismissedInWindow)).toEqual([item(3).link]);
  });

  it("dismissAll marks every visible item and undo marks them unread", async () => {
    const { hook } = await mount();

    let batch!: NewsDismissal;
    act(() => { batch = hook.result.current.dismissAll(); });

    expect(batch.links).toEqual([item(1).link, item(2).link]);
    expect(hook.result.current.items).toHaveLength(0);
    await waitFor(() => expect(api.markNewsRead).toHaveBeenCalledTimes(2));

    act(() => hook.result.current.undo());

    expect(hook.result.current.items).toHaveLength(2);
    await waitFor(() => expect(api.markNewsUnread).toHaveBeenCalledTimes(2));
  });

  it("reverts only the failed links and reports once per batch", async () => {
    vi.mocked(api.markNewsRead).mockImplementation((link) =>
      link === item(1).link ? Promise.resolve() : Promise.reject(new Error("denied")),
    );
    const { hook, onError } = await mount();

    act(() => { hook.result.current.dismissAll(); });

    await waitFor(() => expect(links(hook.result.current.items)).toEqual([item(2).link]));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("restore shows a dismissed item again and a failed restore hides it again", async () => {
    const { hook, onError } = await mount();

    act(() => hook.result.current.restore(item(3).link));
    expect(hook.result.current.items).toHaveLength(3);
    await waitFor(() => expect(api.markNewsUnread).toHaveBeenCalledWith(item(3).link));

    vi.mocked(api.markNewsUnread).mockRejectedValueOnce(new Error("denied"));
    act(() => hook.result.current.dismiss(item(3).link));
    act(() => hook.result.current.restore(item(3).link));

    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reload refetches and clears the error", async () => {
    vi.mocked(api.fetchNews).mockRejectedValueOnce(new Error("offline"));
    const hook = renderHook(() => useArchNews());
    await waitFor(() => expect(hook.result.current.error).toBe(true));

    act(() => hook.result.current.reload());
    expect(hook.result.current.error).toBe(false);

    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(api.fetchNews).toHaveBeenCalledTimes(2);
    expect(hook.result.current.error).toBe(false);
  });

  it("fetches nothing until enabled", async () => {
    const hook = renderHook(({ enabled }) => useArchNews(undefined, enabled), { initialProps: { enabled: false } });
    await act(async () => {});
    expect(api.fetchNews).not.toHaveBeenCalled();
    expect(api.getNewsReadState).not.toHaveBeenCalled();

    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(api.fetchNews).toHaveBeenCalledTimes(1);
  });

  it("persists a dismissal before its optimistic Undo", async () => {
    const mark = deferred<void>();
    const restore = deferred<void>();
    const persisted = new Set([item(3).link]);
    vi.mocked(api.getNewsReadState).mockImplementation(async () => ({ dismissed: [...persisted] }));
    vi.mocked(api.markNewsRead).mockImplementation(async (link) => { await mark.promise; persisted.add(link); });
    vi.mocked(api.markNewsUnread).mockImplementation(async (link) => { await restore.promise; persisted.delete(link); });
    const { hook } = await mount();
    let batch!: NewsDismissal;
    act(() => { batch = hook.result.current.dismiss(item(1).link); });
    expect(links(hook.result.current.items)).toEqual([item(2).link]);
    act(() => batch.undo());
    expect(links(hook.result.current.items)).toEqual([item(1).link, item(2).link]);
    await waitFor(() => expect(api.markNewsRead).toHaveBeenCalledWith(item(1).link));
    expect(api.markNewsUnread).not.toHaveBeenCalled();

    await act(async () => mark.resolve());
    expect(api.markNewsUnread).toHaveBeenCalledWith(item(1).link);
    expect(links(hook.result.current.items)).toEqual([item(1).link, item(2).link]);
    await act(async () => restore.resolve());
    expect([...persisted]).toEqual([item(3).link]);
  });

  it("keeps a newer successful dismissal when the first fails and ignores its obsolete Undo", async () => {
    const first = deferred<void>();
    const persisted = new Set([item(3).link]);
    vi.mocked(api.markNewsRead)
      .mockImplementationOnce(async (link) => { await first.promise; persisted.add(link); })
      .mockImplementation(async (link) => { persisted.add(link); });
    vi.mocked(api.markNewsUnread).mockImplementation(async (link) => { persisted.delete(link); });
    const { hook, onError } = await mount();
    let firstBatch!: NewsDismissal;
    act(() => { firstBatch = hook.result.current.dismiss(item(1).link); });
    act(() => firstBatch.undo());
    act(() => { hook.result.current.dismiss(item(1).link); });
    expect(links(hook.result.current.items)).toEqual([item(2).link]);
    await act(async () => first.reject(new Error("first failed")));
    await waitFor(() => expect(api.markNewsRead).toHaveBeenCalledTimes(2));
    expect(persisted.has(item(1).link)).toBe(true);
    expect(links(hook.result.current.items)).toEqual([item(2).link]);
    expect(onError).toHaveBeenCalledTimes(1);

    await act(async () => firstBatch.undo());
    expect(api.markNewsUnread).toHaveBeenCalledTimes(1);
    expect(persisted.has(item(1).link)).toBe(true);
  });

  it.each([true, false])("retains confirmed membership after both opposite writes fail, initially dismissed=%s", async (initiallyDismissed) => {
    vi.mocked(api.getNewsReadState).mockResolvedValue({ dismissed: initiallyDismissed ? [item(1).link] : [] });
    vi.mocked(api.markNewsRead).mockRejectedValue(new Error("mark failed"));
    vi.mocked(api.markNewsUnread).mockRejectedValue(new Error("restore failed"));
    const onError = vi.fn();
    const hook = renderHook(() => useArchNews(onError));
    await waitFor(() => expect(hook.result.current.items).toHaveLength(initiallyDismissed ? 2 : 3));
    if (initiallyDismissed) {
      act(() => hook.result.current.restore(item(1).link));
      act(() => { hook.result.current.dismiss(item(1).link); });
    } else {
      act(() => { hook.result.current.dismiss(item(1).link); });
      act(() => hook.result.current.undo());
    }
    expect(links(hook.result.current.items).includes(item(1).link)).toBe(!initiallyDismissed);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(links(hook.result.current.items).includes(item(1).link)).toBe(!initiallyDismissed);
  });

  it("reports each failed batch once and rolls each link back to its own confirmed state", async () => {
    vi.mocked(api.markNewsRead).mockImplementation(async (link) => {
      if (link === item(2).link) throw new Error("mark failed");
    });
    vi.mocked(api.markNewsUnread).mockRejectedValue(new Error("restore failed"));
    const { hook, onError } = await mount();
    act(() => { hook.result.current.dismissAll(); });
    act(() => hook.result.current.undo());
    expect(hook.result.current.items).toHaveLength(2);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(api.markNewsUnread).toHaveBeenCalledTimes(2);
    expect(links(hook.result.current.items)).toEqual([item(2).link]);
  });

  it("merges a delayed initial read beneath optimistic writes and preserves unrelated dismissals", async () => {
    const read = deferred<{ dismissed: string[] }>();
    const mark = deferred<void>();
    vi.mocked(api.getNewsReadState).mockReturnValueOnce(read.promise);
    vi.mocked(api.markNewsRead).mockReturnValueOnce(mark.promise);
    const onError = vi.fn();
    const hook = renderHook(() => useArchNews(onError));
    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));
    act(() => { hook.result.current.dismiss(item(1).link); });
    expect(links(hook.result.current.items)).toEqual([item(2).link, item(3).link]);
    expect(api.markNewsRead).not.toHaveBeenCalled();

    await act(async () => read.resolve({ dismissed: [item(3).link] }));
    expect(links(hook.result.current.items)).toEqual([item(2).link]);
    await act(async () => mark.reject(new Error("mark failed")));
    expect(links(hook.result.current.items)).toEqual([item(1).link, item(2).link]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("an early Undo restores membership learned from the delayed read", async () => {
    const read = deferred<{ dismissed: string[] }>();
    const persisted = new Set([item(1).link, item(3).link]);
    vi.mocked(api.getNewsReadState).mockReturnValueOnce(read.promise);
    vi.mocked(api.markNewsRead).mockImplementation(async (link) => { persisted.add(link); });
    vi.mocked(api.markNewsUnread).mockImplementation(async (link) => { persisted.delete(link); });
    const hook = renderHook(() => useArchNews());
    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));
    act(() => { hook.result.current.dismiss(item(1).link); });
    act(() => hook.result.current.undo());
    expect(hook.result.current.items).toHaveLength(3);

    await act(async () => read.resolve({ dismissed: [...persisted] }));
    await waitFor(() => expect(api.markNewsRead).toHaveBeenCalledTimes(2));
    expect(api.markNewsUnread).not.toHaveBeenCalled();
    expect([...persisted]).toEqual([item(1).link, item(3).link]);
    expect(links(hook.result.current.items)).toEqual([item(2).link]);
  });

  it("keeps a newer per-link dismissal when an older batch is undone", async () => {
    const { hook } = await mount();
    let batch!: NewsDismissal;
    await act(async () => { batch = hook.result.current.dismissAll(); });
    await act(async () => hook.result.current.restore(item(1).link));
    await act(async () => { hook.result.current.dismiss(item(1).link); });
    await act(async () => batch.undo());
    expect(vi.mocked(api.markNewsUnread).mock.calls.map(([link]) => link)).toEqual([item(1).link, item(2).link]);
    expect(links(hook.result.current.items)).toEqual([item(2).link]);
  });

  it("orders reload behind pending writes without hiding a pending Undo", async () => {
    const mark = deferred<void>();
    const restore = deferred<void>();
    const persisted = new Set([item(3).link]);
    vi.mocked(api.getNewsReadState).mockImplementation(async () => ({ dismissed: [...persisted] }));
    vi.mocked(api.markNewsRead).mockImplementation(async (link) => { await mark.promise; persisted.add(link); });
    vi.mocked(api.markNewsUnread).mockImplementation(async (link) => { await restore.promise; persisted.delete(link); });
    const { hook } = await mount();
    act(() => { hook.result.current.dismiss(item(1).link); });
    act(() => hook.result.current.reload());
    act(() => hook.result.current.undo());
    await act(async () => {});
    expect(api.getNewsReadState).toHaveBeenCalledTimes(1);
    await act(async () => mark.resolve());
    expect(api.getNewsReadState).toHaveBeenCalledTimes(2);
    expect(links(hook.result.current.items)).toEqual([item(1).link, item(2).link]);
    await act(async () => restore.resolve());
    expect([...persisted]).toEqual([item(3).link]);
  });

  it("drains writes after unmount and makes a remount read their final state without obsolete errors", async () => {
    const mark = deferred<void>();
    const restore = deferred<void>();
    const persisted = new Set([item(3).link]);
    vi.mocked(api.getNewsReadState).mockImplementation(async () => ({ dismissed: [...persisted] }));
    vi.mocked(api.markNewsRead).mockImplementation(async (link) => { await mark.promise; persisted.add(link); });
    vi.mocked(api.markNewsUnread).mockImplementation(async (link) => { await restore.promise; persisted.delete(link); });
    const { hook, onError } = await mount();
    act(() => { hook.result.current.dismiss(item(1).link); });
    act(() => hook.result.current.undo());
    hook.unmount();
    const next = renderHook(() => useArchNews());
    await act(async () => {});
    expect(api.getNewsReadState).toHaveBeenCalledTimes(1);
    await act(async () => mark.resolve());
    expect(api.getNewsReadState).toHaveBeenCalledTimes(1);
    await act(async () => restore.reject(new Error("restore failed")));
    await waitFor(() => expect(api.getNewsReadState).toHaveBeenCalledTimes(2));
    expect(links(next.result.current.items)).toEqual([item(2).link]);
    expect([...persisted]).toEqual([item(3).link, item(1).link]);
    expect(onError).not.toHaveBeenCalled();
  });
});

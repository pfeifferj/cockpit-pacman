import { BackendError } from "../api";
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  rebaseEntries, deleteBackups, mergeField, outsideChangeSummary, useConfigFileEditor, type EntryModel,
} from "./useConfigFileEditor";

interface Row {
  id: string;
  on: boolean;
}

const model: EntryModel<Row> = {
  key: (r) => r.id,
  label: (r) => r.id,
  same: (a, b) => a.on === b.on,
  merge(base, draft, fresh) {
    const on = mergeField(base.on, draft.on, fresh.on);
    return { entry: { ...fresh, on: on.value }, skipped: on.conflict ? [`toggle ${fresh.id}`] : [] };
  },
};

const rows = (spec: string) =>
  spec.split(" ").map((t) => ({ id: t.replace("-", ""), on: !t.startsWith("-") }));
const ids = (list: Row[]) => list.map((r) => (r.on ? r.id : `-${r.id}`)).join(" ");

describe("rebaseEntries", () => {
  it("replays a field edit and keeps an entry added outside in its place", () => {
    const result = rebaseEntries(rows("a b c"), rows("a -b c"), rows("a x b c"), model);
    expect(ids(result.entries)).toBe("a x -b c");
    expect(result.skipped).toEqual([]);
  });

  it("applies the user's reorder when the order did not change outside", () => {
    const result = rebaseEntries(rows("a b c"), rows("c a b"), rows("a b c d"), model);
    expect(ids(result.entries)).toBe("c a b d");
  });

  it("keeps the outside order and names the reorder when both sides reordered", () => {
    const result = rebaseEntries(rows("a b c"), rows("c a b"), rows("b a c"), model);
    expect(ids(result.entries)).toBe("b a c");
    expect(result.skipped).toEqual(["Reorder: the order changed since you started editing"]);
  });

  it("names edits to an entry removed outside and drops it", () => {
    const result = rebaseEntries(rows("a b"), rows("a -b"), rows("a"), model);
    expect(ids(result.entries)).toBe("a");
    expect(result.skipped).toEqual(["Changes to b: it was removed since you started editing"]);
  });

  it("keeps an entry the user removed when it changed outside", () => {
    const result = rebaseEntries(rows("a b"), rows("a"), rows("a -b"), model);
    expect(ids(result.entries)).toBe("a -b");
    expect(result.skipped).toEqual(["Remove b: it changed since you started editing"]);
  });

  it("places an entry the user added after its predecessor", () => {
    const result = rebaseEntries(rows("a b"), rows("a n b"), rows("z a b"), model);
    expect(ids(result.entries)).toBe("z a n b");
  });
});

describe("mergeField", () => {
  it("takes the side that changed and flags two different changes", () => {
    expect(mergeField("x", "y", "x")).toEqual({ value: "y", conflict: false });
    expect(mergeField("x", "x", "z")).toEqual({ value: "z", conflict: false });
    expect(mergeField("x", "y", "y")).toEqual({ value: "y", conflict: false });
    expect(mergeField("x", "y", "z")).toEqual({ value: "z", conflict: true });
  });
});

describe("outsideChangeSummary", () => {
  it.each([
    [0, 0, "pacman.conf changed since you started editing."],
    [1, 0, "pacman.conf changed since you started editing. Your 1 change was reapplied."],
    [3, 0, "pacman.conf changed since you started editing. Your 3 changes were reapplied."],
    [0, 1, "pacman.conf changed since you started editing. 1 change no longer applies."],
    [2, 2, "pacman.conf changed since you started editing. Your 2 changes were reapplied. 2 changes no longer apply."],
    [1000, 0, "pacman.conf changed since you started editing. Your 1,000 changes were reapplied."],
  ])("%i applied, %i skipped", (applied, skipped, text) => {
    expect(outsideChangeSummary("pacman.conf", applied, skipped)).toBe(text);
  });
});

describe("deleteBackups", () => {
  it("returns null when every delete succeeds", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    expect(await deleteBackups([1, 2], remove)).toBeNull();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("counts failures across a bulk delete", async () => {
    const remove = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("busy"));
    expect(await deleteBackups([1, 2], remove)).toBe("1 of 2 backups were not deleted: busy");
  });
});

describe("useConfigFileEditor", () => {
  const describeChanges = (before: Row[], after: Row[]) =>
    after.filter((r) => before.find((b) => b.id === r.id)?.on !== r.on).map((r) => `toggle ${r.id}`);

  function setup() {
    const file = { rows: rows("a b"), revision: "r1", fail: false };
    const read = vi.fn(async () => {
      if (file.fail) throw new Error("read failed");
      return { rows: file.rows, revision: file.revision };
    });
    const hook = renderHook(() => {
      const editor = useConfigFileEditor<Row>({
        ...model,
        file: "/etc/test.conf",
        describeChanges,
        read: async () => { const r = await read(); return { entries: r.rows, revision: r.revision }; },
        reload: async () => {
          try {
            const r = await read();
            editor.applyRead(r.rows, r.revision);
          } catch (ex) {
            if (!editor.readFailed((ex as Error).message)) editor.clear();
          }
        },
        write: vi.fn(async (list: Row[]) => {
          file.rows = list;
          file.revision = "r2";
          return { backupTimestamp: 100, revision: file.revision };
        }),
        restore: vi.fn(async () => ({ backupTimestamp: 101 })),
        undo: vi.fn(async () => ({ backupTimestamp: 102, revision: "r3" })),
        savedTitle: "Saved",
        notSavedAnnouncement: "Not saved",
      });
      return editor;
    });
    return { file, hook };
  }

  it("drops Undo when the file changes after a save", async () => {
    const { file, hook } = setup();
    await act(() => hook.result.current.retryRefresh());
    await act(async () => hook.result.current.setEntries(rows("a -b")));
    await act(() => hook.result.current.save());
    expect(hook.result.current.lastWrite?.backupTimestamp).toBe(100);

    await act(() => hook.result.current.refreshFromOutside());
    expect(hook.result.current.lastWrite).not.toBeNull();

    file.rows = rows("-a -b");
    file.revision = "r3";
    await act(() => hook.result.current.refreshFromOutside());
    expect(hook.result.current.lastWrite).toBeNull();
    expect(hook.result.current.outsideNotice?.changes).toEqual(["toggle a"]);
  });

  it("keeps entries, edits and revision when a reread fails with a file loaded", async () => {
    const { file, hook } = setup();
    await act(() => hook.result.current.retryRefresh());
    expect(hook.result.current.revision).toBe("r1");
    await act(async () => hook.result.current.setEntries(rows("-a b")));

    file.fail = true;
    file.revision = "r2";
    await act(() => hook.result.current.refreshFromOutside());
    expect(hook.result.current.refreshError).toBe("read failed");
    expect(ids(hook.result.current.entries)).toBe("-a b");
    expect(hook.result.current.pendingChanges).toEqual(["toggle a"]);
    expect(hook.result.current.revision).toBe("r1");

    file.fail = false;
    await act(() => hook.result.current.retryRefresh());
    expect(hook.result.current.refreshError).toBeNull();
    expect(hook.result.current.revision).toBe("r2");
  });

  it("reports a failed first read so the view can show its load error", async () => {
    const { file, hook } = setup();
    file.fail = true;
    await act(() => hook.result.current.retryRefresh());
    expect(hook.result.current.loaded).toBeNull();
    expect(hook.result.current.refreshError).toBeNull();
  });
});


describe("checked configuration writes", () => {
  function setup() {
    const read = vi.fn(async () => ({ entries: rows("a -b"), revision: "saved" }));
    const write = vi.fn(async (_entries: Row[], _revision: string) => ({ backupTimestamp: 100, revision: "saved" }));
    const restore = vi.fn(async () => ({ backupTimestamp: 101, revision: "restored" }));
    const undo = vi.fn(async (_timestamp: number, _revision: string) => ({ backupTimestamp: 102, revision: "undone" }));
    const hook = renderHook(() => {
      const editor = useConfigFileEditor<Row>({
        ...model, file: "/etc/test.conf",
        describeChanges: (before, after) => ids(before) === ids(after) ? [] : ["Changed entries"],
        read,
        reload: async () => { const fresh = await read(); editor.applyRead(fresh.entries, fresh.revision); },
        write, restore, undo, savedTitle: "Saved", notSavedAnnouncement: "Not saved",
      });
      return editor;
    });
    return { hook, read, write, restore, undo };
  }

  it("refuses a save without a loaded revision", async () => {
    const { hook, write } = setup();
    await act(() => hook.result.current.save(rows("a b")));
    expect(write).not.toHaveBeenCalled();
    expect(hook.result.current.saveError?.message).toMatch(/Reload/);
  });

  it("checks an overwrite against the previewed revision and preserves a newer-change error", async () => {
    const { hook, read, write } = setup();
    act(() => hook.result.current.applyRead(rows("a b"), "original"));
    read.mockResolvedValue({ entries: rows("a b c"), revision: "previewed" });
    await act(() => hook.result.current.openForceSave());
    write.mockRejectedValueOnce(new BackendError("Changed again", "config_changed", "Current revision differs"));
    await act(() => hook.result.current.forceSave());
    expect(write).toHaveBeenCalledWith(rows("a b"), "previewed");
    expect(hook.result.current.saveError).toEqual({ message: "Changed again", code: "config_changed", details: "Current revision differs" });
  });

  it("cannot overwrite when reading the current revision failed", async () => {
    const { hook, read, write } = setup();
    act(() => hook.result.current.applyRead(rows("a b"), "original"));
    read.mockRejectedValueOnce(new BackendError("Read denied", "permission_denied", "File is unreadable"));
    await act(() => hook.result.current.openForceSave());
    await act(() => hook.result.current.forceSave());
    expect(write).not.toHaveBeenCalled();
    expect(hook.result.current.outsideChange).toEqual({ status: "failed", message: "Read denied", details: "File is unreadable" });
  });

  it("keeps Undo checked when an outside edit refuses it and the user retries", async () => {
    const { hook, undo, restore } = setup();
    act(() => {
      hook.result.current.applyRead(rows("a b"), "original");
      hook.result.current.setEntries(rows("a -b"));
    });
    await act(() => hook.result.current.save());
    undo.mockRejectedValue(new BackendError("Changed outside", "config_changed", "Saved revision no longer matches"));
    await act(() => hook.result.current.undo());
    expect(hook.result.current.restoreError?.details).toBe("Saved revision no longer matches");
    await act(() => hook.result.current.retryRestore());
    expect(undo.mock.calls).toEqual([[100, "saved"], [100, "saved"]]);
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not let an older overwrite read replace the latest preview", async () => {
    const { hook, read, write } = setup();
    act(() => hook.result.current.applyRead(rows("a b"), "original"));
    let finish!: (snapshot: { entries: Row[]; revision: string }) => void;
    read.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let first!: Promise<void>;
    act(() => { first = hook.result.current.openForceSave(); });
    act(() => hook.result.current.closeForceSave());
    read.mockResolvedValueOnce({ entries: rows("a b c"), revision: "newer" });
    await act(() => hook.result.current.openForceSave());
    await act(async () => { finish({ entries: rows("a"), revision: "older" }); await first; });
    await act(() => hook.result.current.forceSave());
    expect(write).toHaveBeenCalledWith(rows("a b"), "newer");
  });
});

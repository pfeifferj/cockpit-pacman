import { useCallback, useMemo, useRef, useState } from "react";
import { BackendError, parseErrorCode, type ErrorCode } from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { plural } from "../utils";

export interface LastWrite {
  title: string;
  /** Restoring this backup undoes the write; null when the backend made none. */
  backupTimestamp: number | null;
  revision?: string;
}

export interface WriteResult {
  backupTimestamp: number | null;
  revision?: string;
}

export interface EntryModel<T> {
  key(entry: T): string;
  /** Name used in change descriptions, such as "[core]" or a mirror URL. */
  label(entry: T): string;
  /** Whether two versions of one entry are equal in every edited field. */
  same(a: T, b: T): boolean;
  /** Replay draft edits on fresh; name conflicting fields in skipped. */
  merge(base: T, draft: T, fresh: T): { entry: T; skipped: string[] };
}

export interface ConfigFileEditorOptions<T> extends EntryModel<T> {
  /** Absolute path of the file, as shown to the user. */
  file: string;
  describeChanges(before: T[], after: T[]): string[];
  /** Reads the file without touching editor state, for the force-save preview. */
  read(): Promise<{ entries: T[]; revision: string }>;
  /** The view's quiet reload; it must call applyRead on success. */
  reload(): Promise<void>;
  write(entries: T[], expectedRevision: string): Promise<WriteResult>;
  restore(timestamp: number): Promise<WriteResult>;
  undo(timestamp: number, savedRevision: string): Promise<WriteResult>;
  savedTitle: string;
  notSavedAnnouncement: string;
  /** Examples completing "for example ..." in outside-change notices. */
  changeSources?: string;
  /** Runs after writes and outside changes, for example to refresh backups. */
  onWritten?(): void;
}

export interface Reapplied {
  applied: number;
  skipped: string[];
  /** The file changed under the editor and was reloaded without being asked. */
  outside: boolean;
}

/** A change read from the file while there were no pending edits. */
export interface OutsideNotice {
  at: Date;
  changes: string[];
}

export interface RestoreConflict {
  timestamp: number;
  title: string;
  changes: string[];
}

export interface RestoreFailure {
  message: string;
  code?: ErrorCode;
  details?: string;
  savedRevision?: string;
  timestamp: number;
  title: string;
}

export type OutsideChange =
  | { status: "loading" }
  | { status: "ready"; changes: string[]; revision: string }
  | { status: "failed"; message: string; details?: string };

interface PendingRebase<T> {
  base: T[];
  // null: the draft as it is when the read lands.
  draft: T[] | null;
  report: boolean;
  // Reload after an outside change: an unchanged revision leaves everything as is.
  outside?: boolean;
}

function pick<V>(base: V, draft: V, fresh: V): { value: V; conflict: boolean } {
  if (draft === base) return { value: fresh, conflict: false };
  if (fresh === base || fresh === draft) return { value: draft, conflict: false };
  return { value: fresh, conflict: true };
}

/** Field-level three-way pick for EntryModel.merge implementations. */
export const mergeField = pick;

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** Replay nonconflicting edits and ordering changes from base onto fresh. */
export function rebaseEntries<T>(
  base: T[],
  draft: T[],
  fresh: T[],
  model: EntryModel<T>,
): { entries: T[]; skipped: string[] } {
  const { key, label } = model;
  const baseBy = new Map(base.map((e) => [key(e), e]));
  const draftBy = new Map(draft.map((e) => [key(e), e]));
  const freshBy = new Map(fresh.map((e) => [key(e), e]));
  const merged = new Map<string, T>();
  const skipped: string[] = [];

  for (const f of fresh) {
    const k = key(f);
    const b = baseBy.get(k);
    const d = draftBy.get(k);
    if (!b) {
      merged.set(k, f);
    } else if (!d) {
      if (!model.same(b, f)) {
        skipped.push(`Remove ${label(b)}: it changed since you started editing`);
        merged.set(k, f);
      }
    } else {
      const result = model.merge(b, d, f);
      skipped.push(...result.skipped);
      merged.set(k, result.entry);
    }
  }
  for (const d of draft) {
    const k = key(d);
    if (freshBy.has(k)) continue;
    const b = baseBy.get(k);
    if (!b) merged.set(k, d);
    else if (!model.same(b, d)) skipped.push(`Changes to ${label(d)}: it was removed since you started editing`);
  }

  const common = (seq: T[]) => seq.map(key).filter((k) => baseBy.has(k) && draftBy.has(k) && freshBy.has(k));
  const baseOrder = common(base);
  const draftOrder = common(draft);
  const freshOrder = common(fresh);
  const userMoved = !sameOrder(draftOrder, baseOrder);
  const outsideMoved = !sameOrder(freshOrder, baseOrder);
  if (userMoved && outsideMoved && !sameOrder(draftOrder, freshOrder)) {
    skipped.push("Reorder: the order changed since you started editing");
  }
  const [primary, secondary] = userMoved && !outsideMoved ? [draft, fresh] : [fresh, draft];
  const order = primary.map(key).filter((k) => merged.has(k));
  const placed = new Set(order);
  // Each missing entry goes in front of its successor in the other order.
  let successor: string | null = null;
  for (const k of secondary.map(key).reverse()) {
    if (merged.has(k) && !placed.has(k)) {
      order.splice(successor === null ? order.length : order.indexOf(successor), 0, k);
      placed.add(k);
    }
    if (placed.has(k)) successor = k;
  }

  return { entries: order.map((k) => merged.get(k) as T), skipped };
}

export function outsideChangeSummary(file: string, applied: number, skipped: number): string {
  const parts = [`${file} changed since you started editing.`];
  if (applied > 0) parts.push(`Your ${plural(applied, "change")} ${applied === 1 ? "was" : "were"} reapplied.`);
  if (skipped > 0) parts.push(`${plural(skipped, "change")} no longer ${skipped === 1 ? "applies" : "apply"}.`);
  return parts.join(" ");
}

/** Delete backups; return combined failures or null. */
export async function deleteBackups(
  timestamps: number[],
  remove: (timestamp: number) => Promise<unknown>,
): Promise<string | null> {
  const results = await Promise.allSettled(timestamps.map((ts) => remove(ts)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length === 0) return null;
  const detail = failures.map(({ reason }) => reason instanceof BackendError && reason.details
    ? `${reason.message}: ${reason.details}`
    : reason instanceof Error ? reason.message : String(reason)).join("; ");
  return timestamps.length === 1
    ? detail
    : `${failures.length} of ${timestamps.length} backups were not deleted: ${detail}`;
}

export function useConfigFileEditor<T>(options: ConfigFileEditorOptions<T>) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const announce = useAnnounce();

  const [loaded, setLoadedState] = useState<T[] | null>(null);
  const loadedRef = useRef<T[] | null>(null);
  const [entries, setEntriesState] = useState<T[]>([]);
  const entriesRef = useRef<T[]>([]);
  const [revision, setRevisionState] = useState<string | undefined>(undefined);
  const revisionRef = useRef<string | undefined>(undefined);
  const writingRef = useRef(false);
  const forceReadRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; code: ErrorCode | undefined; details?: string } | null>(null);
  const [lastWrite, setLastWrite] = useState<LastWrite | null>(null);
  const [discarded, setDiscarded] = useState<T[] | null>(null);
  const [reapplied, setReapplied] = useState<Reapplied | null>(null);
  const [restoreError, setRestoreError] = useState<RestoreFailure | null>(null);
  const [outsideChange, setOutsideChange] = useState<OutsideChange | null>(null);
  const [outsideNotice, setOutsideNotice] = useState<OutsideNotice | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshErrorDetails, setRefreshErrorDetails] = useState<string | undefined>();
  const [restoreConflict, setRestoreConflict] = useState<RestoreConflict | null>(null);
  const pendingRebaseRef = useRef<PendingRebase<T> | null>(null);
  // The rebase that was in effect when a reread failed, repeated by retryRefresh.
  const failedRebaseRef = useRef<PendingRebase<T> | null>(null);

  const setLoaded = useCallback((next: T[] | null) => {
    loadedRef.current = next;
    setLoadedState(next);
  }, []);

  const setRevision = useCallback((next: string | undefined) => {
    revisionRef.current = next;
    setRevisionState(next);
  }, []);

  const setEntries = useCallback((update: T[] | ((prev: T[]) => T[])) => {
    const next = typeof update === "function" ? update(entriesRef.current) : update;
    entriesRef.current = next;
    setEntriesState(next);
  }, []);

  /** decorate preserves view-only fields, such as mirror status, across reads. */
  const applyRead = useCallback((
    fresh: T[],
    freshRevision: string | null | undefined,
    decorate?: (next: T[], prev: T[]) => T[],
  ) => {
    const pending = pendingRebaseRef.current;
    pendingRebaseRef.current = null;
    const prev = entriesRef.current;
    let draft = fresh;
    if (pending?.outside) {
      if (freshRevision && freshRevision === revisionRef.current) {
        setRefreshError(null);
        return;
      }
      const opts = optionsRef.current;
      setLastWrite(null);
      if (opts.describeChanges(pending.base, prev).length > 0) {
        const result = rebaseEntries(pending.base, prev, fresh, opts);
        draft = result.entries;
        const applied = opts.describeChanges(fresh, draft).length;
        setOutsideNotice(null);
        setReapplied({ applied, skipped: result.skipped, outside: true });
        announce(outsideChangeSummary(opts.file, applied, result.skipped.length));
      } else {
        setOutsideNotice({ at: new Date(), changes: opts.describeChanges(pending.base, fresh) });
        announce(`${opts.file} changed. The table shows the file as it is now.`);
      }
      opts.onWritten?.();
    } else if (pending) {
      const from = pending.draft ?? prev;
      if (pending.report || from !== pending.base) {
        const result = rebaseEntries(pending.base, from, fresh, optionsRef.current);
        draft = result.entries;
        if (pending.report) {
          setReapplied({
            applied: optionsRef.current.describeChanges(fresh, draft).length,
            skipped: result.skipped,
            outside: false,
          });
        }
      }
    }
    setLoaded(fresh);
    setRevision(freshRevision || undefined);
    setSaveError(null);
    setRefreshError(null);
    failedRebaseRef.current = null;
    setDiscarded(null);
    setEntries(decorate ? decorate(draft, prev) : draft);
  }, [setEntries, setLoaded, setRevision, announce]);

  const clear = useCallback(() => {
    pendingRebaseRef.current = null;
    failedRebaseRef.current = null;
    setRefreshError(null);
    setOutsideNotice(null);
    setLoaded(null);
    setRevision(undefined);
    setEntries([]);
  }, [setEntries, setLoaded, setRevision]);

  /** Preserve a loaded draft on read failure; return false when nothing was loaded. */
  const readFailed = useCallback((error: unknown): boolean => {
    const pending = pendingRebaseRef.current;
    pendingRebaseRef.current = null;
    if (loadedRef.current === null) return false;
    failedRebaseRef.current = pending;
    setRefreshError(error instanceof Error ? error.message : String(error));
    setRefreshErrorDetails(error instanceof BackendError ? error.details : undefined);
    return true;
  }, []);

  const retryRefresh = async () => {
    if (writingRef.current) return;
    pendingRebaseRef.current = failedRebaseRef.current;
    try {
      await optionsRef.current.reload();
    } finally {
      pendingRebaseRef.current = null;
    }
  };

  const pendingChanges = useMemo(
    () => options.describeChanges(loaded ?? [], entries),
    // describeChanges is a module-level function in both views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, entries],
  );
  const hasChanges = pendingChanges.length > 0;
  const writing = saving || restoring !== null;

  const startWrite = () => {
    setSaveError(null);
    setOutsideNotice(null);
    setRestoreConflict(null);
    setLastWrite(null);
    setDiscarded(null);
    setReapplied(null);
    setRestoreError(null);
  };

  const writeEntries = async (list: T[], expectedRevision: string | undefined) => {
    if (writingRef.current) return;
    if (!expectedRevision) {
      setSaveError({ message: "Reload the file before saving.", code: undefined });
      return;
    }
    const opts = optionsRef.current;
    setOutsideChange(null);
    startWrite();
    setSaving(true);
    writingRef.current = true;
    try {
      const result = await opts.write(list, expectedRevision);
      // Edits made while the write was in flight are replayed on the reread file.
      pendingRebaseRef.current = { base: list, draft: null, report: false };
      await opts.reload();
      setLastWrite({ title: opts.savedTitle, ...result });
      opts.onWritten?.();
    } catch (ex) {
      const message = ex instanceof Error ? ex.message : String(ex);
      setSaveError({ message, code: ex instanceof BackendError ? ex.code : parseErrorCode(message), details: ex instanceof BackendError ? ex.details : undefined });
      announce(opts.notSavedAnnouncement, { assertive: true });
    } finally {
      pendingRebaseRef.current = null;
      writingRef.current = false;
      setSaving(false);
    }
  };

  const save = (list?: T[]) => writeEntries(list ?? entriesRef.current, revisionRef.current);

  const forceSave = () => {
    if (outsideChange?.status !== "ready") return;
    return writeEntries(entriesRef.current, outsideChange.revision);
  };

  const openForceSave = async () => {
    if (writingRef.current) return;
    const request = ++forceReadRef.current;
    const base = loaded ?? [];
    setOutsideChange({ status: "loading" });
    try {
      const fresh = await optionsRef.current.read();
      if (request !== forceReadRef.current) return;
      if (!fresh.revision) throw new Error("The file revision could not be read.");
      setOutsideChange((current) => current && {
        status: "ready",
        revision: fresh.revision,
        changes: optionsRef.current.describeChanges(base, fresh.entries),
      });
    } catch (ex) {
      if (request !== forceReadRef.current) return;
      setOutsideChange((current) => current && {
        status: "failed",
        message: ex instanceof Error ? ex.message : String(ex),
        details: ex instanceof BackendError ? ex.details : undefined,
      });
    }
  };

  const closeForceSave = () => {
    forceReadRef.current++;
    setOutsideChange(null);
  };

  /** Rebase pending edits on outside changes; ignore an unchanged revision. */
  const refreshFromOutside = useCallback(async () => {
    if (writingRef.current || loadedRef.current === null || pendingRebaseRef.current) return;
    const pending: PendingRebase<T> = { base: loadedRef.current, draft: null, report: false, outside: true };
    pendingRebaseRef.current = pending;
    try {
      await optionsRef.current.reload();
    } finally {
      if (pendingRebaseRef.current === pending) pendingRebaseRef.current = null;
    }
  }, []);

  const reapply = async () => {
    pendingRebaseRef.current = { base: loaded ?? [], draft: entriesRef.current, report: true };
    setReapplied(null);
    try {
      await optionsRef.current.reload();
    } finally {
      pendingRebaseRef.current = null;
    }
  };

  const discard = () => {
    if (!hasChanges) return;
    setDiscarded(entriesRef.current);
    setLastWrite(null);
    setReapplied(null);
    setEntries(loaded ?? []);
  };

  const undoDiscard = () => {
    if (discarded === null) return;
    setEntries(discarded);
    setDiscarded(null);
  };

  /** Undo uses savedRevision; explicit restores confirm detected outside edits. */
  const restoreFrom = async (timestamp: number, title: string, confirmed = false, savedRevision?: string) => {
    if (writingRef.current) return;
    writingRef.current = true;
    setRestoring(timestamp);
    const opts = optionsRef.current;
    if (!confirmed && !savedRevision && loadedRef.current !== null) {
      setRestoreConflict(null);
      let changes: string[] = [];
      try {
        changes = opts.describeChanges(loadedRef.current, (await opts.read()).entries);
      } catch {
        // A restore backs up the current file before replacing it.
      }
      if (changes.length > 0) {
        setRestoreConflict({ timestamp, title, changes });
        writingRef.current = false;
        setRestoring(null);
        return;
      }
    }
    startWrite();
    setRestoring(timestamp);
    writingRef.current = true;
    try {
      const result = await (savedRevision ? opts.undo(timestamp, savedRevision) : opts.restore(timestamp));
      await opts.reload();
      setLastWrite({ title, ...result });
      opts.onWritten?.();
    } catch (ex) {
      setRestoreError({ message: ex instanceof Error ? ex.message : String(ex), code: ex instanceof BackendError ? ex.code : undefined, details: ex instanceof BackendError ? ex.details : undefined, timestamp, title, savedRevision });
      announce(`${opts.file} not restored`, { assertive: true });
    } finally {
      writingRef.current = false;
      setRestoring(null);
    }
  };

  const undo = () => {
    if (lastWrite?.backupTimestamp == null || !lastWrite.revision || hasChanges) return;
    return restoreFrom(lastWrite.backupTimestamp, `Undid the ${options.file} change`, false, lastWrite.revision);
  };

  const retryRestore = () => {
    if (restoreError) return restoreFrom(restoreError.timestamp, restoreError.title, false, restoreError.savedRevision);
  };

  const confirmRestore = () => {
    if (restoreConflict) return restoreFrom(restoreConflict.timestamp, restoreConflict.title, true);
  };

  const baseByKey = useMemo(
    () => new Map((loaded ?? []).map((e) => [options.key(e), e])),
    // key is a module-level function in both views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded],
  );

  const isEdited = (entry: T): boolean => {
    const base = baseByKey.get(options.key(entry));
    return !base || !options.same(base, entry);
  };

  const revert = (entryKey: string) => {
    const base = baseByKey.get(entryKey);
    setEntries((prev) => base
      ? prev.map((e) => (options.key(e) === entryKey ? { ...e, ...base } : e))
      : prev.filter((e) => options.key(e) !== entryKey));
  };

  return {
    file: options.file,
    loaded,
    entries,
    setEntries,
    revision,
    applyRead,
    clear,
    readFailed,
    refreshError,
    refreshErrorDetails,
    retryRefresh,
    outsideNotice,
    dismissOutsideNotice: () => setOutsideNotice(null),
    changeSources: options.changeSources ?? "another program",
    pendingChanges,
    hasChanges,
    saving,
    restoring,
    writing,
    lockReason: writing ? `${options.file} is being written` : null,
    saveError,
    configChanged: saveError?.code === "config_changed",
    lastWrite,
    dismissLastWrite: () => setLastWrite(null),
    discarded,
    discard,
    undoDiscard,
    dismissDiscarded: () => setDiscarded(null),
    reapplied,
    reapply,
    refreshFromOutside,
    dismissReapplied: () => setReapplied(null),
    restoreError,
    retryRestore,
    dismissRestoreError: () => setRestoreError(null),
    outsideChange,
    openForceSave,
    closeForceSave,
    save,
    forceSave,
    restoreFrom,
    restoreConflict,
    confirmRestore,
    cancelRestore: () => setRestoreConflict(null),
    undo,
    isEdited,
    revert,
  };
}

export type ConfigFileEditor<T> = ReturnType<typeof useConfigFileEditor<T>>;

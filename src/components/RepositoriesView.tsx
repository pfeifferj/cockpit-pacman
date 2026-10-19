import { BackupWarnings } from "./BackupWarnings";
import { ErrorDetails } from "./ErrorDetails";
import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from "react";
import {
  Card,
  CardBody,
  Button,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Flex,
  FlexItem,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Switch,
  FormSelect,
  FormSelectOption,
  Label,
  TextInput,
  AlertActionLink,
  ExpandableSection,
  Divider,
  Dropdown,
  DropdownList,
  Alert,
  Checkbox,
  FormHelperText,
  HelperText,
  HelperTextItem,
} from "@patternfly/react-core";
import {
  GlobeIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  TrashIcon,
  AngleRightIcon,
  AngleDownIcon,
  UndoIcon,
} from "@patternfly/react-icons";
import {
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
} from "@patternfly/react-table";
import { StatBox } from "./StatBox";
import { helpInfo } from "./HelpPopover";
import { kebabToggle } from "./KebabToggle";
import { ConfigFileText } from "./MirrorsView";
import {
  BackendError,
  type ErrorCode,
  KeyringKey,
  RepoEntry,
  RepoBackup,
  ListReposResponse,
  listInstalled,
  listRepos,
  saveRepos,
  listRepoBackups,
  restoreRepoBackup,
  undoRepoSave,
  deleteRepoBackup,
  formatSize,
} from "../api";
import { plural, sanitizeErrorMessage } from "../utils";
import { useRoute } from "../hooks/useRoute";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useMutationGate } from "../hooks/useMutationGate";
import { useRefreshOnActivate, useTabActive } from "../hooks/useRefreshOnActivate";
import { watchFile } from "../systemWatch";
import { GatedButton, GatedDropdownItem } from "./GatedButton";
import { ConfirmModal } from "./ConfirmModal";
import { useBackdropClose } from "../hooks/useBackdropClose";
import {
  useConfigFileEditor,
  mergeField,
  deleteBackups,
  type EntryModel,
} from "../hooks/useConfigFileEditor";
import { LoadErrorState } from "./LoadErrorState";
import { TimeAgo } from "./TimeAgo";
import { ConfigWriteAlerts, ConfigPendingChanges, RestoreGuardModal } from "./ConfigWriteAlerts";
import {
  AddRepositoryModal,
  AlsoSavedChanges,
  InsecureSigLevelAck,
  SIG_LEVEL_OPTIONS,
  directiveValueProblem,
  isInsecureSigLevel,
  repoSectionText,
} from "./AddRepositoryModal";
import { keyName } from "./ImportKeyModal";
import { RowSelectCell } from "./RowSelectCell";

type ViewState = "loading" | "ready" | "error";

const CONF_PATH = "/etc/pacman.conf";

function hasPackageSource(repos: RepoEntry[]): boolean {
  return repos.some((r) => r.enabled && r.directives.some((d) => d.enabled));
}

function directiveKey(d: RepoEntry["directives"][number]): string {
  return `${d.directive_type} ${d.value}`;
}

// Describe only moved repos, excluding neighbors displaced by the move.
function stableIndices(seq: number[]): Set<number> {
  const length = seq.map(() => 1);
  const prev = seq.map(() => -1);
  let best = -1;
  for (let i = 0; i < seq.length; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j] < seq[i] && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1;
        prev[i] = j;
      }
    }
    if (best < 0 || length[i] > length[best]) best = i;
  }
  const keep = new Set<number>();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/** Insert after enabled repositories, skipping the [repo-name] template. */
export function addInsertion(list: RepoEntry[]): { at: number; after: string | null } {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].enabled && list[i].name !== "repo-name") {
      return { at: i + 1, after: list[i].name };
    }
  }
  return { at: list.length, after: null };
}

export function describeRepoChanges(before: RepoEntry[], after: RepoEntry[]): string[] {
  const visible = (list: RepoEntry[]) => list.filter((r) => r.name !== "repo-name");
  const base = visible(before);
  const next = visible(after);
  const baseByName = new Map(base.map((r) => [r.name, r]));
  const nextNames = new Set(next.map((r) => r.name));
  const changes: string[] = [];

  for (const repo of next) {
    const old = baseByName.get(repo.name);
    if (!old) {
      changes.push(`Add [${repo.name}]`);
      continue;
    }
    if (old.enabled !== repo.enabled) {
      changes.push(`${repo.enabled ? "Enable" : "Disable"} [${repo.name}]`);
    }
    if ((old.sig_level || "") !== (repo.sig_level || "")) {
      changes.push(repo.sig_level
        ? `Set SigLevel of [${repo.name}] to ${repo.sig_level}`
        : `Reset SigLevel of [${repo.name}] to the default`);
    }
    const oldDirectives = new Map(old.directives.map((d) => [directiveKey(d), d]));
    const newKeys = new Set(repo.directives.map(directiveKey));
    for (const d of repo.directives) {
      const was = oldDirectives.get(directiveKey(d));
      if (!was) {
        changes.push(`Add ${directiveKey(d)} to [${repo.name}]`);
      } else if (was.enabled !== d.enabled) {
        changes.push(`${d.enabled ? "Enable" : "Disable"} ${directiveKey(d)} in [${repo.name}]`);
      }
    }
    for (const d of old.directives) {
      if (!newKeys.has(directiveKey(d))) {
        changes.push(`Remove ${directiveKey(d)} from [${repo.name}]`);
      }
    }
  }

  for (const repo of base) {
    if (!nextNames.has(repo.name)) changes.push(`Remove [${repo.name}]`);
  }

  const order = next.filter((r) => baseByName.has(r.name));
  const baseIndex = new Map(base.map((r, i) => [r.name, i]));
  const stable = stableIndices(order.map((r) => baseIndex.get(r.name) ?? 0));
  order.forEach((repo, i) => {
    if (stable.has(i)) return;
    const below = order[i + 1];
    changes.push(below
      ? `Move [${repo.name}] above [${below.name}]`
      : `Move [${repo.name}] below [${order[i - 1]?.name}]`);
  });

  return changes;
}

function sameDirectives(a: RepoEntry["directives"], b: RepoEntry["directives"]): boolean {
  return a.length === b.length
    && a.every((d, i) => directiveKey(d) === directiveKey(b[i]) && d.enabled === b[i].enabled);
}

export const repoModel: EntryModel<RepoEntry> = {
  key: (r) => r.name,
  label: (r) => `[${r.name}]`,
  same: (a, b) =>
    a.enabled === b.enabled
    && (a.sig_level || "") === (b.sig_level || "")
    && sameDirectives(a.directives, b.directives),
  merge(base, draft, fresh) {
    const name = `[${fresh.name}]`;
    const conflict = (change: string) => `${change}: it changed outside this page`;
    const skipped: string[] = [];

    const enabled = mergeField(base.enabled, draft.enabled, fresh.enabled);
    if (enabled.conflict) skipped.push(conflict(`${draft.enabled ? "Enable" : "Disable"} ${name}`));
    const sig = mergeField(base.sig_level || "", draft.sig_level || "", fresh.sig_level || "");
    if (sig.conflict) {
      skipped.push(conflict(draft.sig_level
        ? `Set SigLevel of ${name} to ${draft.sig_level}`
        : `Reset SigLevel of ${name} to the default`));
    }

    const baseDirectives = new Map(base.directives.map((d) => [directiveKey(d), d]));
    const draftKeys = new Set(draft.directives.map(directiveKey));
    let directives = fresh.directives.map((d) => ({ ...d }));
    const find = (key: string) => directives.find((d) => directiveKey(d) === key);
    for (const d of draft.directives) {
      const key = directiveKey(d);
      const was = baseDirectives.get(key);
      const now = find(key);
      if (!was) {
        if (!now) directives.push({ ...d });
      } else if (was.enabled !== d.enabled) {
        const change = `${d.enabled ? "Enable" : "Disable"} ${key} in ${name}`;
        if (!now) skipped.push(`${change}: the line was removed outside this page`);
        else if (now.enabled === was.enabled) now.enabled = d.enabled;
        else if (now.enabled !== d.enabled) skipped.push(conflict(change));
      }
    }
    for (const was of base.directives) {
      const key = directiveKey(was);
      if (draftKeys.has(key)) continue;
      const now = find(key);
      if (!now) continue;
      if (now.enabled === was.enabled) directives = directives.filter((d) => d !== now);
      else skipped.push(conflict(`Remove ${key} from ${name}`));
    }

    return {
      entry: { ...fresh, enabled: enabled.value, sig_level: sig.value || null, directives },
      skipped,
    };
  },
};

const KNOWN_SIG_LEVELS = new Set(SIG_LEVEL_OPTIONS.map((o) => o.value));
const PARSED_CUSTOM = "__parsed__";
const ENTER_CUSTOM = "__custom__";

const ARCH_REPOS = new Set(["core", "extra", "multilib", "core-testing", "extra-testing", "multilib-testing"]);

type RemovePackages =
  | { status: "loading" }
  | { status: "ready"; names: string[]; total: number }
  | { status: "disabled" }
  | { status: "failed"; message: string };

const REMOVE_LIST_LIMIT = 20;

/** An add or remove whose save is in flight or has just landed. */
interface RepoWrite {
  kind: "add" | "remove";
  name: string;
  /** The save's result title; it identifies the write in editor.lastWrite. */
  title: string;
  /** User id or fingerprint of the key signed for an added repository. */
  signedKey: string | null;
}

function repoRows(table: HTMLElement | null): HTMLElement[] {
  return Array.from(table?.querySelectorAll<HTMLElement>("tr[data-repo]") ?? []);
}

function repoRow(table: HTMLElement | null, name: string): HTMLElement | undefined {
  return repoRows(table).find((row) => row.dataset.repo === name);
}

function insecureAckKey(name: string, sigLevel: string): string {
  return `${name}\n${sigLevel}`;
}

export const RepositoriesView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<ErrorCode | undefined>();
  const [errorDetails, setErrorDetails] = useState<string | undefined>();
  const [operationWarnings, setOperationWarnings] = useState<string[]>([]);
  const [backupWarnings, setBackupWarnings] = useState<string[]>([]);
  const [backupErrorDetails, setBackupErrorDetails] = useState<string | undefined>();
  const [searchFilter, setSearchFilter] = useState("");
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [newDirectiveTypes, setNewDirectiveTypes] = useState<
    Record<string, "Server" | "Include">
  >({});
  const [newDirectiveValues, setNewDirectiveValues] = useState<
    Record<string, string>
  >({});
  const [backups, setBackups] = useState<RepoBackup[]>([]);
  const [backupsExpanded, setBackupsExpanded] = useState(false);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const backupCountRef = useRef(0);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [selectedBackups, setSelectedBackups] = useState<Set<number>>(new Set());
  const [deletingBackups, setDeletingBackups] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<number[] | null>(null);
  // name + SigLevel pairs whose insecure value the user confirmed.
  const [insecureAcks, setInsecureAcks] = useState<Set<string>>(new Set());
  const [notSynced, setNotSynced] = useState<Set<string>>(new Set());
  const [customEdit, setCustomEdit] = useState<{ name: string; draft: string } | null>(null);
  // Enter commits and unmounts the input, which can also fire blur.
  const customEditRef = useRef<string | null>(null);
  const [openKebab, setOpenKebab] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addButtonRef = useRef<React.ComponentRef<"button">>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removePackages, setRemovePackages] = useState<RemovePackages>({ status: "loading" });
  const removeRequestRef = useRef(0);
  const pendingWriteRef = useRef<RepoWrite | null>(null);
  const [repoWrite, setRepoWrite] = useState<RepoWrite | null>(null);
  // Focus target applied once the dialog that triggered it has unmounted.
  const focusAfterCloseRef = useRef<(() => void) | null>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const { navigate } = useRoute();
  const [fileTextExpanded, setFileTextExpanded] = useState(false);
  const [fileReloadKey, setFileReloadKey] = useState(0);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const permission = useAdminPermission();
  const saveGate = useMutationGate("save repositories", { permission });
  const restoreGate = useMutationGate("restore pacman.conf", { permission });
  const deleteBackupGate = useMutationGate("delete backups", { permission });
  const keyGate = useMutationGate("add keys", { permission });
  const lockId = useId();
  const selectAllId = useId();

  const editor = useConfigFileEditor<RepoEntry>({
    ...repoModel,
    file: CONF_PATH,
    describeChanges: describeRepoChanges,
    read: async () => {
      const result = await listRepos();
      return { entries: result.repos, revision: result.revision };
    },
    reload: (): Promise<void> => loadRepos({ quiet: true }),
    write: async (list, expectedRevision) => {
      const result = await saveRepos(list, expectedRevision);
      setOperationWarnings(result.warnings ?? []);
      return { backupTimestamp: result.backup_timestamp, revision: result.revision };
    },
    restore: async (timestamp) => {
      const result = await restoreRepoBackup(timestamp);
      setOperationWarnings(result.warnings ?? []);
      return { backupTimestamp: result.backup_timestamp, revision: result.revision ?? undefined };
    },
    undo: async (timestamp, revision) => {
      const result = await undoRepoSave(timestamp, revision);
      setOperationWarnings(result.warnings ?? []);
      return { backupTimestamp: result.backup_timestamp, revision: result.revision };
    },
    get savedTitle() {
      return pendingWriteRef.current?.title ?? `Saved ${CONF_PATH}`;
    },
    notSavedAnnouncement: "Repositories not saved",
    changeSources: "IgnorePkg from Updates, or another program",
    onWritten: () => refreshBackupList(),
  });
  const { applyRead, clear: clearEditor, readFailed, refreshFromOutside } = editor;
  const tabActive = useTabActive();

  useRefreshOnActivate(() => {
    refreshFromOutside();
  });

  useEffect(() => {
    if (!tabActive) return;
    const watch = watchFile(CONF_PATH, () => {
      refreshFromOutside();
    });
    return () => watch?.close();
  }, [tabActive, refreshFromOutside]);
  const repos = editor.entries;
  const setRepos = editor.setEntries;
  const lock = editor.lockReason;
  const lockProps = lock ? { "aria-disabled": true, "aria-describedby": lockId } : {};

  useBackdropClose(deleteTargets !== null, () => setDeleteTargets(null));
  useBackdropClose(removeTarget !== null, () => setRemoveTarget(null));

  const loadRepos = useCallback(async (options?: { quiet?: boolean }): Promise<void> => {
    if (!options?.quiet) setState("loading");
    setError(null);
    setFileReloadKey((k) => k + 1);
    try {
      const response: ListReposResponse = await listRepos();
      applyRead(response.repos, response.revision);
      setNotSynced(new Set(response.not_synced ?? []));
      setState("ready");
    } catch (ex) {
      const message = ex instanceof Error ? ex.message : String(ex);
      if (readFailed(ex)) {
        setState("ready");
        return;
      }
      clearEditor();
      setState("error");
      setError(message);
      setErrorDetails(ex instanceof BackendError ? ex.details : undefined);
      setLoadErrorCode(ex instanceof BackendError ? ex.code : undefined);
    }
  }, [applyRead, clearEditor, readFailed]);

  useEffect(() => {
    let cancelled = false;
    listRepos()
      .then((response: ListReposResponse) => {
        if (cancelled) return;
        applyRead(response.repos, response.revision);
        setNotSynced(new Set(response.not_synced ?? []));
        setState("ready");
      })
      .catch((ex) => {
        if (cancelled) return;
        setState("error");
        setError(ex instanceof Error ? ex.message : String(ex));
        setErrorDetails(ex instanceof BackendError ? ex.details : undefined);
        setLoadErrorCode(ex instanceof BackendError ? ex.code : undefined);
      });
    return () => { cancelled = true; };
  }, [applyRead]);

  const loadBackups = useCallback(async () => {
    setBackupsLoading(true);
    setBackupError(null);
    try {
      const response = await listRepoBackups();
      backupCountRef.current = response.backups.length;
      setBackups(response.backups);
      setBackupWarnings(response.warnings ?? []);
      setBackupErrorDetails(undefined);
      setSelectedBackups((prev) => new Set(response.backups.map((b) => b.timestamp).filter((ts) => prev.has(ts))));
    } catch (ex) {
      setBackupError(ex instanceof Error ? ex.message : String(ex));
      setBackupErrorDetails(ex instanceof BackendError ? ex.details : undefined);
      backupCountRef.current = 0;
      setBackups([]);
    } finally {
      setBackupsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (backupsExpanded && backupCountRef.current === 0) {
      loadBackups();
    }
  }, [backupsExpanded, loadBackups]);

  const handleBackupsToggle = (_event: React.MouseEvent, expanded: boolean) => {
    setBackupsExpanded(expanded);
  };

  const refreshBackupList = () => {
    if (backupsExpanded) {
      loadBackups();
    } else {
      backupCountRef.current = 0;
      setBackups([]);
    }
  };

  const handleSave = () => {
    pendingWriteRef.current = null;
    return editor.save();
  };

  const lastWrite = editor.lastWrite;
  useEffect(() => {
    const pending = pendingWriteRef.current;
    if (!pending || lastWrite?.title !== pending.title) return;
    pendingWriteRef.current = null;
    setRepoWrite(pending);
    if (pending.kind === "add") repoRow(tableWrapRef.current, pending.name)?.scrollIntoView?.({ block: "nearest" });
  }, [lastWrite]);
  const shownWrite = repoWrite && lastWrite?.title === repoWrite.title ? repoWrite : null;

  useEffect(() => {
    if (removeTarget !== null || addOpen) return;
    const focus = focusAfterCloseRef.current;
    focusAfterCloseRef.current = null;
    focus?.();
  });

  const handleDiscard = () => {
    editor.discard();
    searchWrapRef.current?.querySelector("input")?.focus();
  };

  const handleRestoreBackup = (timestamp: number) => {
    setRestoreTarget(null);
    const backup = backups.find((b) => b.timestamp === timestamp);
    return editor.restoreFrom(
      timestamp,
      backup ? `Restored ${CONF_PATH} from ${backup.date}` : `Restored ${CONF_PATH}`,
    );
  };

  const handleDeleteBackups = async (timestamps: number[]) => {
    setDeleteTargets(null);
    setDeletingBackups(true);
    setDeleteError(null);
    const warnings: string[] = [];
    const failure = await deleteBackups(timestamps, async (timestamp) => {
      const result = await deleteRepoBackup(timestamp);
      warnings.push(...(result.warnings ?? []));
    });
    setOperationWarnings(warnings);
    if (failure) setDeleteError(failure);
    await loadBackups();
    setDeletingBackups(false);
  };

  const toggleBackupSelection = (timestamp: number) => {
    setSelectedBackups((prev) => {
      const next = new Set(prev);
      if (next.has(timestamp)) next.delete(timestamp);
      else next.add(timestamp);
      return next;
    });
  };

  const handleToggleEnabled = (index: number) => {
    if (editor.writing) return;
    setRepos((prev) =>
      prev.map((r, i) => (i === index ? { ...r, enabled: !r.enabled } : r)),
    );
  };

  const handleSigLevelChange = (index: number, value: string) => {
    if (editor.writing) return;
    setRepos((prev) =>
      prev.map((r, i) =>
        i === index ? { ...r, sig_level: value || null } : r,
      ),
    );
  };

  const setInsecureAck = (name: string, sigLevel: string, checked: boolean) => {
    setInsecureAcks((prev) => {
      const next = new Set(prev);
      if (checked) next.add(insecureAckKey(name, sigLevel));
      else next.delete(insecureAckKey(name, sigLevel));
      return next;
    });
  };

  const startCustomEdit = (name: string, current: string) => {
    customEditRef.current = name;
    setCustomEdit({ name, draft: current });
  };

  const endCustomEdit = (index: number, commit: boolean) => {
    if (customEdit === null || customEditRef.current !== customEdit.name) return;
    customEditRef.current = null;
    const value = customEdit.draft.trim().split(/\s+/).join(" ");
    setCustomEdit(null);
    if (commit && value !== "" && value !== (repos[index]?.sig_level || "")) {
      handleSigLevelChange(index, value);
    }
  };

  const moveToEdge = (name: string, edge: "top" | "bottom") => {
    if (editor.writing) return;
    setRepos((prev) => {
      const from = prev.findIndex((r) => r.name === name);
      if (from < 0) return prev;
      const repo = prev[from];
      const rest = prev.filter((_, i) => i !== from);
      const visibleIdx = rest
        .map((r, i) => (r.name !== "repo-name" ? i : -1))
        .filter((i) => i >= 0);
      if (visibleIdx.length === 0) return prev;
      const at = edge === "top" ? visibleIdx[0] : visibleIdx[visibleIdx.length - 1] + 1;
      return [...rest.slice(0, at), repo, ...rest.slice(at)];
    });
  };

  const swapByName = (a: string, b: string) => {
    if (editor.writing) return;
    setRepos((prev) => {
      const next = [...prev];
      const i = next.findIndex((r) => r.name === a);
      const j = next.findIndex((r) => r.name === b);
      if (i < 0 || j < 0) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const closeAdd = () => {
    setAddOpen(false);
    focusAfterCloseRef.current = () => addButtonRef.current?.focus();
  };

  const handleAddRepository = (entry: RepoEntry, signed: KeyringKey | null) => {
    closeAdd();
    const list = editor.entries;
    const { at } = addInsertion(list);
    const next = [...list.slice(0, at), entry, ...list.slice(at)];
    if (entry.sig_level && isInsecureSigLevel(entry.sig_level)) setInsecureAck(entry.name, entry.sig_level, true);
    const signedKey = signed ? keyName(signed) : null;
    pendingWriteRef.current = {
      kind: "add",
      name: entry.name,
      title: signedKey ? `[${entry.name}] added, key for ${signedKey} locally signed` : `Added [${entry.name}]`,
      signedKey,
    };
    setRepos(next);
    editor.save(next);
  };

  const openRemove = (name: string) => {
    setRemoveTarget(name);
    const request = ++removeRequestRef.current;
    const baseline = editor.loaded?.find((r) => r.name === name);
    // pacman registers no database for a disabled section, so nothing is tracked to it.
    if (!baseline?.enabled) {
      setRemovePackages({ status: "disabled" });
      return;
    }
    setRemovePackages({ status: "loading" });
    listInstalled({ repo: name, limit: 1000, sortBy: "name" })
      .then((response) => {
        if (request !== removeRequestRef.current) return;
        setRemovePackages({ status: "ready", names: response.packages.map((p) => p.name), total: response.total });
      })
      .catch((ex) => {
        if (request !== removeRequestRef.current) return;
        setRemovePackages({ status: "failed", message: ex instanceof Error ? ex.message : String(ex) });
      });
  };

  const closeRemove = () => {
    removeRequestRef.current++;
    setRemoveTarget(null);
  };

  const handleRemoveRepository = (name: string) => {
    closeRemove();
    const shown = repoRows(tableWrapRef.current).map((row) => row.dataset.repo);
    const at = shown.indexOf(name);
    const neighbour = shown[at + 1] ?? shown[at - 1];
    focusAfterCloseRef.current = () => {
      const kebab = neighbour ? repoRow(tableWrapRef.current, neighbour)?.querySelector<HTMLElement>("[aria-label^='More actions for']") : null;
      (kebab ?? searchWrapRef.current?.querySelector("input"))?.focus();
    };
    const foreign = removePackages.status === "ready" ? removePackages.total : 0;
    pendingWriteRef.current = {
      kind: "remove",
      name,
      title: foreign > 0
        ? `Removed [${name}]; ${plural(foreign, "installed package is", "installed packages are")} now foreign`
        : `Removed [${name}]`,
      signedKey: null,
    };
    const next = editor.entries.filter((r) => r.name !== name);
    setRepos(next);
    editor.save(next);
  };

  const handleToggleExpand = (repoName: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoName)) {
        next.delete(repoName);
      } else {
        next.add(repoName);
      }
      return next;
    });
  };

  const handleToggleDirectiveEnabled = (
    repoIndex: number,
    directiveIndex: number,
  ) => {
    if (editor.writing) return;
    setRepos((prev) =>
      prev.map((r, ri) =>
        ri === repoIndex
          ? {
              ...r,
              directives: r.directives.map((d, di) =>
                di === directiveIndex ? { ...d, enabled: !d.enabled } : d,
              ),
            }
          : r,
      ),
    );
  };

  const handleRemoveDirective = (
    repoIndex: number,
    directiveIndex: number,
  ) => {
    if (editor.writing) return;
    setRepos((prev) =>
      prev.map((r, ri) =>
        ri === repoIndex
          ? {
              ...r,
              directives: r.directives.filter((_, di) => di !== directiveIndex),
            }
          : r,
      ),
    );
  };

  const handleAddDirective = (repoName: string, repoIndex: number) => {
    const dtype = newDirectiveTypes[repoName] || "Server";
    const value = newDirectiveValues[repoName]?.trim();
    if (!value || directiveValueProblem(dtype, value) || editor.writing) return;
    setRepos((prev) =>
      prev.map((r, ri) =>
        ri === repoIndex
          ? {
              ...r,
              directives: [
                ...r.directives,
                { directive_type: dtype, value, enabled: true },
              ],
            }
          : r,
      ),
    );
    setNewDirectiveValues((prev) => ({ ...prev, [repoName]: "" }));
  };

  const visibleRepos = useMemo(
    () => repos.filter((r) => r.name !== "repo-name"),
    [repos],
  );

  const enabledCount = useMemo(
    () => visibleRepos.filter((r) => r.enabled).length,
    [visibleRepos],
  );

  const pendingChanges = editor.pendingChanges;
  const hasChanges = editor.hasChanges;
  const backupWriting = editor.writing || deletingBackups;
  const backupBlockedReason = backupWriting ? `${CONF_PATH} is being written` : null;

  const baselineByName = new Map((editor.loaded ?? []).map((r) => [r.name, r]));
  const needsInsecureAck = (repo: RepoEntry): boolean =>
    !!repo.sig_level
    && isInsecureSigLevel(repo.sig_level)
    && (baselineByName.get(repo.name)?.sig_level || "") !== repo.sig_level;
  const unackedInsecure = visibleRepos.find(
    (r) => needsInsecureAck(r) && !insecureAcks.has(insecureAckKey(r.name, r.sig_level || "")),
  );
  const insecureBlockedReason = unackedInsecure
    ? `Confirm SigLevel = ${unackedInsecure.sig_level} for [${unackedInsecure.name}] first`
    : null;

  const saveBlockedReason = saveGate.blocked
    ? saveGate.reason ?? "Saving is not available"
    : !editor.revision ? "Reload pacman.conf before saving"
    : !hasPackageSource(repos)
      ? "Enable at least one repository with an active Server or Include line"
      : insecureBlockedReason;

  const handleRestoreClick = (timestamp: number) => {
    if (hasChanges) {
      setRestoreTarget(timestamp);
    } else {
      handleRestoreBackup(timestamp);
    }
  };

  const changedSectionsText = () => {
    const base = editor.loaded ?? [];
    const edited = visibleRepos.filter((r) => {
      const was = base.find((b) => b.name === r.name);
      return !was || !repoModel.same(was, r);
    });
    return (edited.length > 0 ? edited : visibleRepos).map(repoSectionText).join("\n\n");
  };

  const deleteLabel = (targets: number[]) => {
    if (targets.length !== 1) return `Delete ${targets.length} backups`;
    const backup = backups.find((b) => b.timestamp === targets[0]);
    return backup ? `Delete backup from ${backup.date}` : "Delete 1 backup";
  };
  const allBackupsSelected = backups.length > 0 && selectedBackups.size === backups.length;

  const filteredRepos = useMemo(() => {
    if (!searchFilter) return visibleRepos;
    const lower = searchFilter.toLowerCase();
    return visibleRepos.filter((r) => r.name.toLowerCase().includes(lower));
  }, [visibleRepos, searchFilter]);

  const applySearchFilter = (value: string) => setSearchFilter(value);

  const writeAlerts = (
    <>
    <BackupWarnings warnings={[...operationWarnings, ...backupWarnings]} />
    <ConfigWriteAlerts
      editor={editor}
      fileLabel="pacman.conf"
      notSavedTitle="Repositories not saved"
      saveBlockedReason={saveBlockedReason}
      restoreGate={restoreGate}
    />
    </>
  );

  if (state === "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState
            headingLevel="h2"
            icon={Spinner}
            titleText="Loading repositories"
          >
            <EmptyStateBody>
              Reading repository configuration…
            </EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "error" && repos.length === 0) {
    return (
      <Card>
        <CardBody>
          <LoadErrorState what="repositories" code={loadErrorCode} error={error} details={errorDetails} onRetry={() => loadRepos()} />
        </CardBody>
      </Card>
    );
  }

  if (repos.length === 0) {
    return (
      <Card>
        <CardBody>
          {writeAlerts}
          <EmptyState
            headingLevel="h2"
            icon={GlobeIcon}
            titleText="No repositories found"
          >
            <EmptyStateBody>
              No repository sections were found in pacman.conf.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={() => loadRepos()}>
                  Refresh
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      {writeAlerts}
    {shownWrite?.kind === "add" && (shownWrite.signedKey || notSynced.has(shownWrite.name)) && (
      <Alert
        variant="info"
        isInline
        isPlain
        title={notSynced.has(shownWrite.name)
          ? `Packages from [${shownWrite.name}] appear after the next system upgrade`
          : `Undo removes [${shownWrite.name}]; the key stays signed`}
        className="pf-v6-u-mb-md"
        actionLinks={notSynced.has(shownWrite.name) ? (
          <AlertActionLink onClick={() => navigate("updates")}>Go to Updates</AlertActionLink>
        ) : undefined}
      >
        {notSynced.has(shownWrite.name) && shownWrite.signedKey && (
          <>Undo removes [{shownWrite.name}]; the key for {shownWrite.signedKey} stays signed.</>
        )}
      </Alert>
    )}
    <span id={lockId} className="pf-v6-screen-reader">{lock}</span>
    <Card className="pf-v6-u-mb-md">
      <CardBody>
        <Flex spaceItems={{ default: "spaceItemsLg" }}>
          <FlexItem>
            <StatBox label="Total" value={(visibleRepos.length).toLocaleString()} />
          </FlexItem>
          <FlexItem>
            <StatBox label="Enabled" value={(enabledCount).toLocaleString()} color="success" />
          </FlexItem>
        </Flex>
      </CardBody>
    </Card>
    <Card>
      <CardBody>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <div ref={searchWrapRef}>
              <SearchInput
                placeholder="Search repositories…"
                value={searchFilter}
                onChange={(_event: React.SyntheticEvent, value: string) => applySearchFilter(value)}
                onClear={() => applySearchFilter("")}
                aria-label="Search repositories"
              />
              </div>
            </ToolbarItem>
            <ToolbarItem>
              <GatedButton
                ref={addButtonRef}
                gate={saveGate}
                disabledReason={lock}
                variant="secondary"
                onClick={() => setAddOpen(true)}
              >
                Add repository
              </GatedButton>
            </ToolbarItem>
            <ToolbarItem>
              <GatedButton
                disabledReason={saveBlockedReason ?? lock ?? (!hasChanges && "No changes to save")}
                variant="primary"
                onClick={handleSave}
                isLoading={editor.saving}
              >
                Save changes
              </GatedButton>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        <ConfigPendingChanges
          editor={editor}
          renderText={changedSectionsText}
          textCaption="Changed sections as they will be written. Comments and other lines in each section are kept."
          onDiscard={handleDiscard}
        />

        <div ref={tableWrapRef}>
        <Table aria-label="Repository list" variant="compact">
          <Thead noWrap>
            <Tr>
              <Th width={10}>Enabled</Th>
              <Th>Repository</Th>
              <Th
                width={25}
                info={helpInfo("signature levels", "Never: skip signature checks. Optional: verify if present. Required: must have a valid signature from any key. TrustedOnly: must be signed by a key in the local keyring.", "Signature level")}
              >
                SigLevel
              </Th>
              <Th width={10}>Servers</Th>
              <Th width={10}>Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {filteredRepos.length === 0 && (
              <Tr>
                <Td colSpan={5}>
                  <EmptyState headingLevel="h3" titleText="No repositories match" variant="sm">
                    <EmptyStateBody>No repository in pacman.conf matches the current search.</EmptyStateBody>
                    <EmptyStateFooter>
                      <EmptyStateActions>
                        <Button variant="link" onClick={() => applySearchFilter("")}>Clear search</Button>
                      </EmptyStateActions>
                    </EmptyStateFooter>
                  </EmptyState>
                </Td>
              </Tr>
            )}
            {filteredRepos.flatMap((repo) => {
              const actualIndex = repos.indexOf(repo);
              const visibleIdx = visibleRepos.indexOf(repo);
              const prevVisible = visibleIdx > 0 ? visibleRepos[visibleIdx - 1] : null;
              const nextVisible =
                visibleIdx >= 0 && visibleIdx < visibleRepos.length - 1
                  ? visibleRepos[visibleIdx + 1]
                  : null;
              const isExpanded = expandedRepos.has(repo.name);
              const sigValue = repo.sig_level || "";
              const isCustom =
                sigValue !== "" && !KNOWN_SIG_LEVELS.has(sigValue);
              const isEditingCustom = customEdit?.name === repo.name;
              const serverCount = repo.directives.length;
              const newDirectiveProblem = directiveValueProblem(
                newDirectiveTypes[repo.name] || "Server",
                newDirectiveValues[repo.name] || "",
              );

              const justAdded = shownWrite?.kind === "add" && shownWrite.name === repo.name;
              const showInsecureAck = needsInsecureAck(repo);
              const rows = [
                <Tr key={repo.name} data-repo={repo.name} isRowSelected={justAdded}>
                  <Td dataLabel="Enabled">
                    <Switch
                      id={`switch-${actualIndex}`}
                      isChecked={repo.enabled}
                      onChange={() => handleToggleEnabled(actualIndex)}
                      aria-label={`Enable repository ${repo.name}`}
                      {...lockProps}
                    />
                  </Td>
                  <Td dataLabel="Repository">
                    <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }} flexWrap={{ default: "nowrap" }}>
                    <FlexItem>
                    <Button
                      variant="plain"
                      className="pf-v6-u-p-0"
                      aria-label={`Expand ${repo.name}`}
                      aria-expanded={isExpanded}
                      onClick={() => handleToggleExpand(repo.name)}
                    >
                      <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                        <FlexItem>{isExpanded ? <AngleDownIcon /> : <AngleRightIcon />}</FlexItem>
                        <FlexItem>
                          <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)" }}>
                            [{repo.name}]
                          </span>
                        </FlexItem>
                      </Flex>
                    </Button>
                    </FlexItem>
                    {justAdded && <FlexItem><Label isCompact color="green">Added</Label></FlexItem>}
                    {notSynced.has(repo.name) && editor.loaded?.some((r) => r.name === repo.name && r.enabled) && (
                      <FlexItem><Label isCompact color="orange">Not synced yet</Label></FlexItem>
                    )}
                    {editor.isEdited(repo) && (
                      <>
                        <FlexItem><Label isCompact color="blue">Edited</Label></FlexItem>
                        <FlexItem>
                          <GatedButton
                            disabledReason={lock}
                            variant="plain"
                            size="sm"
                            aria-label={`Revert changes to [${repo.name}]`}
                            onClick={() => editor.revert(repo.name)}
                          >
                            <UndoIcon />
                          </GatedButton>
                        </FlexItem>
                      </>
                    )}
                    </Flex>
                  </Td>
                  <Td dataLabel="SigLevel">
                    <FormSelect
                      value={isEditingCustom ? ENTER_CUSTOM : isCustom ? PARSED_CUSTOM : sigValue}
                      {...lockProps}
                      onChange={(_event, value) => {
                        if (lock) return;
                        if (value === PARSED_CUSTOM) {
                          if (isEditingCustom) endCustomEdit(actualIndex, false);
                          return;
                        }
                        if (value === ENTER_CUSTOM) {
                          startCustomEdit(repo.name, sigValue);
                          return;
                        }
                        if (isEditingCustom) endCustomEdit(actualIndex, false);
                        handleSigLevelChange(actualIndex, value);
                      }}
                      aria-label={`SigLevel for ${repo.name}`}
                    >
                      {SIG_LEVEL_OPTIONS.map((opt) => (
                        <FormSelectOption
                          key={opt.value}
                          value={opt.value}
                          label={opt.label}
                        />
                      ))}
                      {isCustom && (
                        <FormSelectOption
                          key={PARSED_CUSTOM}
                          value={PARSED_CUSTOM}
                          label={`Custom: ${sigValue}`}
                        />
                      )}
                      <FormSelectOption
                        key={ENTER_CUSTOM}
                        value={ENTER_CUSTOM}
                        label={"Custom\u2026"}
                      />
                    </FormSelect>
                    {isEditingCustom && (
                      <TextInput
                        className="pf-v6-u-mt-xs"
                        value={customEdit.draft}
                        onChange={(_event, value) =>
                          setCustomEdit({ name: repo.name, draft: value })
                        }
                        onBlur={() => endCustomEdit(actualIndex, true)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            endCustomEdit(actualIndex, true);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            endCustomEdit(actualIndex, false);
                          }
                        }}
                        placeholder="PackageRequired DatabaseOptional"
                        aria-label={`Custom SigLevel for ${repo.name}`}
                        autoFocus
                      />
                    )}
                  </Td>
                  <Td dataLabel="Servers">
                    <Label isCompact>{serverCount}</Label>
                  </Td>
                  <Td dataLabel="Actions">
                    <Flex spaceItems={{ default: "spaceItemsXs" }}>
                      <FlexItem>
                        <GatedButton
                          disabledReason={lock}
                          variant="plain"
                          aria-label={`Move [${repo.name}] up`}
                          onClick={() => prevVisible && swapByName(repo.name, prevVisible.name)}
                          isDisabled={!lock && !prevVisible}
                        >
                          <ArrowUpIcon />
                        </GatedButton>
                      </FlexItem>
                      <FlexItem>
                        <GatedButton
                          disabledReason={lock}
                          variant="plain"
                          aria-label={`Move [${repo.name}] down`}
                          onClick={() => nextVisible && swapByName(repo.name, nextVisible.name)}
                          isDisabled={!lock && !nextVisible}
                        >
                          <ArrowDownIcon />
                        </GatedButton>
                      </FlexItem>
                      <FlexItem>
                        <Dropdown
                          isOpen={openKebab === repo.name}
                          onOpenChange={(open) => setOpenKebab(open ? repo.name : null)}
                          onSelect={() => setOpenKebab(null)}
                          popperProps={{ position: "right" }}
                          toggle={kebabToggle(
                            `More actions for ${repo.name}`,
                            openKebab === repo.name,
                            () => setOpenKebab(openKebab === repo.name ? null : repo.name),
                          )}
                        >
                          <DropdownList>
                            <GatedDropdownItem
                              disabledReason={lock}
                              isDisabled={!lock && !prevVisible}
                              onClick={() => moveToEdge(repo.name, "top")}
                            >
                              Move to top
                            </GatedDropdownItem>
                            <GatedDropdownItem
                              disabledReason={lock}
                              isDisabled={!lock && !nextVisible}
                              onClick={() => moveToEdge(repo.name, "bottom")}
                            >
                              Move to bottom
                            </GatedDropdownItem>
                            {!ARCH_REPOS.has(repo.name) && <Divider component="li" />}
                            {!ARCH_REPOS.has(repo.name) && (
                              <GatedDropdownItem
                                gate={saveGate}
                                disabledReason={lock}
                                isDanger
                                onClick={() => openRemove(repo.name)}
                              >
                                Remove [{repo.name}]
                              </GatedDropdownItem>
                            )}
                          </DropdownList>
                        </Dropdown>
                      </FlexItem>
                    </Flex>
                  </Td>
                </Tr>,
              ];

              if (showInsecureAck) {
                const sig = repo.sig_level || "";
                rows.push(
                  <Tr key={`${repo.name}-insecure`}>
                    <Td colSpan={5}>
                      <InsecureSigLevelAck
                        id={`insecure-ack-${actualIndex}`}
                        sigLevel={sig}
                        section={`[${repo.name}]`}
                        checked={insecureAcks.has(insecureAckKey(repo.name, sig))}
                        onChange={(checked) => setInsecureAck(repo.name, sig, checked)}
                        note="Save stays blocked until you confirm."
                      />
                    </Td>
                  </Tr>,
                );
              }

              if (isExpanded) {
                rows.push(
                  <Tr key={`${repo.name}-directives`}>
                    <Td colSpan={5}>
                      <Table aria-label={`Directives for ${repo.name}`} variant="compact" borders={false}>
                        <Thead noWrap>
                          <Tr>
                            <Th width={10} screenReaderText="Active" />
                            <Th width={15}>Type</Th>
                            <Th>Value</Th>
                            <Th width={10} screenReaderText="Remove" />
                          </Tr>
                        </Thead>
                        <Tbody>
                          {repo.directives.map((directive, di) => (
                            <Tr key={`${directive.directive_type}-${di}`}>
                              <Td dataLabel="Active">
                                <Switch
                                  id={`directive-switch-${actualIndex}-${di}`}
                                  isChecked={directive.enabled}
                                  onChange={() => handleToggleDirectiveEnabled(actualIndex, di)}
                                  aria-label={`Enable directive ${directive.value}`}
                                  {...lockProps}
                                />
                              </Td>
                              <Td dataLabel="Type">
                                <Label color={directive.directive_type === "Server" ? "blue" : "orange"} isCompact>
                                  {directive.directive_type}
                                </Label>
                              </Td>
                              <Td dataLabel="Value">
                                <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.875rem", opacity: directive.enabled ? 1 : 0.5 }}>
                                  {directive.value}
                                </span>
                              </Td>
                              <Td dataLabel="Remove">
                                <GatedButton
                                  disabledReason={lock}
                                  variant="plain"
                                  aria-label={`Remove directive ${directive.value}`}
                                  onClick={() => handleRemoveDirective(actualIndex, di)}
                                >
                                  <TrashIcon />
                                </GatedButton>
                              </Td>
                            </Tr>
                          ))}
                          <Tr>
                            <Td />
                            <Td dataLabel="Type">
                              <FormSelect
                                value={newDirectiveTypes[repo.name] || "Server"}
                                onChange={(_event, value) =>
                                  setNewDirectiveTypes((prev) => ({
                                    ...prev,
                                    [repo.name]: value as "Server" | "Include",
                                  }))
                                }
                                aria-label="New directive type"
                              >
                                <FormSelectOption value="Server" label="Server" />
                                <FormSelectOption value="Include" label="Include" />
                              </FormSelect>
                            </Td>
                            <Td dataLabel="Value">
                              <TextInput
                                validated={newDirectiveProblem ? "error" : "default"}
                                aria-describedby={newDirectiveProblem ? `add-directive-help-${repo.name}` : undefined}
                                id={`add-directive-value-${repo.name}`}
                                value={newDirectiveValues[repo.name] || ""}
                                onChange={(_event, value) =>
                                  setNewDirectiveValues((prev) => ({
                                    ...prev,
                                    [repo.name]: value,
                                  }))
                                }
                                placeholder={
                                  (newDirectiveTypes[repo.name] || "Server") === "Server"
                                    ? "https://mirror.example.org/$repo/os/$arch"
                                    : "/etc/pacman.d/mirrorlist"
                                }
                                aria-label="New directive value"
                              />
                              {newDirectiveProblem && (
                                <FormHelperText>
                                  <HelperText id={`add-directive-help-${repo.name}`}>
                                    <HelperTextItem variant="error">{newDirectiveProblem}</HelperTextItem>
                                  </HelperText>
                                </FormHelperText>
                              )}
                            </Td>
                            <Td dataLabel="Add">
                              <GatedButton
                                disabledReason={lock}
                                variant="secondary"
                                onClick={() => handleAddDirective(repo.name, actualIndex)}
                                isDisabled={!lock && (!newDirectiveValues[repo.name]?.trim() || newDirectiveProblem !== null)}
                              >
                                Add
                              </GatedButton>
                            </Td>
                          </Tr>
                        </Tbody>
                      </Table>
                    </Td>
                  </Tr>,
                );
              }

              return rows;
            })}
          </Tbody>
        </Table>
        </div>

        <div className="pf-v6-u-mt-md">
          <ExpandableSection
            toggleText={backupsExpanded ? "Hide backup history" : "Backup history"}
            onToggle={handleBackupsToggle}
            isExpanded={backupsExpanded}
          >
            {backupsLoading ? (
              <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                <FlexItem><Spinner size="md" /></FlexItem>
                <FlexItem>Loading backups…</FlexItem>
              </Flex>
            ) : backupError && backups.length === 0 ? (
              <Alert
                variant="danger"
                isInline
                isPlain
                title="Backups could not be listed"
                actionLinks={<AlertActionLink onClick={loadBackups}>Try again</AlertActionLink>}
              >
                {sanitizeErrorMessage(backupError)}<ErrorDetails details={backupErrorDetails} />
              </Alert>
            ) : backups.length === 0 ? (
              <div className="pf-v6-u-color-200">
                No backups yet. A backup is created automatically each time you save.
              </div>
            ) : (
              <>
              {deleteError && (
                <Alert variant="danger" isInline isPlain title="Backups not deleted" className="pf-v6-u-mb-sm">
                  {sanitizeErrorMessage(deleteError)}
                </Alert>
              )}
              <Flex className="pf-v6-u-mb-sm" spaceItems={{ default: "spaceItemsSm" }}>
                <FlexItem>
                  <GatedButton
                    gate={deleteBackupGate}
                    disabledReason={backupBlockedReason ?? (selectedBackups.size === 0 && "Select at least one backup")}
                    variant="danger"
                    size="sm"
                    icon={<TrashIcon />}
                    onClick={() => setDeleteTargets(Array.from(selectedBackups))}
                    isLoading={deletingBackups}
                  >
                    Delete {selectedBackups.size > 0 ? `(${selectedBackups.size})` : "selected"}
                  </GatedButton>
                </FlexItem>
              </Flex>
              <Table aria-label="pacman.conf backups" variant="compact">
                <Thead noWrap>
                  <Tr>
                    <Th screenReaderText="Select">
                      <Checkbox
                        id={selectAllId}
                        isChecked={allBackupsSelected ? true : selectedBackups.size > 0 ? null : false}
                        onChange={(_event, checked) =>
                          setSelectedBackups(checked ? new Set(backups.map((b) => b.timestamp)) : new Set())}
                        aria-label="Select all backups"
                      />
                    </Th>
                    <Th>Date</Th>
                    <Th width={20}>Repositories</Th>
                    <Th width={15}>Size</Th>
                    <Th width={20} screenReaderText="Actions" />
                  </Tr>
                </Thead>
                <Tbody>
                  {backups.map((b) => (
                    <Tr key={b.timestamp}>
                      <RowSelectCell
                        label={`Select backup from ${b.date}`}
                        isSelected={selectedBackups.has(b.timestamp)}
                        onSelect={() => toggleBackupSelection(b.timestamp)}
                      />
                      <Td dataLabel="Date"><TimeAgo timestamp={b.timestamp} /></Td>
                      <Td dataLabel="Repositories">{b.enabled_count} / {b.repo_count} enabled</Td>
                      <Td dataLabel="Size">{formatSize(b.size)}</Td>
                      <Td dataLabel="Actions">
                        <Flex spaceItems={{ default: "spaceItemsSm" }}>
                          <FlexItem>
                            <GatedButton
                              gate={restoreGate}
                              disabledReason={backupBlockedReason}
                              variant="secondary"
                              isLoading={editor.restoring === b.timestamp}
                              onClick={() => handleRestoreClick(b.timestamp)}
                            >
                              Restore
                            </GatedButton>
                          </FlexItem>
                          <FlexItem>
                            <GatedButton
                              gate={deleteBackupGate}
                              disabledReason={backupBlockedReason}
                              variant="plain"
                              aria-label={`Delete backup from ${b.date}`}
                              onClick={() => setDeleteTargets([b.timestamp])}
                            >
                              <TrashIcon />
                            </GatedButton>
                          </FlexItem>
                        </Flex>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
              </>
            )}
          </ExpandableSection>
        </div>

        <ConfigFileText
          path="/etc/pacman.conf"
          isExpanded={fileTextExpanded}
          onToggle={setFileTextExpanded}
          isDirty={hasChanges}
          reloadKey={fileReloadKey}
        />
      </CardBody>
    </Card>
    <ConfirmModal
      isOpen={deleteTargets !== null}
      title={deleteTargets?.length === 1 ? "Delete pacman.conf backup?" : "Delete pacman.conf backups?"}
      severity="warning"
      commitVariant="danger"
      commitLabel={deleteLabel(deleteTargets ?? [])}
      gate={deleteBackupGate}
      onConfirm={() => deleteTargets !== null && handleDeleteBackups(deleteTargets)}
      onClose={() => setDeleteTargets(null)}
    >
      A deleted backup cannot be restored or recovered. The current
      {" "}{CONF_PATH} is not changed.
    </ConfirmModal>
    <RestoreGuardModal
      isOpen={restoreTarget !== null}
      file={CONF_PATH}
      fileLabel="pacman.conf"
      changes={pendingChanges}
      backupDate={backups.find((b) => b.timestamp === restoreTarget)?.date}
      onConfirm={() => restoreTarget !== null && handleRestoreBackup(restoreTarget)}
      onCancel={() => setRestoreTarget(null)}
    />
    {addOpen && (
      <AddRepositoryModal
        existingNames={repos.map((r) => r.name)}
        insertAfter={addInsertion(repos).after}
        pendingChanges={pendingChanges}
        pendingBlockedReason={insecureBlockedReason}
        gate={saveGate}
        keyGate={keyGate}
        onAdd={handleAddRepository}
        onClose={closeAdd}
      />
    )}
    <ConfirmModal
      isOpen={removeTarget !== null}
      title={`Remove [${removeTarget ?? ""}] from pacman.conf?`}
      severity="warning"
      commitVariant="danger"
      commitLabel={pendingChanges.length > 0
        ? `Remove [${removeTarget ?? ""}] and save ${plural(pendingChanges.length, "other change")}`
        : `Remove [${removeTarget ?? ""}]`}
      gate={saveGate}
      disabledReason={lock
        ?? (removePackages.status === "loading" ? `Listing installed packages from [${removeTarget ?? ""}]…` : null)
        ?? insecureBlockedReason}
      onConfirm={() => removeTarget !== null && handleRemoveRepository(removeTarget)}
      onClose={closeRemove}
    >
      <p>
        pacman stops syncing [{removeTarget}]. Packages installed from it stay
        installed, get no updates and show as foreign. The previous pacman.conf
        is kept as a backup, and Undo restores it.
      </p>
      <div className="pf-v6-u-mt-sm" aria-live="polite">
        {removePackages.status === "loading" && (
          <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
            <FlexItem><Spinner size="md" /></FlexItem>
            <FlexItem>Listing installed packages from [{removeTarget}]…</FlexItem>
          </Flex>
        )}
        {removePackages.status === "disabled" && (
          <>[{removeTarget}] is disabled, so pacman tracks no installed packages to it.</>
        )}
        {removePackages.status === "failed" && (
          <Alert component="h2" variant="warning" isInline isPlain title="Installed packages could not be listed">
            {sanitizeErrorMessage(removePackages.message)}
          </Alert>
        )}
        {removePackages.status === "ready" && (removePackages.total === 0 ? (
          <>No installed package comes from [{removeTarget}].</>
        ) : (
          <>
            {plural(removePackages.total, "installed package")} from [{removeTarget}]:
            <ul aria-label={`Installed packages from [${removeTarget}]`}>
              {removePackages.names.slice(0, REMOVE_LIST_LIMIT).map((n) => <li key={n}>{n}</li>)}
            </ul>
            {removePackages.total > REMOVE_LIST_LIMIT && (
              <>and {removePackages.total - REMOVE_LIST_LIMIT} more</>
            )}
          </>
        ))}
      </div>
      {pendingChanges.length > 0 && (
        <div className="pf-v6-u-mt-sm">
          <AlsoSavedChanges changes={pendingChanges} />
        </div>
      )}
    </ConfirmModal>
    </>
  );
};

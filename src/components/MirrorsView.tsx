import { BackupWarnings } from "./BackupWarnings";
import { ErrorDetails } from "./ErrorDetails";
import React, { useState, useEffect, useCallback, useRef, useMemo, useId } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import {
  Card,
  CardBody,
  Button,
  Alert,
  AlertActionCloseButton,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Flex,
  FlexItem,
  ExpandableSection,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  AlertActionLink,
  Content,
  ContentVariants,
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Switch,
  MenuToggle,
  Select,
  SelectOption,
  SelectList,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  NumberInput,
  Checkbox,
  Label,
  Tooltip,
  CodeBlock,
  CodeBlockAction,
  CodeBlockCode,
  ClipboardCopyButton,
  Dropdown,
  DropdownList,
} from "@patternfly/react-core";
import {
  GlobeIcon,
  CheckCircleIcon,
  TimesCircleIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  HistoryIcon,
  UndoIcon,
  TrashIcon,
  SyncAltIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import { useSortableTable } from "../hooks/useSortableTable";
import { usePagination } from "../hooks/usePagination";
import { StatBox } from "./StatBox";
import { CompactPagination } from "./CompactPagination";
import {
  MirrorEntry,
  MirrorListResponse,
  MirrorStatus,
  MirrorStatusResponse,
  MirrorTestResult,
  RefreshMirrorsResponse,
  RefreshMirrorsProtocol,
  RefreshMirrorsSortBy,
  MirrorBackup,
  listMirrors,
  fetchMirrorStatus,
  testMirrors,
  saveMirrorlist,
  refreshMirrors,
  listMirrorBackups,
  restoreMirrorBackup,
  undoMirrorSave,
  deleteMirrorBackup,
  formatSize,
  BackendError,
  parseErrorCode,
} from "../api";
import type { ErrorCode } from "../api";
import { isNetworkError } from "../offline";
import { TimeAgo } from "./TimeAgo";
import { LoadErrorState } from "./LoadErrorState";
import { HelpPopover, helpInfo } from "./HelpPopover";
import { plural, sanitizeErrorMessage } from "../utils";
import { ARCH_STATUS_URL } from "../constants";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useMutationGate } from "../hooks/useMutationGate";
import { useRefreshOnActivate, useTabActive } from "../hooks/useRefreshOnActivate";
import { watchFile } from "../systemWatch";
import { GatedButton, GatedDropdownItem } from "./GatedButton";
import { ConfirmModal } from "./ConfirmModal";
import { kebabToggle } from "./KebabToggle";
import {
  useConfigFileEditor,
  mergeField,
  deleteBackups,
  type EntryModel,
} from "../hooks/useConfigFileEditor";
import { ConfigWriteAlerts, ConfigPendingChanges, RestoreGuardModal } from "./ConfigWriteAlerts";
import { RowSelectCell } from "./RowSelectCell";

type ViewState = "loading" | "ready" | "error";

interface MirrorWithStatus extends MirrorEntry {
  status?: MirrorStatus;
  testResult?: MirrorTestResult;
}

const MIRRORLIST_PATH = "/etc/pacman.d/mirrorlist";
const RANK_DEBOUNCE_MS = 300;

interface RankOptions {
  count: number;
  country: string;
  protocol: RefreshMirrorsProtocol;
  sortBy: RefreshMirrorsSortBy;
}

const rankKey = (o: RankOptions) => `${o.count}|${o.country}|${o.protocol}|${o.sortBy}`;

// Default to the most common enabled-mirror country; ties mean all countries.
function defaultRankCountry(mirrors: MirrorWithStatus[]): string {
  const counts = new Map<string, number>();
  for (const m of mirrors) {
    const code = m.enabled ? m.status?.country_code : undefined;
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  let tied = false;
  for (const [code, n] of counts) {
    if (n > bestCount) {
      best = code;
      bestCount = n;
      tied = false;
    } else if (n === bestCount) {
      tied = true;
    }
  }
  return tied ? "" : best;
}

export function describeMirrorChanges(before: MirrorEntry[], after: MirrorEntry[]): string[] {
  const byUrl = new Map(before.map(m => [m.url, m]));
  const afterUrls = new Set(after.map(m => m.url));
  const changes: string[] = [];
  for (const m of after) {
    const prev = byUrl.get(m.url);
    if (!prev) changes.push(`Add ${m.url}${m.enabled ? "" : " (disabled)"}`);
    else if (prev.enabled !== m.enabled) changes.push(`${m.enabled ? "Enable" : "Disable"} ${m.url}`);
    else if ((prev.comment ?? "") !== (m.comment ?? "")) changes.push(`Change the comment on ${m.url}`);
  }
  for (const m of before) {
    if (!afterUrls.has(m.url)) changes.push(`Remove ${m.url}`);
  }
  const keptBefore = before.filter(m => afterUrls.has(m.url));
  const moved = after.filter(m => byUrl.has(m.url)).filter((m, i) => keptBefore[i]?.url !== m.url).length;
  if (moved > 0) changes.push(`Reorder ${plural(moved, "mirror")}`);
  return changes;
}

const mirrorModel: EntryModel<MirrorWithStatus> = {
  key: (m) => m.url,
  label: (m) => m.url,
  same: (a, b) => a.enabled === b.enabled && (a.comment ?? "") === (b.comment ?? ""),
  merge(base, draft, fresh) {
    const conflict = (change: string) => `${change}: it changed since you started editing`;
    const skipped: string[] = [];
    const enabled = mergeField(base.enabled, draft.enabled, fresh.enabled);
    if (enabled.conflict) skipped.push(conflict(`${draft.enabled ? "Enable" : "Disable"} ${draft.url}`));
    const comment = mergeField(base.comment, draft.comment, fresh.comment);
    if (comment.conflict) skipped.push(conflict(`Change the comment on ${draft.url}`));
    return {
      entry: { ...draft, ...fresh, enabled: enabled.value, comment: comment.value },
      skipped,
    };
  },
};

// Match the Server lines written by save_mirrorlist.
function mirrorlistText(mirrors: MirrorEntry[]): string {
  return mirrors
    .flatMap(m => [
      ...(m.comment ? [`## ${m.comment}`] : []),
      `${m.enabled ? "" : "#"}Server = ${m.url}`,
    ])
    .join("\n");
}

interface MirrorNotice {
  details?: string;
  title: string;
  message: string;
  action: "status" | "test";
}

const STATUS_CACHE_KEY = "cockpit-pacman-mirror-status";
const STATUS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedMirrorStatus {
  data: MirrorStatusResponse;
  timestamp: number;
}

function isValidCachedStatus(obj: unknown): obj is CachedMirrorStatus {
  if (typeof obj !== "object" || obj === null) return false;
  const record = obj as Record<string, unknown>;
  if (typeof record.timestamp !== "number") return false;
  if (typeof record.data !== "object" || record.data === null) return false;
  const data = record.data as Record<string, unknown>;
  if (typeof data.total !== "number") return false;
  if (!Array.isArray(data.mirrors)) return false;
  return true;
}

function getCachedStatus(): MirrorStatusResponse | null {
  try {
    const cached = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (!cached) return null;
    const parsed: unknown = JSON.parse(cached);
    if (!isValidCachedStatus(parsed)) {
      window.localStorage.removeItem(STATUS_CACHE_KEY);
      return null;
    }
    if (Date.now() - parsed.timestamp > STATUS_CACHE_TTL_MS) {
      // Keep the entry so it can be served as a stale fallback when a live
      // fetch fails (offline), but treat it as a miss for the fresh path.
      return null;
    }
    return parsed.data;
  } catch {
    window.localStorage.removeItem(STATUS_CACHE_KEY);
    return null;
  }
}

function getStaleCachedStatus(): MirrorStatusResponse | null {
  try {
    const cached = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (!cached) return null;
    const parsed: unknown = JSON.parse(cached);
    if (!isValidCachedStatus(parsed)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function setCachedStatus(data: MirrorStatusResponse): void {
  try {
    const cached: CachedMirrorStatus = { data, timestamp: Date.now() };
    window.localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Ignore storage errors
  }
}

function getCacheAge(): number | null {
  try {
    const cached = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (!cached) return null;
    const parsed: CachedMirrorStatus = JSON.parse(cached);
    return Date.now() - parsed.timestamp;
  } catch {
    return null;
  }
}

function formatCacheAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeMirrorUrl(url: string): string {
  let normalized = url
    .replace(/\$repo\/os\/\$arch\/?$/, "")
    .replace(/\$arch\/?$/, "")
    .replace(/\$repo\/?$/, "");

  // Clean up any resulting double slashes (except in protocol)
  normalized = normalized.replace(/(https?:\/\/)|\/+/g, (_match, protocol) =>
    protocol ? protocol : "/"
  );

  // Ensure single trailing slash
  return normalized.replace(/\/*$/, "") + "/";
}

interface ConfigFileTextProps {
  path: string;
  isExpanded: boolean;
  onToggle: (expanded: boolean) => void;
  isDirty: boolean;
  reloadKey: number;
}

export const ConfigFileText: React.FC<ConfigFileTextProps> = ({ path, isExpanded, onToggle, isDirty, reloadKey }) => {
  const [text, setText] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const idBase = `config-text-${path.replace(/[^a-z0-9]/gi, "-")}`;

  useEffect(() => {
    if (!isExpanded) return;
    let cancelled = false;
    const handle = cockpit.file(path);
    Promise.resolve(handle.read())
      .then((content) => {
        if (cancelled) return;
        setText(content ?? "");
        setReadError(content === null ? `${path} does not exist.` : null);
      })
      .catch((ex: unknown) => {
        if (cancelled) return;
        setText(null);
        setReadError(ex instanceof Error ? ex.message : String(ex));
      });
    return () => {
      cancelled = true;
      handle.close();
    };
  }, [isExpanded, path, reloadKey]);

  const handleCopy = () => {
    if (text === null) return;
    window.navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <ExpandableSection
      toggleText="View as text"
      isExpanded={isExpanded}
      onToggle={(_event, expanded) => onToggle(expanded)}
      className="pf-v6-u-mt-md"
    >
      {isDirty && (
        <Content component={ContentVariants.p} className="pf-v6-u-mb-sm">
          File on disk. Unsaved edits are not included.
        </Content>
      )}
      {readError ? (
        <Content component={ContentVariants.p}>{sanitizeErrorMessage(readError)}</Content>
      ) : text === null ? (
        <Spinner size="md" aria-label={`Reading ${path}`} />
      ) : (
        <CodeBlock
          actions={
            <CodeBlockAction>
              <ClipboardCopyButton
                id={`${idBase}-copy`}
                aria-label={`Copy ${path}`}
                onClick={handleCopy}
                exitDelay={copied ? 1500 : 600}
                variant="plain"
                onTooltipHidden={() => setCopied(false)}
              >
                {copied ? "Copied" : `Copy ${path}`}
              </ClipboardCopyButton>
            </CodeBlockAction>
          }
        >
          <CodeBlockCode id={`${idBase}-code`}>{text}</CodeBlockCode>
        </CodeBlock>
      )}
    </ExpandableSection>
  );
};

const HttpMirrorWarning: React.FC = () => (
  <Alert variant="warning" isInline title="HTTP does not protect package database transfers" className="pf-v6-u-mt-md">
    With DatabaseOptional, unsigned package databases can be changed or replayed by a network attacker to hide updates.
    Use HTTPS when available.
  </Alert>
);

export const MirrorsView: React.FC = () => {
  const [state, setState] = useState<ViewState>("loading");
  const [mirrorData, setMirrorData] = useState<MirrorListResponse | null>(null);
  const [statusData, setStatusData] = useState<MirrorStatusResponse | null>(null);
  const [statusStale, setStatusStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | undefined>();
  const [operationWarnings, setOperationWarnings] = useState<string[]>([]);
  const [backupWarnings, setBackupWarnings] = useState<string[]>([]);
  const [backupErrorDetails, setBackupErrorDetails] = useState<string | undefined>();
  const [notice, setNotice] = useState<MirrorNotice | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<ErrorCode | undefined>(undefined);
  const [searchFilter, setSearchFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [countryFilterOpen, setCountryFilterOpen] = useState(false);
  const { activeSortIndex, activeSortDirection, getSortParams, resetSort } = useSortableTable({
    sortableColumns: [0, 1, 2, 3, 4],
    defaultDirection: "asc",
  });
  const [refreshModalOpen, setRefreshModalOpen] = useState(false);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshPreview, setRefreshPreview] = useState<RefreshMirrorsResponse | null>(null);
  const [refreshCount, setRefreshCount] = useState(20);
  const [refreshCountry, setRefreshCountry] = useState("");
  const [refreshProtocol, setRefreshProtocol] = useState<RefreshMirrorsProtocol>("https");
  const [refreshSortBy, setRefreshSortBy] = useState<RefreshMirrorsSortBy>("score");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshErrorDetails, setRefreshErrorDetails] = useState<string | undefined>();
  const [refreshErrorCode, setRefreshErrorCode] = useState<ErrorCode | undefined>(undefined);
  const [refreshPreviewKey, setRefreshPreviewKey] = useState<string | null>(null);
  const [rankOptionsExpanded, setRankOptionsExpanded] = useState(false);
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const rankRequestRef = useRef(0);
  const rankRequestedKeyRef = useRef<string | null>(null);
  const [rankRequestedKey, setRankRequestedKey] = useState<string | null>(null);
  const writeOkRef = useRef(false);
  const replaceButtonRef = useRef<React.ComponentRef<"button">>(null);
  const replaceConfirmRef = useRef<React.ComponentRef<"button">>(null);
  const [openKebab, setOpenKebab] = useState<string | null>(null);
  const moveFocusRef = useRef<{ url: string; control: string } | null>(null);
  useBackdropClose(refreshModalOpen, () => { if (!refreshLoading) setRefreshModalOpen(false); });
  const [backups, setBackups] = useState<MirrorBackup[]>([]);
  const [backupsExpanded, setBackupsExpanded] = useState(false);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [selectedBackups, setSelectedBackups] = useState<Set<number>>(new Set());
  const [deletingBackups, setDeletingBackups] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<number[] | null>(null);
  useBackdropClose(deleteTargets !== null, () => setDeleteTargets(null));
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [isFetchingStatus, setIsFetchingStatus] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testProgress, setTestProgress] = useState<{ current: number; total: number } | null>(null);
  const [fileTextExpanded, setFileTextExpanded] = useState(false);
  const [fileReloadKey, setFileReloadKey] = useState(0);
  const cancelRef = useRef<(() => void) | null>(null);
  const autoTestRanRef = useRef(false);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const permission = useAdminPermission();
  const deleteBackupGate = useMutationGate("delete backups", { permission });
  const saveGate = useMutationGate("save the mirrorlist", { permission });
  const restoreGate = useMutationGate("restore the mirrorlist", { permission });
  const refreshTitleId = useId();
  const lockId = useId();
  const selectAllId = useId();
  const file = mirrorData?.path || MIRRORLIST_PATH;

  const editor = useConfigFileEditor<MirrorWithStatus>({
    ...mirrorModel,
    file,
    describeChanges: describeMirrorChanges,
    read: async () => {
      const result = await listMirrors();
      return { entries: result.mirrors, revision: result.revision };
    },
    reload: (): Promise<void> => loadMirrors({ quiet: true }),
    write: async (list, expectedRevision) => {
      const entries: MirrorEntry[] = list.map(({ url, enabled, comment }) => ({ url, enabled, comment }));
      const result = await saveMirrorlist(entries, expectedRevision);
      writeOkRef.current = true;
      setOperationWarnings(result.warnings ?? []);
      return { backupTimestamp: result.backup_timestamp, revision: result.revision };
    },
    restore: async (timestamp) => {
      const result = await restoreMirrorBackup(timestamp);
      setOperationWarnings(result.warnings ?? []);
      return { backupTimestamp: result.backup_timestamp, revision: result.revision ?? undefined };
    },
    undo: async (timestamp, revision) => {
      const result = await undoMirrorSave(timestamp, revision);
      setOperationWarnings(result.warnings ?? []);
      return { backupTimestamp: result.backup_timestamp, revision: result.revision };
    },
    savedTitle: `Saved ${file}`,
    notSavedAnnouncement: "Mirrorlist not saved",
    changeSources: "reflector, or another program",
    onWritten: () => refreshBackupList(),
  });
  const { applyRead, clear: clearEditor, readFailed, refreshFromOutside } = editor;
  const tabActive = useTabActive();

  useRefreshOnActivate(() => {
    refreshFromOutside();
  });

  useEffect(() => {
    if (!tabActive) return;
    const watch = watchFile(file, () => {
      refreshFromOutside();
    });
    return () => watch?.close();
  }, [tabActive, file, refreshFromOutside]);
  const mirrors = editor.entries;
  const setMirrors = editor.setEntries;
  const lock = editor.lockReason;
  const lockProps = lock ? { "aria-disabled": true, "aria-describedby": lockId } : {};

  const applyStatusToMirrors = useCallback((mirrorList: MirrorEntry[], status: MirrorStatusResponse): MirrorWithStatus[] => {
    const statusByUrl = new Map(status.mirrors.map(s => [normalizeMirrorUrl(s.url), s]));
    return mirrorList.map(m => ({
      ...m,
      status: statusByUrl.get(normalizeMirrorUrl(m.url)),
    }));
  }, []);

  const loadMirrors = useCallback(async (options?: { quiet?: boolean }): Promise<void> => {
    const quiet = options?.quiet === true;
    if (!quiet) setState("loading");
    setError(null);
    setLoadErrorCode(undefined);
    setFileReloadKey((k) => k + 1);
    try {
      const response = await listMirrors();
      setMirrorData(response);

      const cachedStatus = getCachedStatus();
      if (cachedStatus) setStatusData(cachedStatus);
      applyRead(response.mirrors, response.revision, (next, prev) => {
        const base: MirrorWithStatus[] = cachedStatus
          ? applyStatusToMirrors(next, cachedStatus)
          : next.map(m => ({ ...m }));
        if (!quiet) return base;
        const previous = new Map(prev.map(m => [m.url, m]));
        return base.map(m => ({
          ...m,
          status: m.status ?? previous.get(m.url)?.status,
          testResult: previous.get(m.url)?.testResult,
        }));
      });

      setState("ready");
    } catch (ex) {
      const message = ex instanceof Error ? ex.message : String(ex);
      if (readFailed(ex)) {
        setState("ready");
        return;
      }
      setMirrorData(null);
      clearEditor();
      setLoadErrorCode(ex instanceof BackendError ? ex.code : parseErrorCode(message));
      setState("error");
      setError(message);
      setErrorDetails(ex instanceof BackendError ? ex.details : undefined);
    }
  }, [applyStatusToMirrors, applyRead, clearEditor, readFailed]);

  useEffect(() => {
    Promise.resolve().then(() => loadMirrors());
  }, [loadMirrors]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  const handleFetchStatus = useCallback(async (forceRefresh = false) => {
    if (!forceRefresh) {
      const cached = getCachedStatus();
      if (cached) {
        setStatusData(cached);
        setMirrors(prev => applyStatusToMirrors(prev, cached));
        return;
      }
    }

    setIsFetchingStatus(true);
    try {
      const response = await fetchMirrorStatus();
      setCachedStatus(response);
      setStatusData(response);
      setStatusStale(false);
      setMirrors(prev => applyStatusToMirrors(prev, response));
    } catch (ex) {
      const stale = getStaleCachedStatus();
      if (stale) {
        setStatusData(stale);
        setStatusStale(true);
        setMirrors(prev => applyStatusToMirrors(prev, stale));
      } else {
        setNotice({
          title: "Mirror status could not be fetched",
          message: ex instanceof Error ? ex.message : String(ex),
          details: ex instanceof BackendError ? ex.details : undefined,
          action: "status",
        });
      }
    } finally {
      setIsFetchingStatus(false);
    }
  }, [applyStatusToMirrors, setMirrors]);

  const loadBackups = useCallback(async () => {
    setBackupsLoading(true);
    setBackupsError(null);
    try {
      const response = await listMirrorBackups();
      setBackups(response.backups);
      setBackupWarnings(response.warnings ?? []);
      setBackupErrorDetails(undefined);
      setSelectedBackups(prev => new Set(response.backups.map(b => b.timestamp).filter(ts => prev.has(ts))));
    } catch (ex) {
      setBackups([]);
      setBackupsError(ex instanceof Error ? ex.message : String(ex));
      setBackupErrorDetails(ex instanceof BackendError ? ex.details : undefined);
    } finally {
      setBackupsLoading(false);
    }
  }, []);

  const handleBackupsToggle = (_event: React.MouseEvent | undefined, expanded: boolean) => {
    setBackupsExpanded(expanded);
    if (expanded && backups.length === 0) {
      loadBackups();
    }
  };

  const refreshBackupList = () => {
    if (backupsExpanded) {
      loadBackups();
    } else {
      setBackups([]);
    }
  };

  const handleRestore = (timestamp: number) => {
    setRestoreTarget(null);
    const backup = backups.find(b => b.timestamp === timestamp);
    return editor.restoreFrom(timestamp, backup ? `Restored ${file} from ${backup.date}` : `Restored ${file}`);
  };

  const toggleBackupSelection = (timestamp: number) => {
    setSelectedBackups(prev => {
      const next = new Set(prev);
      if (next.has(timestamp)) next.delete(timestamp);
      else next.add(timestamp);
      return next;
    });
  };

  const selectAllBackups = () => setSelectedBackups(new Set(backups.map(b => b.timestamp)));
  const deselectAllBackups = () => setSelectedBackups(new Set());
  const allBackupsSelected = backups.length > 0 && selectedBackups.size === backups.length;
  const someBackupsSelected = selectedBackups.size > 0 && selectedBackups.size < backups.length;

  const deleteLabel = (targets: number[]) => {
    if (targets.length !== 1) return `Delete ${targets.length} backups`;
    const backup = backups.find(b => b.timestamp === targets[0]);
    return backup ? `Delete backup from ${backup.date}` : "Delete 1 backup";
  };

  const handleDeleteBackups = async (timestamps: number[]) => {
    setDeleteTargets(null);
    setDeletingBackups(true);
    setDeleteError(null);
    const warnings: string[] = [];
    const failure = await deleteBackups(timestamps, async (timestamp) => {
      const result = await deleteMirrorBackup(timestamp);
      warnings.push(...(result.warnings ?? []));
    });
    setOperationWarnings(warnings);
    if (failure) setDeleteError(failure);
    await loadBackups();
    setDeletingBackups(false);
  };

  const handleTestMirrors = useCallback(() => {
    const enabledMirrors = mirrors.filter(m => m.enabled).map(m => m.url);
    if (enabledMirrors.length === 0) return;

    setIsTesting(true);
    setTestProgress(null);

    const { cancel } = testMirrors(
      {
        onTestResult: (result, current, total) => {
          setTestProgress({ current, total });
          setMirrors(prev => prev.map(m =>
            m.url === result.url ? { ...m, testResult: result } : m
          ));
        },
        onComplete: () => {
          setIsTesting(false);
          cancelRef.current = null;
        },
        onError: (err, _code, details) => {
          setIsTesting(false);
          setNotice({ title: "Mirror test failed", message: err, details, action: "test" });
          cancelRef.current = null;
        },
        timeout: 120,
      },
      enabledMirrors
    );
    cancelRef.current = cancel;
  }, [mirrors, setMirrors]);

  useEffect(() => {
    if (state !== "ready" || autoTestRanRef.current) return;
    autoTestRanRef.current = true;
    handleFetchStatus(false).then(() => {
      handleTestMirrors();
    });
  }, [state, handleFetchStatus, handleTestMirrors]);

  const handleRetest = async () => {
    setNotice(null);
    setMirrors(prev => prev.map(m => ({ ...m, testResult: undefined })));
    await handleFetchStatus(true);
    handleTestMirrors();
  };

  const enabledMirrorCount = mirrors.filter(m => m.enabled).length;

  const pendingChanges = editor.pendingChanges;
  const hasChanges = editor.hasChanges;
  const backupBlockedReason = editor.writing || deletingBackups ? `${file} is being written` : null;
  const rankBlockedReason = isTesting
    ? "Mirror test running"
    : isFetchingStatus
      ? "Mirror status is being fetched"
      : lock;
  const saveBlockedReason = saveGate.blocked
    ? saveGate.reason ?? "Saving is not available"
    : !editor.revision ? "Reload the mirrorlist before saving"
    : enabledMirrorCount === 0
      ? "Enable at least one mirror"
      : null;
  const retestBlockedReason = isTesting
    ? "A mirror test is already running"
    : isFetchingStatus
      ? "Mirror status is being fetched"
      : state !== "ready"
        ? "Mirrors are not loaded"
        : enabledMirrorCount === 0
          ? "Enable at least one mirror to test"
          : null;

  const clearMirrorFilters = () => {
    setSearchFilter("");
    setCountryFilter("all");
  };

  const handleCancel = () => {
    if (cancelRef.current) {
      cancelRef.current();
      cancelRef.current = null;
      setIsTesting(false);
      setTestProgress(null);
    }
  };

  const handleSave = () => editor.save();

  const handleDiscard = () => {
    editor.discard();
    searchWrapRef.current?.querySelector("input")?.focus();
  };

  const handleToggleEnabled = (url: string) => {
    if (editor.writing) return;
    setMirrors(prev => prev.map(m =>
      m.url === url ? { ...m, enabled: !m.enabled } : m
    ));
  };

  const rankOptions: RankOptions = {
    count: refreshCount,
    country: refreshCountry,
    protocol: refreshProtocol,
    sortBy: refreshSortBy,
  };
  const currentRankKey = rankKey(rankOptions);

  const runRank = useCallback(async (options: RankOptions) => {
    const id = ++rankRequestRef.current;
    rankRequestedKeyRef.current = rankKey(options);
    setRankRequestedKey(rankRequestedKeyRef.current);
    setRefreshLoading(true);
    setRefreshError(null);
    setRefreshErrorCode(undefined);
    try {
      const result = await refreshMirrors({
        count: options.count,
        country: options.country || undefined,
        protocol: options.protocol,
        sortBy: options.sortBy,
      });
      if (id !== rankRequestRef.current) return;
      setRefreshPreview(result);
      setRefreshPreviewKey(rankKey(options));
    } catch (ex) {
      if (id !== rankRequestRef.current) return;
      setRefreshError(ex instanceof Error ? ex.message : String(ex));
      setRefreshErrorCode(ex instanceof BackendError ? ex.code : undefined);
      setRefreshErrorDetails(ex instanceof BackendError ? ex.details : undefined);
    } finally {
      if (id === rankRequestRef.current) setRefreshLoading(false);
    }
  }, []);

  useEffect(() => {
    const options = { count: refreshCount, country: refreshCountry, protocol: refreshProtocol, sortBy: refreshSortBy };
    if (!refreshModalOpen || rankRequestedKeyRef.current === rankKey(options)) return;
    const timer = setTimeout(() => runRank(options), RANK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [refreshModalOpen, refreshCount, refreshCountry, refreshProtocol, refreshSortBy, runRank]);

  const handleRefreshGenerate = () => runRank(rankOptions);

  const handleOpenRefreshModal = () => {
    const options = { ...rankOptions, country: defaultRankCountry(mirrors) };
    setRefreshCountry(options.country);
    setRefreshPreview(null);
    setRefreshPreviewKey(null);
    setReplaceConfirm(false);
    setRankOptionsExpanded(false);
    setRefreshModalOpen(true);
    runRank(options);
  };

  const closeRefreshModal = () => {
    rankRequestRef.current++;
    rankRequestedKeyRef.current = null;
    setRankRequestedKey(null);
    setRefreshLoading(false);
    setReplaceConfirm(false);
    setRefreshModalOpen(false);
  };

  const applyRankedDraft = (): MirrorWithStatus[] | null => {
    if (!refreshPreview) return null;
    const ranked: MirrorWithStatus[] = refreshPreview.mirrors.map(m => ({ ...m }));
    setMirrors(ranked);
    closeRefreshModal();
    setRefreshPreview(null);
    if (state === "error") {
      setState("ready");
      setError(null);
    }
    return ranked;
  };

  const handleRefreshApply = () => {
    applyRankedDraft();
  };

  const handleRankReplace = async () => {
    if (!refreshPreview) return;
    if (hasChanges && !replaceConfirm) {
      setReplaceConfirm(true);
      return;
    }
    // Preserve unsaved edits if replacing the mirrorlist fails.
    const before = hasChanges ? mirrors : null;
    const ranked = applyRankedDraft();
    if (!ranked) return;
    writeOkRef.current = false;
    await editor.save(ranked);
    if (before && !writeOkRef.current) setMirrors(before);
  };

  const handleKeepChanges = () => {
    setReplaceConfirm(false);
  };

  useEffect(() => {
    if (!refreshModalOpen) return;
    (replaceConfirm ? replaceConfirmRef : replaceButtonRef).current?.focus();
    // Focus moves only when the confirm step opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceConfirm]);

  const handleClearSort = () => {
    resetSort();
    (tableWrapRef.current?.querySelector("thead button") as HTMLElement | null)?.focus();
  };

  const countries = useMemo(() => {
    const countrySet = new Set<string>();
    for (const m of mirrors) {
      if (m.status?.country) {
        countrySet.add(m.status.country);
      }
    }
    return Array.from(countrySet).sort();
  }, [mirrors]);

  const statusCountries = useMemo(() => {
    if (!statusData) return [];
    const countryMap = new Map<string, string>();
    for (const m of statusData.mirrors) {
      if (m.country && m.country_code) {
        countryMap.set(m.country_code, m.country);
      }
    }
    return Array.from(countryMap.entries())
      .sort((a, b) => a[1].localeCompare(b[1]));
  }, [statusData]);

  const mirrorIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    mirrors.forEach((m, i) => map.set(m.url, i));
    return map;
  }, [mirrors]);

  const filteredMirrors = useMemo(() => {
    return mirrors.filter(m => {
      if (searchFilter && !m.url.toLowerCase().includes(searchFilter.toLowerCase())) {
        return false;
      }
      if (countryFilter !== "all" && m.status?.country !== countryFilter) {
        return false;
      }
      return true;
    });
  }, [mirrors, searchFilter, countryFilter]);

  const refreshDiff = useMemo(() => {
    if (!refreshPreview) return null;
    const currentUrls = new Set(
      mirrors.filter(m => m.enabled).map(m => normalizeMirrorUrl(m.url))
    );
    const previewUrls = new Set(
      refreshPreview.mirrors.map(m => normalizeMirrorUrl(m.url))
    );
    const kept: Array<{ url: string; comment: string | null }> = [];
    const added: Array<{ url: string; comment: string | null }> = [];
    for (const m of refreshPreview.mirrors) {
      if (currentUrls.has(normalizeMirrorUrl(m.url))) {
        kept.push(m);
      } else {
        added.push(m);
      }
    }
    const removed: Array<{ url: string; comment: string | null }> = [];
    for (const m of mirrors) {
      if (m.enabled && !previewUrls.has(normalizeMirrorUrl(m.url))) {
        removed.push({ url: m.url, comment: m.status?.country ?? m.comment ?? null });
      }
    }
    return { kept, added, removed };
  }, [refreshPreview, mirrors]);

  const sortedMirrors = useMemo(() => {
    if (activeSortIndex === null) return filteredMirrors;
    return [...filteredMirrors].sort((a, b) => {
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = (a.enabled ? 0 : 1) - (b.enabled ? 0 : 1);
          break;
        case 1:
          comparison = a.url.localeCompare(b.url);
          break;
        case 2:
          comparison = (a.status?.country || "").localeCompare(b.status?.country || "");
          break;
        case 3:
          comparison = (a.testResult?.latency_ms ?? Infinity) - (b.testResult?.latency_ms ?? Infinity);
          break;
        case 4:
          comparison = (a.status?.score ?? Infinity) - (b.status?.score ?? Infinity);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [filteredMirrors, activeSortIndex, activeSortDirection]);

  const { page, perPage, offset, onSetPage, onPerPageSelect, setPage } = usePagination();

  // Only the rendered rows are paginated; row actions resolve their index via
  // mirrorIndexMap against the full list. Reset to page 1 when the
  // filtered/sorted set changes so a filter can't strand an empty page.
  useEffect(() => {
    setPage(1);
  }, [searchFilter, countryFilter, activeSortIndex, activeSortDirection, setPage]);

  const pagedMirrors = useMemo(
    () => sortedMirrors.slice(offset, offset + perPage),
    [sortedMirrors, offset, perPage]
  );

  // control names the row control that keeps focus once the row has moved.
  const moveMirror = (url: string, to: "up" | "down" | "top" | "bottom", control: string) => {
    if (editor.writing) return;
    const from = mirrors.findIndex(m => m.url === url);
    if (from < 0) return;
    const at = to === "up" ? from - 1 : to === "down" ? from + 1 : to === "top" ? 0 : mirrors.length - 1;
    if (at < 0 || at >= mirrors.length || at === from) return;
    const next = mirrors.filter((_, i) => i !== from);
    next.splice(at, 0, mirrors[from]);
    setMirrors(next);
    moveFocusRef.current = { url, control };
    const shown = new Set(filteredMirrors.map(m => m.url));
    const index = next.filter(m => shown.has(m.url)).findIndex(m => m.url === url);
    if (index >= 0) setPage(Math.floor(index / perPage) + 1);
  };

  // An edge button disables itself once the row reaches that edge; the row's
  // menu toggle takes focus then.
  useEffect(() => {
    const pending = moveFocusRef.current;
    if (!pending) return;
    const row = Array.from(tableWrapRef.current?.querySelectorAll<HTMLElement>("tr[data-mirror-url]") ?? [])
      .find(r => r.dataset.mirrorUrl === pending.url);
    if (!row) return;
    moveFocusRef.current = null;
    const target = row.querySelector<HTMLElement>(`[data-move="${pending.control}"]:not(:disabled)`)
      ?? row.querySelector<HTMLElement>('button[aria-label^="More actions for"]');
    target?.focus();
  }, [pagedMirrors]);

  const rankPending = refreshLoading || rankRequestedKey !== currentRankKey;
  const rankStale = refreshPreview !== null && (rankPending || refreshPreviewKey !== currentRankKey);
  const replaceBlockedReason = lock ?? (!editor.revision ? "Reload the mirrorlist before saving" : null) ?? (!refreshPreview
    ? (refreshLoading ? "Ranking mirrors" : "No ranked list yet")
    : rankPending
      ? "Ranking with the new options"
      : rankStale
        ? "The shown list does not match the options"
        : refreshPreview.mirrors.length === 0
          ? "The ranking found no mirrors"
          : null);
  const changeCount = plural(pendingChanges.length, "unsaved change");

  const rankOptionsForm = (
    <Form isHorizontal>
      <FormGroup label="Number of mirrors" fieldId="refresh-count">
        <NumberInput
          id="refresh-count"
          value={refreshCount}
          onMinus={() => setRefreshCount(Math.max(1, refreshCount - 5))}
          onPlus={() => setRefreshCount(Math.min(100, refreshCount + 5))}
          onChange={(event) => {
            const value = parseInt((event.target as HTMLInputElement).value, 10);
            if (!isNaN(value) && value >= 1 && value <= 100) setRefreshCount(value);
          }}
          min={1}
          max={100}
        />
      </FormGroup>
      <FormGroup label="Country" fieldId="refresh-country">
        <FormSelect
          id="refresh-country"
          value={refreshCountry}
          onChange={(_event, value) => setRefreshCountry(value)}
        >
          <FormSelectOption value="" label="All countries" />
          {statusCountries.map(([code, name]) => (
            <FormSelectOption key={code} value={code} label={`${name} (${code})`} />
          ))}
        </FormSelect>
      </FormGroup>
      <FormGroup label="Protocol" fieldId="refresh-protocol">
        <FormSelect
          id="refresh-protocol"
          value={refreshProtocol}
          onChange={(_event, value) => setRefreshProtocol(value as RefreshMirrorsProtocol)}
        >
          <FormSelectOption value="https" label="HTTPS only" />
          <FormSelectOption value="http" label="HTTP only" />
          <FormSelectOption value="all" label="All protocols" />
        </FormSelect>
      </FormGroup>
              {refreshProtocol !== "https" && <HttpMirrorWarning />}
      <FormGroup
        label="Sort by"
        fieldId="refresh-sort"
        labelHelp={
          <HelpPopover
            label="sort criteria"
            header="Sort criteria"
            body="Score: composite quality (lower is better). Delay: seconds behind the master mirror. Age: time since last successful sync (newest first)."
          />
        }
      >
        <FormSelect
          id="refresh-sort"
          value={refreshSortBy}
          onChange={(_event, value) => setRefreshSortBy(value as RefreshMirrorsSortBy)}
        >
          <FormSelectOption value="score" label="Mirror score (lower = better)" />
          <FormSelectOption value="delay" label="Sync delay (lower = better)" />
          <FormSelectOption value="age" label="Last sync time (newest first)" />
        </FormSelect>
      </FormGroup>
    </Form>
  );

  const refreshModal = (
    <Modal
      variant={ModalVariant.large}
      isOpen={refreshModalOpen}
      onClose={closeRefreshModal}
      aria-labelledby={refreshTitleId}
    >
      <ModalHeader title="Rank mirrors" labelId={refreshTitleId} />
      <ModalBody>
        {replaceConfirm && (
          <Alert
            component="h2"
            variant="warning"
            isInline
            title={`Replacing discards your ${changeCount}`}
            className="pf-v6-u-mb-md"
          >
            <ul>
              {pendingChanges.map((change) => <li key={change}>{change}</li>)}
            </ul>
          </Alert>
        )}
        <Content component={ContentVariants.p} className="pf-v6-u-mb-md">
          Active, synced mirrors from the Arch Linux mirror status API, sorted by quality.
          The ranked list below is what replaces /etc/pacman.d/mirrorlist; the current
          file is backed up first.
        </Content>

        {refreshError && (
          isNetworkError(null, refreshErrorCode) ? (
            <Alert
              component="h2"
              variant="warning"
              isInline
              title="Can't reach the Arch mirror status service"
              className="pf-v6-u-mb-md"
              actionLinks={<Button variant="link" isInline onClick={handleRefreshGenerate}>Rank again</Button>}
            >
              The host may be offline. Check its network connection or the{" "}
              <a href={ARCH_STATUS_URL} target="_blank" rel="noopener noreferrer">Arch Linux status page</a>.
              <ErrorDetails details={refreshErrorDetails} />
            </Alert>
          ) : (
            <Alert
              component="h2"
              variant="danger"
              isInline
              title={sanitizeErrorMessage(refreshError)}
              className="pf-v6-u-mb-md"
              actionLinks={<Button variant="link" isInline onClick={handleRefreshGenerate}>Rank again</Button>}
            >
              <ErrorDetails details={refreshErrorDetails} />
            </Alert>
          )
        )}

        {!refreshPreview && refreshLoading && (
          <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }} className="pf-v6-u-py-md">
            <FlexItem><Spinner size="md" aria-hidden="true" /></FlexItem>
            <FlexItem>Ranking mirrors…</FlexItem>
          </Flex>
        )}

        {refreshPreview && refreshDiff && (
          <div aria-busy={rankPending}>
            <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
              <FlexItem>
                <Content component={ContentVariants.p}>
                  <strong>{refreshPreview.total}</strong> mirrors found
                  {refreshPreview.last_check && ` (status checked: ${refreshPreview.last_check})`}
                  {" — "}
                  <span style={{ color: "var(--pf-t--global--color--status--success--default)" }}>
                    +{refreshDiff.added.length} added
                  </span>
                  {", "}
                  <span style={{ color: "var(--pf-t--global--color--status--danger--default)" }}>
                    &minus;{refreshDiff.removed.length} removed
                  </span>
                  {`, ${refreshDiff.kept.length} kept`}
                </Content>
              </FlexItem>
              {rankPending && (
                <FlexItem>
                  <Spinner size="sm" aria-hidden="true" />{" "}
                  <span>Ranking with the new options…</span>
                </FlexItem>
              )}
            </Flex>
            <div
              role="region"
              aria-label="Mirror changes"
              tabIndex={0}
              style={{ maxHeight: "300px", overflow: "auto", opacity: rankStale ? 0.5 : undefined }}
              className="pf-v6-u-mt-sm"
            >
              <Table aria-label="Preview mirrors" variant="compact">
                <Thead noWrap>
                  <Tr>
                    <Th width={10}></Th>
                    <Th>URL</Th>
                    <Th width={20}>Country</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {refreshDiff.added.map((m) => (
                    <Tr key={m.url} style={{ backgroundColor: "rgba(46, 125, 50, 0.08)" }}>
                      <Td dataLabel="">
                        <span style={{ color: "#2e7d32", fontWeight: 600 }}>+</span>
                      </Td>
                      <Td dataLabel="URL">
                        <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.875rem" }}>
                          {m.url}
                        </span>
                      </Td>
                      <Td dataLabel="Country">{m.comment || "-"}</Td>
                    </Tr>
                  ))}
                  {refreshDiff.removed.map((m) => (
                    <Tr key={m.url} style={{ backgroundColor: "rgba(198, 40, 40, 0.08)" }}>
                      <Td dataLabel="">
                        <span style={{ color: "#c62828", fontWeight: 600 }}>&minus;</span>
                      </Td>
                      <Td dataLabel="URL">
                        <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.875rem", textDecoration: "line-through", opacity: 0.7 }}>
                          {m.url}
                        </span>
                      </Td>
                      <Td dataLabel="Country">{m.comment || "-"}</Td>
                    </Tr>
                  ))}
                  {refreshDiff.kept.map((m) => (
                    <Tr key={m.url}>
                      <Td dataLabel="" />
                      <Td dataLabel="URL">
                        <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.875rem" }}>
                          {m.url}
                        </span>
                      </Td>
                      <Td dataLabel="Country">{m.comment || "-"}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          </div>
        )}

        <ExpandableSection
          toggleText={refreshPreview
            ? `Ranking options (${plural(refreshPreview.total, "mirror")} found)`
            : "Ranking options"}
          isExpanded={rankOptionsExpanded}
          onToggle={(_event, expanded) => setRankOptionsExpanded(expanded)}
          className="pf-v6-u-mt-lg"
        >
          {rankOptionsForm}
        </ExpandableSection>
      </ModalBody>
      <ModalFooter>
        {replaceConfirm ? (
          <>
            <GatedButton
              key="confirm-replace"
              ref={replaceConfirmRef}
              gate={saveGate}
              disabledReason={replaceBlockedReason}
              variant="danger"
              onClick={handleRankReplace}
            >
              {`Discard ${changeCount} and replace`}
            </GatedButton>
            <Button key="keep" variant="link" onClick={handleKeepChanges}>
              Keep my changes
            </Button>
          </>
        ) : (
          <>
            <GatedButton
              key="replace"
              ref={replaceButtonRef}
              gate={saveGate}
              disabledReason={replaceBlockedReason}
              variant="primary"
              onClick={handleRankReplace}
            >
              {refreshPreview
                ? `Replace mirrorlist (${plural(refreshPreview.mirrors.length, "mirror")})`
                : "Replace mirrorlist"}
            </GatedButton>
            <Button
              key="edit"
              variant="secondary"
              onClick={handleRefreshApply}
              isDisabled={!refreshPreview || rankPending}
            >
              Edit before saving
            </Button>
            <Button key="cancel" variant="link" onClick={closeRefreshModal}>
              Cancel
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );

  const writeAlerts = (
    <>
    <BackupWarnings warnings={[...operationWarnings, ...backupWarnings]} />
      <ConfigWriteAlerts
        editor={editor}
        fileLabel="mirrorlist"
        notSavedTitle="Mirrorlist not saved"
        saveBlockedReason={saveBlockedReason}
        restoreGate={restoreGate}
      />
    </>
  );

  if (state === "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading mirrors">
            <EmptyStateBody>Reading mirrorlist configuration…</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  const rankButton = (
    <Button variant="primary" icon={<SyncAltIcon />} onClick={handleOpenRefreshModal}>
      Rank mirrors from Arch status
    </Button>
  );

  if (state === "error" && !mirrorData) {
    return (
      <Card>
        <CardBody>
          <LoadErrorState
            what="mirrors"
            error={error} details={errorDetails}
            code={loadErrorCode}
            onRetry={() => loadMirrors()}
            retryVariant={loadErrorCode === "not_found" ? "secondary" : "primary"}
            action={loadErrorCode === "not_found" && rankButton}
          />
        </CardBody>
        {refreshModal}
      </Card>
    );
  }

  if (!mirrors.length) {
    return (
      <Card>
        <CardBody>
          {writeAlerts}
          <EmptyState headingLevel="h2" icon={GlobeIcon} titleText="No mirrors found">
            <EmptyStateBody>
              The mirrorlist at {mirrorData?.path || "/etc/pacman.d/mirrorlist"} contains no mirrors.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                {rankButton}
                <Button variant="secondary" onClick={() => loadMirrors()}>
                  Check again
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </CardBody>
        {refreshModal}
      </Card>
    );
  }

  const sorted = activeSortIndex !== null;

  const moveBlockedReason = lock ?? (sorted && "Clear the sort to reorder");

  const moveButton = (control: "up" | "down", label: string, icon: React.ReactNode, url: string, atEdge: boolean) => (
    <GatedButton
      disabledReason={moveBlockedReason}
      variant="plain"
      aria-label={label}
      data-move={control}
      onClick={() => moveMirror(url, control, control)}
      isDisabled={!moveBlockedReason && atEdge}
    >
      {icon}
    </GatedButton>
  );

  const rankAction = (variant: "secondary" | "link", label: string) => (
    <GatedButton
      disabledReason={rankBlockedReason}
      variant={variant}
      isInline={variant === "link"}
      icon={variant === "secondary" ? <SyncAltIcon /> : undefined}
      onClick={handleOpenRefreshModal}
    >
      {label}
    </GatedButton>
  );

  return (
    <>
      {writeAlerts}
      <span id={lockId} className="pf-v6-screen-reader">{lock}</span>
      {mirrors.length > 0 && enabledMirrorCount === 0 && (
        <Alert
          variant="info"
          isInline
          title="No mirror is enabled."
          className="pf-v6-u-mb-md"
          actionLinks={rankAction("link", "Rank mirrors")}
        >
          pacman cannot download packages until a mirror is enabled and saved.
        </Alert>
      )}
      {notice && (
        <Alert
          variant="warning"
          isInline
          title={notice.title}
          className="pf-v6-u-mb-md"
          actionClose={<AlertActionCloseButton title={notice.title} onClose={() => setNotice(null)} />}
          actionLinks={notice.action === "status" ? (
            <GatedButton disabledReason={retestBlockedReason} variant="link" isInline onClick={() => { setNotice(null); handleFetchStatus(true); }}>
              Try again
            </GatedButton>
          ) : (
            <GatedButton disabledReason={retestBlockedReason} variant="link" isInline onClick={handleRetest}>
              Test mirrors again
            </GatedButton>
          )}
        >
          {sanitizeErrorMessage(notice.message)}
          <ErrorDetails details={notice.details} />
        </Alert>
      )}
      {(isFetchingStatus || isTesting) && (
        <Alert
          variant="info"
          className="pf-v6-u-mb-md"
          customIcon={<Spinner size="sm" />}
          title={
            isFetchingStatus
              ? "Fetching mirror status…"
              : testProgress
                ? `Testing mirrors (${testProgress.current}/${testProgress.total})…`
                : "Starting mirror tests…"
          }
          actionLinks={
            isTesting
              ? <Button variant="link" isInline onClick={handleCancel}>Cancel</Button>
              : undefined
          }
        />
      )}
      <Card className="pf-v6-u-mb-md">
        <CardBody>
          <Flex spaceItems={{ default: "spaceItemsLg" }}>
            <FlexItem>
              <StatBox label="Total" value={(mirrors.length).toLocaleString()} />
            </FlexItem>
            <FlexItem>
              <StatBox label="Enabled" value={(mirrors.filter(m => m.enabled).length).toLocaleString()} color="success" />
            </FlexItem>
            {mirrorData?.last_modified && (
              <FlexItem>
                <StatBox label="Last modified" value={<TimeAgo timestamp={mirrorData.last_modified} />} />
              </FlexItem>
            )}
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
                placeholder="Search mirrors…"
                value={searchFilter}
                onChange={(_event: React.SyntheticEvent, value: string) => setSearchFilter(value)}
                onClear={() => setSearchFilter("")}
                aria-label="Search mirrors"
              />
              </div>
            </ToolbarItem>
            {countries.length > 0 && (
              <ToolbarItem>
                <Select
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setCountryFilterOpen(!countryFilterOpen)}
                      isExpanded={countryFilterOpen}
                      style={{ minWidth: "150px" }}
                    >
                      {countryFilter === "all" ? "All countries" : countryFilter}
                    </MenuToggle>
                  )}
                  onSelect={(_event, value) => {
                    setCountryFilter(value as string);
                    setCountryFilterOpen(false);
                  }}
                  selected={countryFilter}
                  isOpen={countryFilterOpen}
                  onOpenChange={setCountryFilterOpen}
                >
                  <SelectList>
                    <SelectOption value="all">All countries</SelectOption>
                    {countries.map(country => (
                      <SelectOption key={country} value={country}>
                        {country}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </ToolbarItem>
            )}
            <ToolbarItem>
              {rankAction("secondary", "Rank mirrors")}{" "}
              <HelpPopover
                label="ranking mirrors"
                body="Generate a ranked mirrorlist from the Arch status API. You'll see the ranked list before it replaces /etc/pacman.d/mirrorlist."
              />
            </ToolbarItem>
            <ToolbarItem>
              <Tooltip
                content={retestBlockedReason ?? "Fetch fresh mirror status from archlinux.org and measure latency to each enabled mirror."}
              >
                <Button
                  variant="secondary"
                  onClick={handleRetest}
                  isAriaDisabled={retestBlockedReason !== null}
                >
                  Test mirrors again
                </Button>
              </Tooltip>
            </ToolbarItem>
            {sorted && (
              <ToolbarItem>
                <Button variant="link" onClick={handleClearSort}>Clear sort</Button>
              </ToolbarItem>
            )}
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

        {mirrors.some(mirror => mirror.enabled && mirror.url.startsWith("http://")) && <HttpMirrorWarning />}
        <ConfigPendingChanges
          editor={editor}
          renderText={() => mirrorlistText(mirrors)}
          textCaption="Server lines as they will be written below the generated header."
          onDiscard={handleDiscard}
        />

        <div ref={tableWrapRef}>
        <Table aria-label="Mirror list" variant="compact">
          <Thead noWrap>
            <Tr>
              <Th sort={getSortParams(0)} width={10}>Enabled</Th>
              <Th sort={getSortParams(1)}>URL</Th>
              <Th sort={getSortParams(2)} width={15}>Country</Th>
              <Th
                sort={getSortParams(3)}
                width={10}
                info={helpInfo("latency", "Round-trip time from this machine to the mirror, in milliseconds. Affects download start time but not throughput.")}
              >
                Latency
              </Th>
              <Th
                sort={getSortParams(4)}
                width={10}
                info={helpInfo("mirror score", "Quality metric from the Arch mirror status API. Lower is better. Combines sync delay, completion ratio, and standard deviation of recent checks.", "Mirror score")}
              >
                Score
              </Th>
              <Th width={10}>Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {sortedMirrors.length === 0 && (
              <Tr>
                <Td colSpan={6}>
                  <EmptyState headingLevel="h3" titleText="No mirrors match" variant="sm">
                    <EmptyStateBody>No mirror in the list matches the current search.</EmptyStateBody>
                    <EmptyStateFooter>
                      <EmptyStateActions>
                        <Button variant="link" onClick={clearMirrorFilters}>Clear search</Button>
                      </EmptyStateActions>
                    </EmptyStateFooter>
                  </EmptyState>
                </Td>
              </Tr>
            )}
            {pagedMirrors.map((mirror) => {
              const actualIndex = mirrorIndexMap.get(mirror.url) ?? -1;
              return (
                  <Tr key={`mirror-${mirror.url}`} data-mirror-url={mirror.url}>
                    <Td dataLabel="Enabled">
                      <Switch
                        id={`switch-${actualIndex}`}
                        isChecked={mirror.enabled}
                        onChange={() => handleToggleEnabled(mirror.url)}
                        aria-label={`Enable mirror ${mirror.url}`}
                        {...lockProps}
                      />
                    </Td>
                    <Td dataLabel="URL">
                      <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                        {mirror.testResult && (
                          <FlexItem>
                            {mirror.testResult.success ? (
                              <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" />
                            ) : (
                              <TimesCircleIcon color="var(--pf-t--global--icon--color--status--danger--default)" />
                            )}
                          </FlexItem>
                        )}
                        <FlexItem>
                          <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                            <FlexItem>
                              <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.875rem" }}>
                                {mirror.url}
                              </span>
                            </FlexItem>
                            <FlexItem>
                              <Label color="blue" variant="outline" isCompact>mirrorlist</Label>
                            </FlexItem>
                            {editor.isEdited(mirror) && (
                              <>
                                <FlexItem><Label isCompact color="blue">Edited</Label></FlexItem>
                                <FlexItem>
                                  <GatedButton
                                    disabledReason={lock}
                                    variant="plain"
                                    size="sm"
                                    aria-label={`Revert changes to ${mirror.url}`}
                                    onClick={() => editor.revert(mirror.url)}
                                  >
                                    <UndoIcon />
                                  </GatedButton>
                                </FlexItem>
                              </>
                            )}
                          </Flex>
                          {mirror.comment && (
                            <div style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)" }}>
                              {mirror.comment}
                            </div>
                          )}
                        </FlexItem>
                      </Flex>
                    </Td>
                    <Td dataLabel="Country">
                      {mirror.status?.country || "-"}
                      {mirror.status?.country_code && (
                        <span style={{ marginLeft: "0.5rem", color: "var(--pf-t--global--text--color--subtle)" }}>
                          ({mirror.status.country_code})
                        </span>
                      )}
                    </Td>
                    <Td dataLabel="Latency">
                      {mirror.testResult?.latency_ms !== undefined && mirror.testResult?.latency_ms !== null
                        ? `${mirror.testResult.latency_ms}ms`
                        : isTesting && mirror.enabled && !mirror.testResult
                          ? <Spinner size="sm" />
                          : "-"}
                    </Td>
                    <Td dataLabel="Score">
                      {mirror.status?.score !== undefined && mirror.status?.score !== null
                        ? mirror.status.score.toFixed(2)
                        : "-"}
                    </Td>
                    <Td dataLabel="Actions">
                      <Flex spaceItems={{ default: "spaceItemsXs" }}>
                        <FlexItem>
                          {moveButton("up", "Move up", <ArrowUpIcon />, mirror.url, actualIndex === 0)}
                        </FlexItem>
                        <FlexItem>
                          {moveButton("down", "Move down", <ArrowDownIcon />, mirror.url, actualIndex === mirrors.length - 1)}
                        </FlexItem>
                        <FlexItem>
                          <Dropdown
                            isOpen={openKebab === mirror.url}
                            onOpenChange={(open) => setOpenKebab(open ? mirror.url : null)}
                            onSelect={() => setOpenKebab(null)}
                            popperProps={{ position: "right" }}
                            toggle={kebabToggle(
                              `More actions for ${mirror.url}`,
                              openKebab === mirror.url,
                              () => setOpenKebab(openKebab === mirror.url ? null : mirror.url),
                            )}
                          >
                            <DropdownList>
                              <GatedDropdownItem
                                disabledReason={moveBlockedReason}
                                isDisabled={!moveBlockedReason && actualIndex === 0}
                                onClick={() => moveMirror(mirror.url, "top", "menu")}
                              >
                                Move to top
                              </GatedDropdownItem>
                              <GatedDropdownItem
                                disabledReason={moveBlockedReason}
                                isDisabled={!moveBlockedReason && actualIndex === mirrors.length - 1}
                                onClick={() => moveMirror(mirror.url, "bottom", "menu")}
                              >
                                Move to bottom
                              </GatedDropdownItem>
                            </DropdownList>
                          </Dropdown>
                        </FlexItem>
                      </Flex>
                    </Td>
                  </Tr>
              );
            })}
          </Tbody>
        </Table>
        </div>
        {sortedMirrors.length > perPage && (
          <CompactPagination
            itemCount={sortedMirrors.length}
            page={page}
            perPage={perPage}
            onSetPage={onSetPage}
            onPerPageSelect={onPerPageSelect}
          />
        )}

        <ExpandableSection
          toggleText={backupsExpanded ? "Hide backup history" : "Backup history"}
          onToggle={handleBackupsToggle}
          isExpanded={backupsExpanded}
          className="pf-v6-u-mt-lg"
        >
          {backupsLoading ? (
            <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }} className="pf-v6-u-py-md">
              <FlexItem><Spinner size="md" /></FlexItem>
              <FlexItem>Loading backups…</FlexItem>
            </Flex>
          ) : backupsError ? (
            <Alert
              variant="danger"
              isInline
              isPlain
              title="Backups could not be listed"
              className="pf-v6-u-py-md"
              actionLinks={<AlertActionLink onClick={loadBackups}>Try again</AlertActionLink>}
            >
              {sanitizeErrorMessage(backupsError)}<ErrorDetails details={backupErrorDetails} />
            </Alert>
          ) : backups.length === 0 ? (
            <Content component={ContentVariants.p} className="pf-v6-u-py-md" style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
              No backups found. Backups are created automatically when saving the mirrorlist.
            </Content>
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
            <Table aria-label="Mirrorlist backups" variant="compact">
              <Thead noWrap>
                <Tr>
                  <Th screenReaderText="Select">
                    <Checkbox
                      id={selectAllId}
                      isChecked={allBackupsSelected ? true : someBackupsSelected ? null : false}
                      onChange={(_event, checked) => checked ? selectAllBackups() : deselectAllBackups()}
                      aria-label="Select all backups"
                    />
                  </Th>
                  <Th>Date</Th>
                  <Th>Mirrors</Th>
                  <Th>Origin</Th>
                  <Th>Size</Th>
                  <Th width={15} screenReaderText="Actions" />
                </Tr>
              </Thead>
              <Tbody>
                {backups.map((backup) => (
                  <Tr key={backup.timestamp}>
                    <RowSelectCell
                      label={`Select backup from ${backup.date}`}
                      isSelected={selectedBackups.has(backup.timestamp)}
                      onSelect={() => toggleBackupSelection(backup.timestamp)}
                    />
                    <Td dataLabel="Date">
                      <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsSm" }}>
                        <FlexItem><HistoryIcon /></FlexItem>
                        <FlexItem><TimeAgo timestamp={backup.timestamp} /></FlexItem>
                      </Flex>
                    </Td>
                    <Td dataLabel="Mirrors">
                      {backup.enabled_count} enabled / {backup.total_count} total
                    </Td>
                    <Td dataLabel="Origin">
                      <Label isCompact color={backup.source === "manual" ? "blue" : "grey"}>
                        {backup.source === "manual" ? "Manual" : "Automatic"}
                      </Label>{" "}
                      <HelpPopover
                        label={`${backup.source === "manual" ? "manual" : "automatic"} backups`}
                        body={
                          backup.source === "manual"
                            ? "Taken when you saved. Kept ahead of automatic ones when old backups are pruned."
                            : "Taken automatically before a restore. Pruned first."
                        }
                      />
                    </Td>
                    <Td dataLabel="Size">{formatSize(backup.size)}</Td>
                    <Td dataLabel="Actions">
                      <Flex spaceItems={{ default: "spaceItemsSm" }} flexWrap={{ default: "nowrap" }}>
                        <FlexItem>
                          <GatedButton
                            gate={restoreGate}
                            disabledReason={backupBlockedReason}
                            variant="secondary"
                            size="sm"
                            onClick={() => hasChanges ? setRestoreTarget(backup.timestamp) : handleRestore(backup.timestamp)}
                            isLoading={editor.restoring === backup.timestamp}
                          >
                            Restore
                          </GatedButton>
                        </FlexItem>
                        <FlexItem>
                          <GatedButton
                            gate={deleteBackupGate}
                            disabledReason={backupBlockedReason}
                            variant="plain"
                            aria-label={`Delete backup from ${backup.date}`}
                            onClick={() => setDeleteTargets([backup.timestamp])}
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

        <ConfigFileText
          path={mirrorData?.path || "/etc/pacman.d/mirrorlist"}
          isExpanded={fileTextExpanded}
          onToggle={setFileTextExpanded}
          isDirty={hasChanges}
          reloadKey={fileReloadKey}
        />

        {statusData && (
          <div className="pf-v6-u-mt-md" style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)" }}>
            Mirror status from archlinux.org: {statusData.last_check || "Unknown"}
            {getCacheAge() !== null && ` (cached ${formatCacheAge(getCacheAge()!)})`}
            {statusStale && " - couldn't refresh, may be outdated"}
          </div>
        )}
      </CardBody>

      {refreshModal}

      <ConfirmModal
        isOpen={deleteTargets !== null}
        title={deleteTargets?.length === 1 ? "Delete mirrorlist backup?" : "Delete mirrorlist backups?"}
        severity="warning"
        commitVariant="danger"
        commitLabel={deleteLabel(deleteTargets ?? [])}
        gate={deleteBackupGate}
        onConfirm={() => deleteTargets !== null && handleDeleteBackups(deleteTargets)}
        onClose={() => setDeleteTargets(null)}
      >
        A deleted backup cannot be restored or recovered. The current
        <code> {file}</code> is not changed.
      </ConfirmModal>

      <RestoreGuardModal
        isOpen={restoreTarget !== null}
        file={file}
        fileLabel="mirrorlist"
        changes={pendingChanges}
        backupDate={backups.find(b => b.timestamp === restoreTarget)?.date}
        onConfirm={() => restoreTarget !== null && handleRestore(restoreTarget)}
        onCancel={() => setRestoreTarget(null)}
      />
    </Card>
    </>
  );
};

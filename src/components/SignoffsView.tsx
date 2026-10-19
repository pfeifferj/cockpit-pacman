import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from "react";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  Checkbox,
  Spinner,
  Button,
  Label,
  Pagination,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToggleGroup,
  ToggleGroupItem,
  SearchInput,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  EmptyStateActions,
  CodeBlock,
  CodeBlockCode,
  Flex,
  FlexItem,
  MenuToggle,
  Select,
  SelectOption,
  SelectList,
  Content,
  ContentVariants,
  AlertActionLink,
  AlertActionCloseButton,
  AlertGroup,
  ClipboardCopyButton,
  CodeBlockAction,
  Progress,
  ProgressMeasureLocation,
} from "@patternfly/react-core";
import { CompactPagination } from "./CompactPagination";
import {
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
} from "@patternfly/react-table";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  SyncAltIcon,
} from "@patternfly/react-icons";
import type {
  KeyringCredentials,
  SignoffGroupWithLocal,
  SignoffListResponse,
  SignoffTarget,
  ErrorCode,
} from "../api";
import {
  getSignoffList,
  signoffPackage,
  signoffPackages,
  SIGNOFF_BATCH_LIMIT,
  revokeSignoff,
  BackendError,
} from "../api";
import { isNetworkError } from "../offline";
import { vercmp } from "../vercmp";
import type { CredentialErrorReason } from "../keyring";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { useTabActive } from "../hooks/useRefreshOnActivate";
import { useRouteOptionsSync, type RouteOptions } from "../hooks/useRoute";
import { usePagination } from "../hooks/usePagination";
import { useSortableTable } from "../hooks/useSortableTable";
import { PackageDetailsDrawer, DETAILS_TRIGGER_ATTR, detailsRowProps } from "./PackageDetailsDrawer";
import { returnFocusToRow } from "../rowFocus";
import { helpInfo } from "./HelpPopover";
import { NetworkErrorState } from "./NetworkErrorState";
import { ConfirmModal } from "./ConfirmModal";
import { GatedButton } from "./GatedButton";
import { UndoAlert } from "./UndoAlert";
import { plural, REPO_NAME_RE, sanitizeErrorMessage, sanitizeSearchInput } from "../utils";
import { LoadErrorState, RefreshFailedAlert, toLoadFailure, type LoadFailure } from "./LoadErrorState";
import { ErrorDetails } from "./ErrorDetails";
import { RowSelectCell } from "./RowSelectCell";
import { PER_PAGE_OPTIONS } from "../constants";

type SignoffFilter = "installed" | "pending" | "unsigned" | "signed" | "bad";

const FILTER_ORDER: SignoffFilter[] = ["installed", "pending", "unsigned", "signed", "bad"];
export const SIGNOFF_TILE_FILTER = "installed,pending,unsigned";
const DEFAULT_FILTERS: ReadonlySet<SignoffFilter> = new Set(SIGNOFF_TILE_FILTER.split(",") as SignoffFilter[]);
export const SIGNOFF_STALE_MS = 5 * 60_000;

const isInstalled = (g: SignoffGroupWithLocal) => g.version_match !== "not_installed";
const isPending = (g: SignoffGroupWithLocal) =>
  !g.approved && !g.known_bad && g.signoffs.filter((s) => !s.revoked).length < g.required;
const isSignedBy = (g: SignoffGroupWithLocal, user: string) =>
  g.signoffs.some((s) => !s.revoked && s.user === user);
const isKnownBad = (g: SignoffGroupWithLocal) => g.known_bad;
const signoffKey = (g: SignoffTarget) => `${g.pkgbase}\0${g.repo}\0${g.arch}`;
const canSignOff = (g: SignoffGroupWithLocal, user: string) => !g.known_bad && !isSignedBy(g, user);

const sameSet = <T,>(a: ReadonlySet<T>, b: ReadonlySet<T>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Empty means the tile filter; "all" means no filter. */
export function encodeSignoffFilters(filters: ReadonlySet<SignoffFilter>): string {
  if (sameSet(filters, DEFAULT_FILTERS)) return "";
  if (filters.size === 0) return "all";
  return FILTER_ORDER.filter((f) => filters.has(f)).join(",");
}

export function decodeSignoffFilters(value: string | undefined): Set<SignoffFilter> {
  if (!value) return new Set(DEFAULT_FILTERS);
  if (value === "all") return new Set();
  const parsed = value.split(",").filter((f): f is SignoffFilter => (FILTER_ORDER as string[]).includes(f));
  return parsed.length > 0 ? new Set(parsed) : new Set(DEFAULT_FILTERS);
}

export function matchesSignoffFilters(g: SignoffGroupWithLocal, filters: ReadonlySet<SignoffFilter>, user: string): boolean {
  if (filters.has("installed") && !isInstalled(g)) return false;
  if (filters.has("pending") && !isPending(g)) return false;
  if (filters.has("unsigned") && isSignedBy(g, user)) return false;
  if (filters.has("signed") && !isSignedBy(g, user)) return false;
  if (filters.has("bad") && !isKnownBad(g)) return false;
  return true;
}

export function countToSignOff(groups: SignoffGroupWithLocal[], user: string): number {
  const filters = decodeSignoffFilters(SIGNOFF_TILE_FILTER);
  return groups.filter((g) => matchesSignoffFilters(g, filters, user)).length;
}

function parseRoute(options: RouteOptions): RouteOptions {
  return {
    q: sanitizeSearchInput(options.q ?? ""),
    filter: encodeSignoffFilters(decodeSignoffFilters(options.filter)),
    in: options.in && REPO_NAME_RE.test(options.in) && options.in !== "all" ? options.in : "",
    pkg: options.pkg ?? "",
    repo: options.pkg ? options.repo ?? "" : "",
  };
}

interface DetailsTarget {
  name: string;
  repo?: string;
}

const signoffErrorText = (err: unknown) => sanitizeErrorMessage(err instanceof Error ? err.message : null);
const errorCodeOf = (err: unknown): ErrorCode | undefined => (err instanceof BackendError ? err.code : undefined);

const storeCommand = (username?: string) =>
  'secret-tool store --label="ArchWeb (cockpit-pacman)" service cockpit-pacman type archweb username ' +
  (username && /^[A-Za-z0-9._@-]+$/.test(username) ? username : "YOUR_ARCHWEB_USERNAME");

const UNAVAILABLE_TEXT: Record<CredentialErrorReason, { title: string; body: string | null; showStore: boolean }> = {
  absent: {
    title: "No ArchWeb credentials",
    body: "No ArchWeb item was found in the login keyring. Store one, then try again.",
    showStore: true,
  },
  locked: {
    title: "Keyring locked",
    body: "The login keyring is locked. Unlock it, for example by starting a desktop session, then try again.",
    showStore: false,
  },
  malformed: {
    title: "ArchWeb credentials incomplete",
    body: "The ArchWeb keyring item is missing its username or password. Store it again, then try again.",
    showStore: true,
  },
  failed: { title: "Could not read the keyring", body: null, showStore: false },
};

const REJECTED_TEXT = {
  title: "ArchWeb rejected the stored credentials",
  body: "The username or password in the ArchWeb keyring item was not accepted. Store the current password, then try again.",
  showStore: true,
};

interface SignoffsViewProps {
  credentials: KeyringCredentials | null;
  unavailable?: { reason: CredentialErrorReason; message: string };
  onRetryCredentials?: () => Promise<void>;
  routeOptions?: RouteOptions;
  onRouteChange?: (options: RouteOptions) => void;
  onToSignOffCount?: (count: number) => void;
}

const StoreCommand: React.FC<{ username?: string }> = ({ username }) => {
  const [copied, setCopied] = useState(false);
  const id = useId();
  const command = storeCommand(username);
  return (
    <CodeBlock
      className="pf-v6-u-mt-md"
      actions={
        <CodeBlockAction>
          <ClipboardCopyButton
            id={`${id}-copy`}
            textId={`${id}-code`}
            aria-label="Copy the store command"
            onClick={() => {
              window.navigator.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false));
            }}
            exitDelay={copied ? 1500 : 600}
            variant="plain"
            onTooltipHidden={() => setCopied(false)}
          >
            {copied ? "Copied" : "Copy the store command"}
          </ClipboardCopyButton>
        </CodeBlockAction>
      }
    >
      <CodeBlockCode id={`${id}-code`}>{command}</CodeBlockCode>
    </CodeBlock>
  );
};

const CredentialsUnavailable: React.FC<{
  text: { title: string; body: string | null; showStore: boolean };
  message: string;
  status: "danger" | "warning";
  onRetry?: () => Promise<void>;
  username?: string;
}> = ({ text, message, status, onRetry, username }) => {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Card>
      <CardBody>
        <EmptyState
          headingLevel="h3"
          icon={ExclamationTriangleIcon}
          titleText={text.title}
          status={status}
        >
          <EmptyStateBody>
            {text.body ?? message}
            {text.showStore && <StoreCommand username={username} />}
          </EmptyStateBody>
          {onRetry && (
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={retry} isLoading={retrying} isDisabled={retrying}>
                  Try again
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          )}
        </EmptyState>
      </CardBody>
    </Card>
  );
};

const SIGNOFF_STATUS_HELP = (
  <Content>
    <Content component={ContentVariants.p}>
      Signoffs are part of Arch&apos;s package testing pipeline. Package maintainers install and test packages from [testing] repositories, then sign them off.
    </Content>
    <Content component={ContentVariants.dl}>
      <Content component={ContentVariants.dt}>Pending</Content>
      <Content component={ContentVariants.dd}>Waiting for package maintainers to test and sign off.</Content>
      <Content component={ContentVariants.dt}>Approved</Content>
      <Content component={ContentVariants.dd}>Has enough signoffs to move to stable repositories.</Content>
      <Content component={ContentVariants.dt}>Known bad</Content>
      <Content component={ContentVariants.dd}>Flagged as broken by a package maintainer. Do not sign off.</Content>
    </Content>
  </Content>
);


const REFUSED = "ArchWeb refused the request.";

interface ActionFailure extends LoadFailure {
  title: string;
  retry: () => void;
}

interface BulkResult {
  total: number;
  succeeded: string[];
  failed: ({ name: string } & LoadFailure)[];
  notSent: string[];
}

interface FlaggedRow {
  key: string;
  name: string;
  reason: string;
}

function pruneSelection(selected: Set<string>, groups: SignoffGroupWithLocal[], user: string): Set<string> {
  const valid = new Set(groups.filter((g) => canSignOff(g, user)).map(signoffKey));
  const next = new Set([...selected].filter((key) => valid.has(key)));
  return next.size === selected.size ? selected : next;
}

type SignoffKind = "signoff" | "revoke";
type RowResult = "signed" | "revoked" | "failed";

const ROW_RESULT_LABEL: Record<RowResult, { text: string; color: "green" | "grey" | "red" }> = {
  signed: { text: "Signed off", color: "green" },
  revoked: { text: "Revoked", color: "grey" },
  failed: { text: "Failed", color: "red" },
};

const activeSignoffs = (g: SignoffGroupWithLocal) => g.signoffs.filter((s) => !s.revoked).length;

export function patchSignoffGroup(g: SignoffGroupWithLocal, kind: SignoffKind, user: string, now: string): SignoffGroupWithLocal {
  const signoffs = kind === "signoff"
    ? [...g.signoffs, { user, created: now, revoked: false }]
    : g.signoffs.map((s) => (s.user === user && !s.revoked ? { ...s, revoked: true } : s));
  const next = { ...g, signoffs };
  return { ...next, approved: !g.known_bad && activeSignoffs(next) >= g.required };
}

interface SignoffResult {
  title: string;
  undoLabel: string;
  onUndo: () => void;
}

const BulkResultAlert: React.FC<{
  result: BulkResult | null;
  onRetry: () => void;
  retryDisabled: boolean;
  retryCount: number;
  onClose: () => void;
}> = ({ result, onRetry, retryDisabled, retryCount, onClose }) => {
  let alert: React.ReactNode = null;
  if (result) {
    const incomplete = result.failed.length > 0 || result.notSent.length > 0;
    const title = incomplete
      ? `Signed off ${result.succeeded.length} of ${plural(result.total, "package")}`
      : `Signed off ${plural(result.succeeded.length, "package")}`;
    alert = (
      <Alert
        variant={result.failed.length > 0 ? "danger" : incomplete ? "warning" : "success"}
        isInline
        title={title}
        className="pf-v6-u-mb-md"
        actionClose={<AlertActionCloseButton title={title} onClose={onClose} />}
        actionLinks={incomplete && retryCount > 0 ? (
          <AlertActionLink onClick={onRetry} isAriaDisabled={retryDisabled}>
            Try again for {plural(retryCount, "package")}
          </AlertActionLink>
        ) : undefined}
      >
        {result.failed.length > 0 && (
          <>
            Failed, still selected:
            <ul>
              {result.failed.map((f) => <li key={f.name}>{f.name}: {f.message}<ErrorDetails details={f.details} /></li>)}
            </ul>
          </>
        )}
        {result.notSent.length > 0 && <div>Stopped before: {result.notSent.join(", ")}</div>}
        {result.succeeded.length > 0 && <div>Signed off: {result.succeeded.join(", ")}</div>}
      </Alert>
    );
  }
  return <AlertGroup isLiveRegion>{alert}</AlertGroup>;
};

const SELECT_PAGE_ID = "select-all-signoffs";

export const SignoffsView: React.FC<SignoffsViewProps> = ({
  credentials, unavailable, onRetryCredentials, routeOptions, onRouteChange, onToSignOffCount,
}) => {
  const username = credentials?.username ?? "";
  const [initialRoute] = useState(() => parseRoute(routeOptions ?? {}));
  const [loading, setLoading] = useState(credentials !== null);
  const [data, setData] = useState<SignoffListResponse | null>(null);
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);
  const [rejected, setRejected] = useState(false);
  const [retryingCredentials, setRetryingCredentials] = useState(false);
  const [actionFailure, setActionFailure] = useState<ActionFailure | null>(null);
  const [undo, setUndo] = useState<SignoffResult | null>(null);
  const [search, setSearch] = useState(initialRoute.q);
  const [filters, setFilters] = useState<Set<SignoffFilter>>(() => decodeSignoffFilters(initialRoute.filter));
  const [actionInProgress, setActionInProgress] = useState<{ key: string; kind: SignoffKind } | null>(null);
  // Rows whose change is confirmed but whose list reload has not settled yet.
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const [rowResults, setRowResults] = useState<ReadonlyMap<string, RowResult>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkStopping, setBulkStopping] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<FlaggedRow[] | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [repoFilter, setRepoFilter] = useState(initialRoute.in || "all");
  const [repoSelectOpen, setRepoSelectOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const verbRefs = useRef(new Map<string, React.ComponentRef<"button">>());
  const focusRequestRef = useRef<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  // Set synchronously so a second activation before the next render sends nothing.
  const inFlightRef = useRef(new Set<string>());
  const bulkStopRef = useRef(false);
  const lastLoadedRef = useRef(0);
  const loadSeqRef = useRef(0);
  const { selectedPackage, detailsLoading, detailsError, detailsErrorCode, detailsErrorContext, fetchDetails, clearDetails } = usePackageDetails();
  const [detailsTarget, setDetailsTarget] = useState<DetailsTarget | null>(
    initialRoute.pkg ? { name: initialRoute.pkg, repo: initialRoute.repo || undefined } : null,
  );
  const [detailsRow, setDetailsRow] = useState<string | null>(null);
  const { page, perPage, onSetPage, onPerPageSelect, resetPage } = usePagination({ defaultPerPage: 20 });

  // Column indices: 0=checkbox, 1=package, 2=version, 3=local, 4=signoffs, 5=status, 6=actions
  const sortColumns = { package: 1, version: 2, signoffs: 4, status: 5 } as const;
  type SortKey = keyof typeof sortColumns;
  const { activeSortKey, activeSortDirection, getSortParams } = useSortableTable<SortKey>({
    columns: sortColumns,
    defaultDirection: "asc",
  });

  const detailsKey = !detailsTarget ? null : detailsRow ?? (() => {
    const group = data?.signoff_groups.find((g) =>
      g.pkgbase === detailsTarget.name && (!detailsTarget.repo || g.repo === detailsTarget.repo));
    return group ? signoffKey(group) : null;
  })();

  useRouteOptionsSync(
    routeOptions,
    onRouteChange,
    {
      q: search,
      filter: encodeSignoffFilters(filters),
      in: repoFilter === "all" ? "" : repoFilter,
      pkg: detailsTarget?.name,
      repo: detailsTarget?.repo,
    },
    parseRoute,
    (options) => {
      if (options.q !== search) setSearch(options.q);
      const next = decodeSignoffFilters(options.filter);
      if (!sameSet(next, filters)) setFilters(next);
      if ((options.in || "all") !== repoFilter) setRepoFilter(options.in || "all");
      setRowResults(new Map());
      resetPage();
      if (`${options.pkg}|${options.repo}` !== `${detailsTarget?.name ?? ""}|${detailsTarget?.repo ?? ""}`) {
        if (!options.pkg) returnFocusToRow(detailsKey, DETAILS_TRIGGER_ATTR);
        setDetailsRow(null);
        setDetailsTarget(options.pkg ? { name: options.pkg, repo: options.repo || undefined } : null);
      }
    },
  );

  useEffect(() => {
    if (detailsTarget) {
      fetchDetails(detailsTarget.name, detailsTarget.repo ? { strategy: "sync", repo: detailsTarget.repo } : { strategy: "local-then-sync" });
    } else {
      clearDetails();
    }
  }, [detailsTarget, fetchDetails, clearDetails]);

  const settle = useCallback(
    (request: Promise<SignoffListResponse>, isCurrent: () => boolean, user: string, keepResults = false) =>
      request
        .then((result) => {
          if (!isCurrent()) return;
          setData(result);
          setSelected((prev) => pruneSelection(prev, result.signoff_groups, user));
          if (!keepResults) setRowResults(new Map());
          setLoadError(null);
          setRejected(false);
          lastLoadedRef.current = Date.now();
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          const code = errorCodeOf(err);
          if (code === "permission_denied") setRejected(true);
          else setLoadError(toLoadFailure(err));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        }),
    [],
  );

  const loadSignoffs = useCallback(async (keepResults = false) => {
    if (!credentials) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    await settle(getSignoffList(credentials), () => seq === loadSeqRef.current, credentials.username, keepResults);
  }, [credentials, settle]);
  const reload = useCallback(() => { loadSignoffs(); }, [loadSignoffs]);

  useEffect(() => {
    if (!credentials) return;
    let cancelled = false;
    const seq = ++loadSeqRef.current;
    settle(getSignoffList(credentials), () => !cancelled && seq === loadSeqRef.current, credentials.username);
    return () => { cancelled = true; };
  }, [credentials, settle]);

  // Every list call logs in to ArchWeb, so activation reloads only stale data.
  const active = useTabActive();
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active && !wasActive && lastLoadedRef.current > 0 && Date.now() - lastLoadedRef.current >= SIGNOFF_STALE_MS) {
      loadSignoffs();
    }
  }, [active, loadSignoffs]);

  const toSignOff = useMemo(() => (data ? countToSignOff(data.signoff_groups, username) : null), [data, username]);
  useEffect(() => {
    if (toSignOff !== null) onToSignOffCount?.(toSignOff);
  }, [toSignOff, onToSignOffCount]);

  const requestFocus = (key: string) => {
    focusRequestRef.current = key;
    setFocusTick((t) => t + 1);
  };
  useEffect(() => {
    const key = focusRequestRef.current;
    if (key === null) return;
    focusRequestRef.current = null;
    const target = verbRefs.current.get(key) ?? document.getElementById(key);
    if (target && !(target as HTMLInputElement).disabled) target.focus();
    else searchInputRef.current?.focus();
  }, [focusTick]);

  const busy = actionInProgress !== null || bulkProgress !== null;

  const patchData = (keys: ReadonlySet<string>, kind: SignoffKind) => {
    const now = new Date().toISOString();
    setData((prev) => prev && {
      ...prev,
      signoff_groups: prev.signoff_groups.map((g) =>
        keys.has(signoffKey(g)) ? patchSignoffGroup(g, kind, username, now) : g),
    });
  };

  const markResults = (results: [string, RowResult][]) =>
    setRowResults((prev) => new Map([...prev, ...results]));

  const startSettling = (keys: string[]) => {
    for (const key of keys) inFlightRef.current.add(key);
    setSettling((prev) => new Set([...prev, ...keys]));
  };

  const endSettling = (keys: string[]) => {
    for (const key of keys) inFlightRef.current.delete(key);
    setSettling((prev) => new Set([...prev].filter((k) => !keys.includes(k))));
  };

  const runAction = async (group: SignoffGroupWithLocal, kind: SignoffKind, fromRow = false) => {
    const key = signoffKey(group);
    if (!credentials || inFlightRef.current.has(key)) return;
    startSettling([key]);
    setActionInProgress({ key, kind });
    setActionFailure(null);
    setUndo(null);
    setBulkResult(null);
    const failTitle = kind === "signoff" ? `Sign off failed for ${group.pkgbase}` : `Revoke failed for ${group.pkgbase}`;
    const retry = () => { runAction(group, kind); };
    let credentialsRejected = false;
    try {
      const call = kind === "signoff" ? signoffPackage : revokeSignoff;
      const result = await call(group.pkgbase, group.repo, group.arch, credentials);
      if (result.success) {
        const patched = patchSignoffGroup(group, kind, username, "");
        const inverse: SignoffKind = kind === "signoff" ? "revoke" : "signoff";
        let title = kind === "signoff"
          ? `Signed off ${group.pkgbase} ${group.version}`
          : `Signoff for ${group.pkgbase} revoked`;
        if (patched.approved && !group.approved) title += `; ${group.pkgbase} is now approved`;
        if (!patched.approved && group.approved) title += `; ${group.pkgbase} is no longer approved`;
        patchData(new Set([key]), kind);
        markResults([[key, kind === "signoff" ? "signed" : "revoked"]]);
        setUndo({
          title,
          undoLabel: kind === "signoff" ? "Revoke" : "Sign off again",
          onUndo: () => { runAction(patched, inverse); },
        });
      } else {
        markResults([[key, "failed"]]);
        setActionFailure({ title: failTitle, message: result.error || REFUSED, retry });
      }
    } catch (err) {
      if (errorCodeOf(err) === "permission_denied") {
        credentialsRejected = true;
        setRejected(true);
      } else {
        markResults([[key, "failed"]]);
        setActionFailure({ title: failTitle, ...toLoadFailure(err), message: signoffErrorText(err), retry });
      }
    } finally {
      setActionInProgress(null);
    }
    if (fromRow) requestFocus(key);
    if (!credentialsRejected) await loadSignoffs(true);
    endSettling([key]);
  };

  const retryCredentials = async () => {
    setRetryingCredentials(true);
    try {
      if (onRetryCredentials) await onRetryCredentials();
      else await loadSignoffs(true);
    } finally {
      setRetryingCredentials(false);
    }
  };

  const toggleSelection = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleFilter = (f: SignoffFilter) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) {
        next.delete(f);
      } else {
        next.add(f);
        if (f === "signed") next.delete("unsigned");
        if (f === "unsigned") next.delete("signed");
      }
      return next;
    });
    setRowResults(new Map());
    resetPage();
  };

  const filterCounts = useMemo(() => {
    const groups = data?.signoff_groups ?? [];
    return {
      all: groups.length,
      installed: groups.filter(isInstalled).length,
      pending: groups.filter(isPending).length,
      unsigned: groups.filter((g) => !isSignedBy(g, username)).length,
      signed: groups.filter((g) => isSignedBy(g, username)).length,
      bad: groups.filter(isKnownBad).length,
    };
  }, [data, username]);

  const repositories = useMemo(() => {
    const groups = data?.signoff_groups ?? [];
    return [...new Set(groups.map((g) => g.repo))].sort();
  }, [data]);

  // Preserve result labels when an action moves its row out of the filter.
  const filteredGroups = useMemo(() => {
    const groups = data?.signoff_groups ?? [];
    const filtered = groups.filter((g) => {
      if (repoFilter !== "all" && g.repo !== repoFilter) return false;
      if (search) {
        const lower = search.toLowerCase();
        const matchesSearch =
          g.pkgbase.toLowerCase().includes(lower) ||
          g.pkgnames.some((n) => n.toLowerCase().includes(lower)) ||
          g.repo.toLowerCase().includes(lower);
        if (!matchesSearch) return false;
      }
      return rowResults.has(signoffKey(g)) || matchesSignoffFilters(g, filters, username);
    });
    if (!activeSortKey) return filtered;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (activeSortKey) {
        case "package":
          cmp = a.pkgbase.localeCompare(b.pkgbase);
          break;
        case "version":
          cmp = vercmp(a.version, b.version);
          break;
        case "signoffs":
          cmp = activeSignoffs(a) - activeSignoffs(b);
          break;
        case "status": {
          const rank = (g: SignoffGroupWithLocal) => g.known_bad ? 0 : g.approved ? 2 : 1;
          cmp = rank(a) - rank(b);
          break;
        }
      }
      return activeSortDirection === "asc" ? cmp : -cmp;
    });
  }, [data, search, filters, repoFilter, username, rowResults, activeSortKey, activeSortDirection]);

  const pagedGroups = useMemo(() => {
    const start = (page - 1) * perPage;
    return filteredGroups.slice(start, start + perPage);
  }, [filteredGroups, page, perPage]);

  const isSelectable = (g: SignoffGroupWithLocal) => canSignOff(g, username) && !settling.has(signoffKey(g));

  const selectableGroups = filteredGroups.filter(isSelectable);
  const pageSelectable = pagedGroups.filter(isSelectable);

  const selectedGroups = useMemo(
    () => (data?.signoff_groups ?? []).filter((g) => selected.has(signoffKey(g)) && canSignOff(g, username)),
    [data, selected, username],
  );

  const addToSelection = (groups: SignoffGroupWithLocal[]) =>
    setSelected((prev) => new Set([...prev, ...groups.map(signoffKey)]));
  const deselectPage = () => setSelected((prev) => {
    const next = new Set(prev);
    for (const g of pageSelectable) next.delete(signoffKey(g));
    return next;
  });
  const isPageSelected = pageSelectable.length > 0 && pageSelectable.every((g) => selected.has(signoffKey(g)));
  const isPagePartlySelected = pageSelectable.some((g) => selected.has(signoffKey(g)));
  const areAllFilteredSelected = selectableGroups.every((g) => selected.has(signoffKey(g)));
  const selectedCount = selectedGroups.length;
  const onPageKeys = new Set(pagedGroups.map(signoffKey));
  const notShownCount = selectedGroups.filter((g) => !onPageKeys.has(signoffKey(g))).length;

  const flaggedRows = (): FlaggedRow[] => selectedGroups.flatMap((g) => {
    const key = signoffKey(g);
    if (g.version_match === "not_installed") return [{ key, name: g.pkgbase, reason: "not installed here" }];
    if (g.version_match === "mismatch") {
      return [{ key, name: g.pkgbase, reason: `installed ${g.local_version}, signoff is for ${g.version}` }];
    }
    return [];
  });

  const runBulk = async (toSign: SignoffGroupWithLocal[]) => {
    setBulkConfirm(null);
    const sendable = toSign.filter((g) => !inFlightRef.current.has(signoffKey(g)));
    if (!credentials || sendable.length === 0) return;
    const keys = sendable.map(signoffKey);
    startSettling(keys);
    setBulkResult(null);
    setUndo(null);
    setActionFailure(null);
    bulkStopRef.current = false;
    setBulkStopping(false);
    setBulkProgress({ done: 0, total: sendable.length });
    const succeeded: string[] = [];
    const failed: BulkResult["failed"] = [];
    const notSent: string[] = [];
    const keep = new Set<string>();
    let credentialsRejected = false;
    for (let offset = 0; offset < sendable.length; offset += SIGNOFF_BATCH_LIMIT) {
      const batch = sendable.slice(offset, offset + SIGNOFF_BATCH_LIMIT);
      if (bulkStopRef.current) {
        for (const group of batch) {
          notSent.push(group.pkgbase);
          keep.add(signoffKey(group));
        }
        continue;
      }
      const targets = batch.map(({ pkgbase, repo, arch }) => ({ pkgbase, repo, arch }));
      try {
        const response = await signoffPackages(targets, credentials);
        const results = new Map(response.results.map((result) => [signoffKey(result.target), result]));
        for (const group of batch) {
          const key = signoffKey(group);
          const result = results.get(key);
          if (result?.success) {
            succeeded.push(group.pkgbase);
            patchData(new Set([key]), "signoff");
            markResults([[key, "signed"]]);
          } else {
            failed.push({ name: group.pkgbase, message: result?.error || "No successful signoff result received" });
            markResults([[key, "failed"]]);
            keep.add(key);
          }
        }
      } catch (err) {
        const failure = toLoadFailure(err);
        for (const group of batch) {
          const key = signoffKey(group);
          keep.add(key);
          failed.push({ name: group.pkgbase, ...failure });
          markResults([[key, "failed"]]);
        }
        if (failure.code === "permission_denied") {
          credentialsRejected = true;
          bulkStopRef.current = true;
        }
      }
      setBulkProgress({ done: offset + batch.length, total: sendable.length });
    }
    setSelected(keep);
    setBulkProgress(null);
    setBulkStopping(false);
    setBulkResult({ total: sendable.length, succeeded, failed, notSent });
    requestFocus(SELECT_PAGE_ID);
    if (credentialsRejected) setRejected(true);
    else await loadSignoffs(true);
    endSettling(keys);
  };

  const requestBulkSignoff = () => {
    const flagged = flaggedRows();
    if (flagged.length > 0) setBulkConfirm(flagged);
    else runBulk(selectedGroups);
  };

  const stopBulk = () => {
    bulkStopRef.current = true;
    setBulkStopping(true);
  };

  const renderVersionMatch = (group: SignoffGroupWithLocal) => {
    if (group.version_match === "match") {
      return <Label color="green" icon={<CheckCircleIcon />} isCompact>{group.local_version}</Label>;
    }
    if (group.version_match === "mismatch") {
      return <Label color="orange" icon={<ExclamationTriangleIcon />} isCompact>{group.local_version}</Label>;
    }
    return <Label color="grey" isCompact>not installed</Label>;
  };

  const renderStatus = (group: SignoffGroupWithLocal) => {
    if (group.known_bad) return <Label color="red" isCompact>Known bad</Label>;
    if (group.approved) return <Label color="green" isCompact>Approved</Label>;
    return <Label color="blue" isCompact>Pending</Label>;
  };

  const isDefaultView = sameSet(filters, DEFAULT_FILTERS) && !search && repoFilter === "all";
  const hasFilters = filters.size > 0 || !!search || repoFilter !== "all";

  // Sign off the build in group.repo, even when another version is installed.
  const showDetails = (group: SignoffGroupWithLocal) => {
    setDetailsRow(signoffKey(group));
    setDetailsTarget((current) =>
      current?.name === group.pkgbase && current.repo === group.repo ? current : { name: group.pkgbase, repo: group.repo });
  };

  // Prevent row activation while preserving drawer keyboard controls.
  const stopRowActivation = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  };

  const closeDetails = () => {
    setDetailsRow(null);
    setDetailsTarget(null);
  };

  const handleClearFilter = () => {
    setSearch("");
    setFilters(new Set());
    setRepoFilter("all");
    setRowResults(new Map());
    resetPage();
    searchInputRef.current?.focus();
  };

  if (!credentials) {
    const reason = unavailable?.reason ?? "failed";
    return (
      <CredentialsUnavailable
        text={UNAVAILABLE_TEXT[reason]}
        status={reason === "failed" ? "danger" : "warning"}
        message={unavailable?.message ?? "ArchWeb credentials are not available."}
        onRetry={onRetryCredentials}
      />
    );
  }

  if (rejected && !data) {
    return (
      <CredentialsUnavailable
        text={REJECTED_TEXT}
        status="warning"
        message=""
        onRetry={retryCredentials}
        username={username}
      />
    );
  }

  if (!data && loadError && isNetworkError(null, loadError.code)) {
    return (
      <Card>
        <CardBody>
          <NetworkErrorState resource="the signoff list" onRetry={reload} />
        </CardBody>
      </Card>
    );
  }

  if (!data && loadError) {
    return (
      <Card>
        <CardBody>
          <LoadErrorState what="signoffs" error={loadError.message} details={loadError.details} onRetry={reload} />
        </CardBody>
      </Card>
    );
  }

  const bulkTotal = bulkProgress?.total ?? 0;
  const bulkCurrent = bulkProgress ? Math.min(bulkProgress.done + 1, bulkTotal) : 0;
  const busyReason = busy ? "Wait for the current signoff request to finish"
    : settling.size > 0 ? "Wait for the signoff list to reload" : null;
  const blockReason = rejected ? REJECTED_TEXT.title : busyReason;

  return (
    <>
      <AlertGroup isLiveRegion>
        {rejected && (
          <Alert
            variant="danger"
            isInline
            title={REJECTED_TEXT.title}
            className="pf-v6-u-mb-md"
            actionLinks={
              <AlertActionLink onClick={retryCredentials} isAriaDisabled={retryingCredentials}>Try again</AlertActionLink>
            }
          >
            {REJECTED_TEXT.body} The list below is from the last successful load.
            <StoreCommand username={username} />
          </Alert>
        )}
        {actionFailure && (
          <Alert
            variant="warning"
            isInline
            title={actionFailure.title}
            className="pf-v6-u-mb-md"
            actionClose={<AlertActionCloseButton title={actionFailure.title} onClose={() => setActionFailure(null)} />}
            actionLinks={
              <AlertActionLink onClick={actionFailure.retry} isAriaDisabled={busy || settling.size > 0 || rejected}>Try again</AlertActionLink>
            }
          >
            {actionFailure.message}
            <ErrorDetails details={actionFailure.details} />
          </Alert>
        )}
      </AlertGroup>
      {loadError && (
        <RefreshFailedAlert
          what="signoffs"
          error={loadError.message}
          details={loadError.details}
          onRetry={reload}
          onClose={() => setLoadError(null)}
        />
      )}
      <UndoAlert
        title={undo?.title ?? null}
        onUndo={undo?.onUndo}
        undoLabel={undo?.undoLabel}
        disabledReason={blockReason ?? (settling.size > 0 ? "Wait for the signoff list to reload" : null)}
        onClose={() => setUndo(null)}
      />
      <BulkResultAlert
        result={bulkResult}
        onRetry={requestBulkSignoff}
        retryDisabled={busy || settling.size > 0 || rejected || selectedCount === 0}
        retryCount={selectedCount}
        onClose={() => setBulkResult(null)}
      />
      <Card>
      <CardBody>
      <Toolbar>
        <ToolbarContent>
          <ToolbarItem>
            <SearchInput
              ref={searchInputRef}
              placeholder="Filter packages…"
              value={search}
              onChange={(_event, value) => { setSearch(value); setRowResults(new Map()); resetPage(); }}
              onClear={() => { setSearch(""); setRowResults(new Map()); resetPage(); }}
            />
          </ToolbarItem>
          <ToolbarItem>
            <ToggleGroup aria-label="Signoff filter">
              <ToggleGroupItem
                text={<>Installed <Badge isRead>{filterCounts.installed}</Badge></>}
                isSelected={filters.has("installed")}
                onChange={() => toggleFilter("installed")}
              />
              <ToggleGroupItem
                text={<>Pending <Badge isRead>{filterCounts.pending}</Badge></>}
                isSelected={filters.has("pending")}
                onChange={() => toggleFilter("pending")}
              />
              <ToggleGroupItem
                text={<>Not signed by me <Badge isRead>{filterCounts.unsigned}</Badge></>}
                isSelected={filters.has("unsigned")}
                onChange={() => toggleFilter("unsigned")}
              />
              <ToggleGroupItem
                text={<>Signed by me <Badge isRead>{filterCounts.signed}</Badge></>}
                isSelected={filters.has("signed")}
                onChange={() => toggleFilter("signed")}
              />
              {filterCounts.bad > 0 && (
                <ToggleGroupItem
                  text={<>Known bad <Badge isRead>{filterCounts.bad}</Badge></>}
                  isSelected={filters.has("bad")}
                  onChange={() => toggleFilter("bad")}
                />
              )}
            </ToggleGroup>
          </ToolbarItem>
          <ToolbarItem>
            <Select
              aria-label="Filter by repository"
              isOpen={repoSelectOpen}
              selected={repoFilter}
              onSelect={(_event, value) => {
                setRepoFilter(value as string);
                setRepoSelectOpen(false);
                setRowResults(new Map());
                resetPage();
              }}
              onOpenChange={setRepoSelectOpen}
              toggle={(toggleRef) => (
                <MenuToggle
                  ref={toggleRef}
                  onClick={() => setRepoSelectOpen(!repoSelectOpen)}
                  isExpanded={repoSelectOpen}
                  aria-label="Filter by repository"
                >
                  {repoFilter === "all" ? "All repositories" : repoFilter}
                </MenuToggle>
              )}
            >
              <SelectList>
                <SelectOption value="all">All repositories</SelectOption>
                {repositories.map((repo) => (
                  <SelectOption key={repo} value={repo}>{repo}</SelectOption>
                ))}
              </SelectList>
            </Select>
          </ToolbarItem>
          <ToolbarItem>
            <Button
              variant="secondary"
              onClick={reload}
              isAriaDisabled={loading || busy}
              isLoading={loading}
              icon={<SyncAltIcon />}
            >
              Refresh
            </Button>
          </ToolbarItem>
          {selectedCount > 0 && (
            <ToolbarItem>
              <GatedButton
                variant="primary"
                onClick={requestBulkSignoff}
                isLoading={bulkProgress !== null}
                disabledReason={blockReason}
              >
                Sign off {plural(selectedCount, "package")}
              </GatedButton>
            </ToolbarItem>
          )}
          {(notShownCount > 0 || (isPageSelected && !areAllFilteredSelected)) && (
            <ToolbarItem alignSelf="center">
              {notShownCount > 0 && (
                <span className="pf-v6-u-mr-sm">{selectedCount} selected, {notShownCount} not shown</span>
              )}
              {isPageSelected && !areAllFilteredSelected && (
                <Button variant="link" isInline onClick={() => addToSelection(selectableGroups)} isAriaDisabled={busy}>
                  Select all {selectableGroups.length}
                </Button>
              )}
              {notShownCount > 0 && (
                <Button variant="link" isInline className="pf-v6-u-ml-sm" onClick={() => setSelected(new Set())} isAriaDisabled={busy}>
                  Clear selection
                </Button>
              )}
            </ToolbarItem>
          )}
          <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
            <CompactPagination
              itemCount={filteredGroups.length}
              perPage={perPage}
              page={page}
              onSetPage={onSetPage}
              onPerPageSelect={onPerPageSelect}
            />
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>

      {bulkProgress && (
        <Flex alignItems={{ default: "alignItemsFlexEnd" }} className="pf-v6-u-mb-md">
          <FlexItem grow={{ default: "grow" }}>
            <Progress
              title={`Signing off ${bulkCurrent} of ${bulkTotal}`}
              value={bulkTotal > 0 ? (bulkProgress.done / bulkTotal) * 100 : 0}
              measureLocation={ProgressMeasureLocation.none}
              aria-label="Bulk signoff progress"
              valueText={`${bulkProgress.done} of ${bulkTotal} signoff requests done`}
            />
          </FlexItem>
          <FlexItem>
            <Button variant="secondary" onClick={stopBulk} isAriaDisabled={bulkStopping}>
              {bulkStopping ? "Waiting for current batch…" : "Stop after current batch"}
            </Button>
          </FlexItem>
        </Flex>
      )}

      <PackageDetailsDrawer
        activeKey={detailsKey}
        packageDetails={selectedPackage}
        isLoading={detailsLoading}
        onClose={closeDetails}
        error={detailsError}
        errorCode={detailsErrorCode}
        errorDetails={detailsErrorContext}
      >
      {loading && !data ? (
        <Flex justifyContent={{ default: "justifyContentCenter" }} className="pf-v6-u-mt-xl">
          <Spinner size="lg" />
        </Flex>
      ) : filteredGroups.length === 0 ? (
        isDefaultView && filterCounts.all > 0 ? (
          <EmptyState headingLevel="h3" icon={CheckCircleIcon} titleText="Nothing left to sign off">
            <EmptyStateBody>
              Every installed package awaiting signoff has your signoff or enough signoffs already.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="secondary" onClick={handleClearFilter}>
                  Show all signoffs
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : (
          <EmptyState headingLevel="h3" titleText={hasFilters && filterCounts.all > 0 ? "No matching packages" : "No packages awaiting signoff"}>
            <EmptyStateBody>
              {hasFilters && filterCounts.all > 0
                ? "Try a different search term or filter."
                : "All packages have been signed off or none require signoff."}
            </EmptyStateBody>
            {hasFilters && filterCounts.all > 0 && (
              <EmptyStateFooter>
                <EmptyStateActions>
                  <Button variant="secondary" onClick={handleClearFilter}>
                    Clear filter
                  </Button>
                </EmptyStateActions>
              </EmptyStateFooter>
            )}
          </EmptyState>
        )
      ) : (
        <Table aria-label="Signoff packages" variant="compact">
          <Thead>
            <Tr>
              <Th screenReaderText="Select">
                <Checkbox
                  id={SELECT_PAGE_ID}
                  isChecked={isPageSelected ? true : isPagePartlySelected ? null : false}
                  onChange={(_event, checked) => checked ? addToSelection(pageSelectable) : deselectPage()}
                  isDisabled={busy || pageSelectable.length === 0}
                  aria-label="Select all packages on this page"
                />
              </Th>
              <Th sort={getSortParams("package")}>Package</Th>
              <Th sort={getSortParams("version")}>Version</Th>
              <Th>Local</Th>
              <Th sort={getSortParams("signoffs")}>Signoffs</Th>
              <Th sort={getSortParams("status")} info={helpInfo("signoff status", SIGNOFF_STATUS_HELP, "Signoff status")}>Status</Th>
              <Th>Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {pagedGroups.map((group) => {
              const key = signoffKey(group);
              const acting = actionInProgress?.key === key;
              const userHasSignoff = isSignedBy(group, username);
              const result = rowResults.get(key);
              const verbReason = rejected
                ? REJECTED_TEXT.title
                : settling.has(key) && !acting
                  ? "Waiting for the signoff list to reload"
                  : busyReason ?? (!userHasSignoff && group.known_bad ? "Marked known bad; do not sign off" : null);

              return (
                <Tr
                  key={key}
                  isClickable
                  onRowClick={() => showDetails(group)}
                  isRowSelected={selected.has(key)}
                  {...detailsRowProps(detailsKey === key)}
                >
                  <RowSelectCell
                    label={`Select ${group.pkgbase} ${group.version}`}
                    isSelected={selected.has(key)}
                    isDisabled={!isSelectable(group) || busy}
                    onSelect={() => toggleSelection(key)}
                  />
                  <Td dataLabel="Package">
                    <Button
                      variant="link"
                      isInline
                      {...{ [DETAILS_TRIGGER_ATTR]: key }}
                    >
                      <strong>{group.pkgbase}</strong>
                    </Button>
                    {group.pkgnames.length > 1 && (
                      <div style={{ fontSize: "0.85em", color: "var(--pf-t--global--color--200)" }}>
                        {group.pkgnames.join(", ")}
                      </div>
                    )}
                    <div>
                      <Label isCompact color="grey">{group.repo}</Label>{" "}
                      <Label isCompact color="grey">{group.arch}</Label>
                    </div>
                  </Td>
                  <Td dataLabel="Version">
                    <Label isCompact variant="outline">{group.version}</Label>
                  </Td>
                  <Td dataLabel="Local">{renderVersionMatch(group)}</Td>
                  <Td dataLabel="Signoffs">
                    {activeSignoffs(group)} / {group.required}
                  </Td>
                  <Td dataLabel="Status">{renderStatus(group)}</Td>
                  <Td dataLabel="Actions" onClick={(e) => e.stopPropagation()} onKeyDown={stopRowActivation}>
                    <Flex spaceItems={{ default: "spaceItemsSm" }} flexWrap={{ default: "nowrap" }} alignItems={{ default: "alignItemsCenter" }}>
                      <FlexItem>
                        <GatedButton
                          ref={(el: React.ComponentRef<"button"> | null) => {
                            if (el) verbRefs.current.set(key, el); else verbRefs.current.delete(key);
                          }}
                          variant={userHasSignoff ? "link" : "secondary"}
                          size="sm"
                          aria-label={userHasSignoff ? `Revoke signoff for ${group.pkgbase}` : `Sign off ${group.pkgbase}`}
                          onClick={() => runAction(group, userHasSignoff ? "revoke" : "signoff", true)}
                          isLoading={acting}
                          disabledReason={verbReason}
                        >
                          {userHasSignoff ? "Revoke" : "Sign off"}
                        </GatedButton>
                      </FlexItem>
                      {result && (
                        <FlexItem>
                          <Label isCompact color={ROW_RESULT_LABEL[result].color}>{ROW_RESULT_LABEL[result].text}</Label>
                        </FlexItem>
                      )}
                    </Flex>
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      )}

      {filteredGroups.length > 0 && (
        <Pagination
          itemCount={filteredGroups.length}
          perPage={perPage}
          page={page}
          onSetPage={onSetPage}
          onPerPageSelect={onPerPageSelect}
          perPageOptions={PER_PAGE_OPTIONS}
          variant="bottom"
        />
      )}
      </PackageDetailsDrawer>

      <ConfirmModal
        isOpen={bulkConfirm !== null}
        title={`Sign off ${plural(selectedCount, "package")}?`}
        severity="warning"
        commitLabel={`Sign off ${plural(selectedCount, "package")}`}
        onConfirm={() => runBulk(selectedGroups)}
        onClose={() => setBulkConfirm(null)}
      >
        <Content component={ContentVariants.p}>
          The selection includes packages you did not test at the version under signoff:
        </Content>
        <Content component={ContentVariants.ul} aria-label="Packages to check">
          {(bulkConfirm ?? []).map((row) => (
            <Content component={ContentVariants.li} key={row.key}>
              <strong>{row.name}</strong>: {row.reason}
            </Content>
          ))}
        </Content>
      </ConfirmModal>
      </CardBody>
    </Card>
    </>
  );
};

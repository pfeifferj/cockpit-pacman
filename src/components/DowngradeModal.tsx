import React, { useState, useEffect, useCallback, useRef, useId } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { useDebouncedValue } from "../hooks/useDebounce";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Spinner,
  Alert,
  AlertActionLink,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  EmptyStateActions,
  Label,
  Content,
  ContentVariants,
  ToggleGroup,
  ToggleGroupItem,
  SearchInput,
  Progress,
  ProgressMeasureLocation,
} from "@patternfly/react-core";
import { ExpandableLogViewer } from "./LogViewer";
import { TransactionPreview, type AcknowledgementState } from "./TransactionPreview";
import { CancellationNotice } from "./CancellationNotice";
import { LockErrorBody } from "./LockErrorBody";
import { GatedButton } from "./GatedButton";
import { PREVIEW_STALE_REASON, PreviewStaleAlert, usePreviewStaleness } from "./PreflightConfirmModal";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import { useSortableTable } from "../hooks/useSortableTable";
import { BanIcon, CheckCircleIcon } from "@patternfly/react-icons";
import {
  CachedVersion,
  listDowngrades,
  downgradePackage,
  listArchiveVersions,
  downgradeFromArchive,
  previewDowngrade,
  previewDowngradeArchive,
  formatSize,
  BackendError,
  checkLock,
  addIgnoredPackage,
  removeIgnoredPackage,
  listIgnoredPackages,
} from "../api";
import type { ErrorCode, StreamEvent, TransactionPreview as PreviewData } from "../api";
import { isNetworkError } from "../offline";
import { ErrorAlert } from "./ErrorAlert";
import { NetworkErrorState } from "./NetworkErrorState";
import { ignoreNotice, sanitizeErrorMessage } from "../utils";
import { vercmp } from "../vercmp";
import { RunSession, useRunInBackground, useRunSnapshot, type RunStatus } from "./TransactionHost";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { mutationGate, useActiveTransaction } from "../hooks/useMutationGate";

type ModalState = "loading" | "select" | "previewing" | "confirm" | "downgrading" | "cancelling" | "success" | "stopped" | "failed" | "error";
type DowngradeSource = "cache" | "archive";

const RUN_STATE: Record<RunStatus, ModalState> = {
  running: "downgrading",
  cancelling: "cancelling",
  success: "success",
  stopped: "stopped",
  failed: "failed",
};

const NO_PLAN = { downloadBytes: 0, packages: 0 };

/** Matches PackageActionModal: a fast cache preview finishes before any text appears. */
const PREVIEW_TEXT_DELAY_MS = 1000;

interface DowngradeModalProps {
  packageName: string;
  currentVersion: string;
  isOpen: boolean;
  onClose: () => void;
  /** Runs instead of onClose when an error action leaves for another tab. */
  onNavigateAway?: () => void;
  appendTo?: () => HTMLElement;
  /** A run already in progress and the version it installs, shown instead of the version list. */
  background?: { session: RunSession; version: CachedVersion; source: DowngradeSource };
}

export const DowngradeModal: React.FC<DowngradeModalProps> = ({
  packageName,
  currentVersion,
  isOpen,
  onClose,
  onNavigateAway,
  appendTo,
  background,
}) => {
  const [localState, setState] = useState<ModalState>("loading");
  const [session, setSession] = useState<RunSession | null>(background?.session ?? null);
  const run = useRunSnapshot(session);
  const state = run ? RUN_STATE[run.status] : localState;
  const runInBackground = useRunInBackground();
  // The page-level host owns a session it was handed, so this dialog must not cancel it on unmount.
  const handedOffRef = useRef(background !== undefined);
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const dismissable = state !== "downgrading" && state !== "cancelling";
  const staleness = usePreviewStaleness(isOpen && !run && (state === "previewing" || state === "confirm"));
  const stale = staleness.staleAt !== null;
  const [source, setSource] = useState<DowngradeSource>(background?.source ?? "cache");
  const [versions, setVersions] = useState<CachedVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<CachedVersion | null>(background?.version ?? null);
  const [listError, setError] = useState<string | null>(null);
  const [listErrorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  const error = run ? run.error : listError;
  const errorCode = run ? run.errorCode : listErrorCode;
  const [listErrorDetails, setErrorDetails] = useState<string | undefined>();
  const errorDetails = run ? run.errorDetails : listErrorDetails;
  const log = run?.log ?? "";
  const finishedAfterCancel = run?.finishedAfterCancel ?? false;
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(background !== undefined);
  const { activeSortIndex, activeSortDirection, setActiveSortIndex, getSortParams } = useSortableTable({
    sortableColumns: [0, 2], // version, size
    defaultDirection: "desc",
  });
  const [versionFilter, setVersionFilter] = useState("");
  const [serverResults, setServerResults] = useState<{ query: string; packages: CachedVersion[]; failed: boolean } | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const stopAsked = confirmingStop && state === "downgrading";
  const cancelButtonRef = useRef<HTMLElement>(null);
  const keepRunningRef = useRef<HTMLElement>(null);
  const cancellingRef = useRef<HTMLElement>(null);
  const stopFocusRef = useRef<"keep" | "cancel" | "cancelling" | null>(null);
  const terminalFocusRef = useRef<HTMLElement>(null);
  const prevStateRef = useRef<ModalState | null>(null);
  const stopQuestionId = useId();
  const titleId = useId();
  const loadIdRef = useRef(0);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<AcknowledgementState | null>(null);
  const [previewError, setPreviewError] = useState<{ message: string; code?: ErrorCode; details?: string } | null>(null);
  const [download, setDownload] = useState<{ filename: string; downloaded?: number; total?: number } | null>(null);
  const [showPreviewText, setShowPreviewText] = useState(false);
  const previewRequestRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | undefined>(undefined);
  // A stopped run can leave db.lck behind; null until checked, false when clear or unknown.
  const [staleLock, setStaleLock] = useState<boolean | null>(null);
  const [ignored, setIgnored] = useState<boolean | undefined>(undefined);
  const [ignoreBusy, setIgnoreBusy] = useState(false);
  const [ignoreResult, setIgnoreResult] = useState<{ ignored: boolean; undone: boolean } | { error: string } | null>(null);
  const canAdminister = useAdminPermission();
  const transaction = useActiveTransaction();
  const commitGate = mutationGate("change package versions", canAdminister, transaction);

  useEffect(() => session?.subscribe(() => setLastEventAt(Date.now())), [session]);

  useEffect(() => {
    if (state !== "stopped") return;
    let cancelled = false;
    checkLock().then(
      (status) => {
        if (!cancelled) setStaleLock(status.locked && status.stale);
      },
      () => {
        if (!cancelled) setStaleLock(false);
      },
    );
    return () => {
      cancelled = true;
      setStaleLock(null);
    };
  }, [state]);

  useEffect(() => {
    if (state !== "previewing" || source !== "cache") return;
    const timer = setTimeout(() => setShowPreviewText(true), PREVIEW_TEXT_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShowPreviewText(false);
    };
  }, [state, source]);

  const downgraded = state === "success" && selectedVersion?.is_older === true;
  useEffect(() => {
    if (!downgraded) return;
    let cancelled = false;
    listIgnoredPackages().then(
      (r) => {
        if (!cancelled) setIgnored((r.packages ?? []).includes(packageName));
      },
      () => {
        if (!cancelled) setIgnored(undefined);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [downgraded, packageName]);

  const loadVersions = useCallback(async (src: DowngradeSource) => {
    if (!packageName) return;
    const loadId = ++loadIdRef.current;
    setState("loading");
    setError(null);
    setErrorCode(undefined);
    try {
      const response = src === "archive"
        ? await listArchiveVersions(packageName)
        : await listDowngrades(packageName);
      if (loadId !== loadIdRef.current) return;
      setVersions(response.packages);
      setState("select");
    } catch (ex) {
      if (loadId !== loadIdRef.current) return;
      setState("error");
      setError(ex instanceof Error ? ex.message : String(ex));
      setErrorCode(ex instanceof BackendError ? ex.code : undefined);
      setErrorDetails(ex instanceof BackendError ? ex.details : undefined);
    }
  }, [packageName]);

  const resumingRef = useRef(background !== undefined);
  useEffect(() => {
    if (!isOpen) return;
    if (resumingRef.current) {
      resumingRef.current = false;
      return;
    }
    Promise.resolve().then(() => {
      setSource("cache");
      setSelectedVersion(null);
      setSession(null);
      setVersionFilter("");
      setServerResults(null);
      void loadVersions("cache");
    });
  }, [isOpen, loadVersions]);

  const handleSourceChange = (src: DowngradeSource) => {
    if (src === source) return;
    setSource(src);
    setActiveSortIndex(null);
    setVersionFilter("");
    setServerResults(null);
    void loadVersions(src);
  };

  const abortPreview = useCallback(() => {
    previewRequestRef.current++;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
  }, []);

  useEffect(() => {
    if (!isOpen) abortPreview();
  }, [isOpen, abortPreview]);

  useEffect(() => {
    return () => {
      previewAbortRef.current?.abort();
      if (!handedOffRef.current) sessionRef.current?.abandon();
    };
  }, []);

  const startPreview = (version: CachedVersion) => {
    abortPreview();
    const request = previewRequestRef.current;
    setSelectedVersion(version);
    setSession(null);
    setPreview(null);
    setAcknowledgement(null);
    setPreviewError(null);
    setDownload(null);
    staleness.reset();
    setState("previewing");
    let pending: Promise<PreviewData>;
    if (source === "archive") {
      const controller = new AbortController();
      previewAbortRef.current = controller;
      pending = previewDowngradeArchive(packageName, version.filename, {
        signal: controller.signal,
        onEvent: (event: StreamEvent) => {
          if (event.type !== "download" || request !== previewRequestRef.current) return;
          setDownload({ filename: event.filename, downloaded: event.downloaded, total: event.total || undefined });
        },
      });
    } else {
      pending = previewDowngrade(packageName, version.version);
    }
    pending.then(
      (result) => {
        if (request !== previewRequestRef.current) return;
        previewAbortRef.current = null;
        setPreview(result);
        setState("confirm");
      },
      (ex) => {
        if (request !== previewRequestRef.current) return;
        previewAbortRef.current = null;
        setPreviewError({
          message: sanitizeErrorMessage(ex instanceof Error ? ex.message : String(ex)),
          code: ex instanceof BackendError ? ex.code : undefined,
          details: ex instanceof BackendError ? ex.details : undefined,
        });
        setState("confirm");
      },
    );
  };

  const backToVersions = () => {
    abortPreview();
    setState("select");
  };

  useEffect(() => {
    const target = stopFocusRef.current;
    stopFocusRef.current = null;
    if (target === "keep") keepRunningRef.current?.focus();
    else if (target === "cancel") cancelButtonRef.current?.focus();
    else if (target === "cancelling") cancellingRef.current?.focus();
    // The focused "Cancelling…" button unmounts on the terminal callback.
    else if (prevStateRef.current === "cancelling" && state !== "cancelling") terminalFocusRef.current?.focus();
    prevStateRef.current = state;
  }, [confirmingStop, state]);

  const handleConfirmDowngrade = () => {
    if (commitGate.blocked || !selectedVersion || acknowledgement?.complete === false || stale) return;
    const version = selectedVersion;
    setConfirmingStop(false);
    setIsDetailsExpanded(true);
    const next = new RunSession(`${version.is_older ? "Downgrade" : "Upgrade"} ${packageName}`);
    handedOffRef.current = false;
    setIgnoreResult(null);
    setIgnored(undefined);
    setSession(next);
    next.start(
      (callbacks) => source === "archive"
        ? downgradeFromArchive(callbacks, packageName, version.filename, preview?.remove.map(p => p.name) ?? [])
        : downgradePackage(callbacks, packageName, version.version, preview?.remove.map(p => p.name) ?? []),
      NO_PLAN,
    );
  };

  const changeIgnore = async (ignore: boolean, isUndo: boolean) => {
    setIgnoreBusy(true);
    try {
      if (ignore) await addIgnoredPackage(packageName);
      else await removeIgnoredPackage(packageName);
      setIgnored(ignore);
      setIgnoreResult({ ignored: ignore, undone: isUndo });
    } catch (ex) {
      setIgnoreResult({ error: sanitizeErrorMessage(ex instanceof Error ? ex.message : String(ex)) });
    } finally {
      setIgnoreBusy(false);
    }
  };

  const handleRunInBackground = () => {
    if (!session || !selectedVersion || !runInBackground) return;
    handedOffRef.current = true;
    const handed = { session, version: selectedVersion, source };
    runInBackground({
      session,
      render: (close) => (
        <DowngradeModal
          packageName={packageName}
          currentVersion={currentVersion}
          isOpen
          onClose={close}
          background={handed}
        />
      ),
    });
    abortPreview();
    onClose();
  };

  const handleStopRequest = () => {
    stopFocusRef.current = "keep";
    setConfirmingStop(true);
  };

  const handleKeepRunning = () => {
    stopFocusRef.current = "cancel";
    setConfirmingStop(false);
  };

  // The ref is kept so unmount cleanup can still stop a transaction that is
  // slow to acknowledge the graceful cancel.
  const handleStop = () => {
    stopFocusRef.current = "cancelling";
    setConfirmingStop(false);
    session?.stop();
  };

  const retryPreview = () => {
    if (selectedVersion) startPreview(selectedVersion);
  };

  const closeWith = (close: () => void) => {
    abortPreview();
    if (!handedOffRef.current) session?.abandon();
    close();
  };
  const handleClose = () => closeWith(onClose);
  useBackdropClose(isOpen, dismissable ? handleClose : undefined);
  const handleNavigateAway = () => closeWith(onNavigateAway ?? onClose);

  const sortedVersions = React.useMemo(() => {
    return [...versions].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = vercmp(a.version, b.version);
          break;
        case 2:
          comparison = a.size - b.size;
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [versions, activeSortIndex, activeSortDirection]);

  const filteredVersions = React.useMemo(() => {
    const query = versionFilter.trim().toLowerCase();
    if (!query) return sortedVersions;
    return sortedVersions.filter((v) => v.version.toLowerCase().includes(query));
  }, [sortedVersions, versionFilter]);

  const debouncedFilter = useDebouncedValue(versionFilter, SEARCH_DEBOUNCE_MS);

  // When the archive filter matches nothing in the fetched page, escalate to a
  // backend search that filters the full archive history before the cap.
  useEffect(() => {
    const query = debouncedFilter.trim();
    if (source !== "archive" || query === "") return;
    if (serverResults?.query === query) return;
    const clientHasMatch = versions.some((v) =>
      v.version.toLowerCase().includes(query.toLowerCase())
    );
    if (clientHasMatch) return;
    let cancelled = false;
    listArchiveVersions(packageName, query)
      .then((resp) => {
        if (!cancelled) setServerResults({ query, packages: resp.packages, failed: false });
      })
      .catch(() => {
        if (!cancelled) setServerResults({ query, packages: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedFilter, source, versions, packageName, serverResults]);

  const stopVerb = selectedVersion?.is_older ? "downgrading" : "upgrading";
  const verb = (selectedVersion?.is_older ?? true) ? "Downgrade" : "Upgrade";
  const others = preview ? preview.add.length + preview.remove.length - 1 : 0;
  const commitLabel = `${verb} ${packageName} to ${selectedVersion?.version}` +
    (others > 0 ? ` and ${others} ${others === 1 ? "package" : "packages"}` : "");
  const previewFailed = previewError !== null || (preview !== null && !preview.success);
  // Removing or downgrading anything besides the target is what makes this more than a reversible version swap.
  const changesOthers = preview !== null && (
    preview.remove.some((r) => r.name !== packageName) ||
    preview.add.some((a) => a.name !== packageName && a.old_version !== undefined && vercmp(a.version, a.old_version) < 0)
  );
  const downloading = download !== null && !(download.total !== undefined && (download.downloaded ?? 0) >= download.total);
  const ignoreGate = mutationGate(`ignore ${packageName}`, canAdminister, transaction);

  const sourceToggle = (
    <ToggleGroup aria-label="Version source" className="pf-v6-u-mb-md">
      <ToggleGroupItem
        text="Cache"
        isSelected={source === "cache"}
        onChange={() => handleSourceChange("cache")}
      />
      <ToggleGroupItem
        text="Archive"
        isSelected={source === "archive"}
        onChange={() => handleSourceChange("archive")}
      />
    </ToggleGroup>
  );

  const versionChange = (
    <Content component={ContentVariants.p}>
      <strong>{packageName}</strong>{" "}
      <Label isCompact variant="outline">{currentVersion}</Label>
      {" -> "}
      <Label isCompact color={verb === "Downgrade" ? "orange" : "blue"}>{selectedVersion?.version}</Label>
    </Content>
  );

  const renderContent = () => {
    switch (state) {
      case "loading":
        return (
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading versions">
            <EmptyStateBody>
              {source === "archive"
                ? "Fetching versions from archive.archlinux.org…"
                : "Scanning package cache…"}
            </EmptyStateBody>
          </EmptyState>
        );

      case "error":
        return (
          <>
            {sourceToggle}
            {isNetworkError(null, errorCode) ? (
              <NetworkErrorState
                resource={source === "archive" ? "archive versions" : "package versions"}
                onRetry={() => loadVersions(source)}
                headingLevel="h2"
              />
            ) : (
              <Alert component="h2" variant="danger" isInline title="Could not list versions">
                {sanitizeErrorMessage(error)}
              </Alert>
            )}
          </>
        );

      case "select": {
        const trimmedFilter = versionFilter.trim();
        const escalate =
          source === "archive" && trimmedFilter !== "" && filteredVersions.length === 0;
        const serverResolved =
          escalate && serverResults !== null && serverResults.query === trimmedFilter;
        const rows = escalate ? (serverResolved ? serverResults.packages : []) : filteredVersions;
        const searchingServer = escalate && !serverResolved;
        const serverFailed = serverResolved && serverResults.failed;
        return (
          <>
            {sourceToggle}
            {versions.length === 0 ? (
              <EmptyState headingLevel="h2" titleText="No versions available">
                <EmptyStateBody>
                  {source === "archive"
                    ? `No archived versions of ${packageName} were found for this architecture.`
                    : `No other versions of ${packageName} were found in the package cache.`}
                </EmptyStateBody>
              </EmptyState>
            ) : (
              <>
            <Content component={ContentVariants.p} className="pf-v6-u-mb-md">
              Select a version to downgrade <strong>{packageName}</strong> from{" "}
              <Label isCompact variant="outline">{currentVersion}</Label>
            </Content>
            {source === "archive" && (
              <Content component={ContentVariants.small} className="pf-v6-u-mb-md">
                Versions are fetched from archive.archlinux.org (sizes are approximate);
                the package is downloaded and verified before you confirm.
              </Content>
            )}
            <SearchInput
              placeholder="Filter by version"
              value={versionFilter}
              onChange={(_event, value) => setVersionFilter(value)}
              onClear={() => setVersionFilter("")}
              className="pf-v6-u-mb-md"
              aria-label="Filter versions"
            />
            {searchingServer ? (
              <EmptyState headingLevel="h2" icon={Spinner} titleText="Searching the archive">
                <EmptyStateBody>
                  Looking for <strong>{trimmedFilter}</strong> in the full archive history…
                </EmptyStateBody>
              </EmptyState>
            ) : serverFailed ? (
              <Alert component="h2"
                variant="warning"
                title="Archive search failed"
                isInline
                actionLinks={
                  <AlertActionLink onClick={() => setServerResults(null)}>
                    Retry
                  </AlertActionLink>
                }
              >
                Could not reach archive.archlinux.org. Check your connection.
              </Alert>
            ) : rows.length === 0 ? (
              <EmptyState headingLevel="h2" titleText="No matching versions">
                <EmptyStateBody>
                  No versions match <strong>{versionFilter}</strong>.
                </EmptyStateBody>
              </EmptyState>
            ) : (
            <>
            {escalate && serverResolved && (
              <Content component={ContentVariants.small} className="pf-v6-u-mb-md">
                Showing archive search results for <strong>{trimmedFilter}</strong> from the full history.
              </Content>
            )}
            <Table aria-label="Available versions" variant="compact">
              <Thead>
                <Tr>
                  <Th sort={getSortParams(0)}>Version</Th>
                  <Th>Status</Th>
                  <Th sort={getSortParams(2)}>Size</Th>
                  <Th>Action</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((v) => {
                  const isCurrent = v.installed_version !== null && v.version === v.installed_version;
                  const isNotInstalled = v.installed_version === null;
                  return (
                    <Tr key={v.filename}>
                      <Td dataLabel="Version">
                        <code>{v.version}</code>
                      </Td>
                      <Td dataLabel="Status">
                        {isCurrent ? (
                          <Label isCompact color="green">installed</Label>
                        ) : isNotInstalled ? (
                          <Label isCompact color="grey">cached</Label>
                        ) : v.is_older ? (
                          <Label isCompact color="orange">older</Label>
                        ) : (
                          <Label isCompact color="blue">newer</Label>
                        )}
                      </Td>
                      <Td dataLabel="Size">{v.size > 0 ? formatSize(v.size) : "-"}</Td>
                      <Td dataLabel="Action">
                        {!isCurrent && (
                          <Button
                            variant="secondary"
                            size="sm"
                            aria-label={`Select ${v.version}`}
                            onClick={() => startPreview(v)}
                          >
                            Select
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
            </>
            )}
              </>
            )}
          </>
        );
      }

      case "previewing":
        return (
          <>
            {versionChange}
            {download ? (() => {
              const amount = download.total !== undefined
                ? `${formatSize(download.downloaded ?? 0)} of ${formatSize(download.total)}`
                : download.downloaded !== undefined ? formatSize(download.downloaded) : undefined;
              return (
                <Progress
                  className="pf-v6-u-mt-md"
                  value={download.total !== undefined ? Math.round(((download.downloaded ?? 0) / download.total) * 100) : undefined}
                  title={`Downloading ${download.filename}`}
                  label={amount}
                  valueText={amount}
                  measureLocation={download.total === undefined ? ProgressMeasureLocation.none : ProgressMeasureLocation.outside}
                  aria-label={`Downloading ${download.filename}`}
                />
              );
            })() : (
              <Content className="pf-v6-u-mt-md">
                <Spinner size="md" aria-label="Checking what will change" />
                {source === "archive" ? " Downloading and checking what will change…" : showPreviewText && " Checking what will change…"}
              </Content>
            )}
          </>
        );

      case "confirm":
        return (
          <>
            {versionChange}
            <div className="pf-v6-u-mt-md">
              {previewError ? (
                <ErrorAlert headingLevel="h2"
                  error={previewError.message}
                  code={previewError.code}
                  details={previewError.details}
                  title="Could not check what will change"
                  beforeNavigate={handleNavigateAway}
                  onRetry={retryPreview}
                />
              ) : preview && (
                <>
                  <PreviewStaleAlert staleAt={staleness.staleAt} className="pf-v6-u-mb-md" />
                  <TransactionPreview
                    preview={preview}
                    failureTitle={`Cannot ${verb.toLowerCase()} ${packageName}`}
                    onAcknowledgedChange={setAcknowledgement}
                    beforeNavigate={handleNavigateAway}
                  />
                </>
              )}
            </div>
            {!previewFailed && preview && (changesOthers || verb === "Downgrade") && (
              <Alert component="h2"
                variant={changesOthers ? "danger" : "info"}
                isInline
                title={changesOthers
                  ? `This also removes or downgrades packages other than ${packageName}`
                  : "The next upgrade replaces this version"}
                className="pf-v6-u-mt-md"
              >
                {changesOthers && (
                  <Content component={ContentVariants.p}>
                    Check them in the list above. They are not put back by upgrading {packageName} again.
                  </Content>
                )}
                {verb === "Downgrade" && (
                  <Content component={ContentVariants.ul}>
                    <Content component={ContentVariants.li}>
                      Changes the {currentVersion} install scripts made, such as migrated configuration or data, stay in place.
                    </Content>
                    <Content component={ContentVariants.li}>
                      A cached {currentVersion} package file is kept, so you can return to it here until the cache is cleaned.
                    </Content>
                    <Content component={ContentVariants.li}>
                      The next upgrade installs the newest version again unless {packageName} is ignored. You can ignore it once the downgrade finishes.
                    </Content>
                  </Content>
                )}
              </Alert>
            )}
          </>
        );

      case "downgrading":
      case "cancelling":
        return (
          <>
            {stopAsked && (
              <Alert component="h2"
                variant="warning"
                isInline
                id={stopQuestionId}
                title={`Stop ${stopVerb} ${packageName}?`}
                className="pf-v6-u-mb-md"
              >
                The transaction is stopped before packages are committed. Once the commit step starts it cannot be stopped.
              </Alert>
            )}
            {state === "cancelling" && (
              <CancellationNotice lastEventAt={lastEventAt} phase={run?.progress.phase} />
            )}
            <div className="pf-v6-u-mb-md">
              <Spinner size="md" />{" "}
              {state === "cancelling"
                ? "Cancelling…"
                : `${selectedVersion?.is_older ? "Downgrading" : "Upgrading"} ${packageName} to ${selectedVersion?.version}…`}
            </div>
            {state === "cancelling" && <p>Cancellation requested. Waiting for the operation to finish safely.</p>}
            <ExpandableLogViewer
              log={log}
              placeholder="Starting…"
              isExpanded={isDetailsExpanded}
              onToggle={setIsDetailsExpanded}
            />
          </>
        );

      case "success": {
        const doneWord = selectedVersion?.is_older ? "downgraded" : "upgraded";
        const offerIgnore = downgraded && ignored === false && !(ignoreResult && "ignored" in ignoreResult && ignoreResult.ignored);
        return (
          <>
            <EmptyState
              headingLevel="h2"
              icon={CheckCircleIcon}
              titleText={finishedAfterCancel ? "The transaction finished before it could be stopped" : "Version change complete"}
            >
              <EmptyStateBody>
                {packageName} has been {doneWord} to {selectedVersion?.version}.
                {downgraded && ignored !== true && " The next upgrade replaces this version unless it is ignored."}
                {downgraded && ignored === true && ` ${packageName} is ignored, so upgrades leave this version in place.`}
              </EmptyStateBody>
              {offerIgnore && (
                <EmptyStateFooter>
                  <EmptyStateActions>
                    <GatedButton
                      gate={ignoreGate}
                      disabledReason={ignoreBusy && `Ignoring ${packageName}…`}
                      variant="secondary"
                      icon={<BanIcon />}
                      isLoading={ignoreBusy}
                      onClick={() => changeIgnore(true, false)}
                    >
                      {`Ignore ${packageName} in upgrades`}
                    </GatedButton>
                  </EmptyStateActions>
                </EmptyStateFooter>
              )}
            </EmptyState>
            <div aria-live="polite">
              {ignoreResult && "error" in ignoreResult && (
                <Alert component="h2" variant="danger" isInline title={`Could not change whether ${packageName} is ignored`}>
                  {ignoreResult.error}
                </Alert>
              )}
              {ignoreResult && "ignored" in ignoreResult && (
                <Alert component="h2"
                  variant="success"
                  isInline
                  title={ignoreNotice(packageName, ignoreResult.ignored)}
                  actionLinks={!ignoreResult.undone && (
                    <AlertActionLink isDisabled={ignoreBusy} onClick={() => changeIgnore(!ignoreResult.ignored, true)}>
                      Undo
                    </AlertActionLink>
                  )}
                />
              )}
            </div>
          </>
        );
      }

      case "stopped":
      case "failed":
        return (
          <>
            {state === "stopped" ? (
              <>
                <Alert component="h2" variant="custom" isInline title="Stopped" className="pf-v6-u-mb-md">
                  {sanitizeErrorMessage(error)}
                </Alert>
                {staleLock && (
                  <Alert component="h2" variant="warning" isInline title="Database is locked" className="pf-v6-u-mb-md">
                    <LockErrorBody onRetry={retryPreview} onAutoRetry={() => setStaleLock(false)} onCleared={() => {}} />
                  </Alert>
                )}
              </>
            ) : (
              <ErrorAlert headingLevel="h2"
                error={sanitizeErrorMessage(error)}
                code={errorCode}
                details={errorDetails}
                title={`${selectedVersion?.is_older ? "Downgrade" : "Upgrade"} failed`}
                className="pf-v6-u-mb-md"
                beforeNavigate={handleNavigateAway}
                onRetry={retryPreview}
              />
            )}
            <ExpandableLogViewer
              log={log}
              placeholder="No output"
              isExpanded={isDetailsExpanded}
              onToggle={setIsDetailsExpanded}
            />
          </>
        );

      default:
        return null;
    }
  };

  const renderFooter = () => {
    switch (state) {
      case "select":
        return (
          <Button variant="link" onClick={handleClose}>
            Cancel
          </Button>
        );

      case "previewing":
        return (
          <Button variant="link" onClick={backToVersions}>
            {downloading ? "Cancel download" : "Back"}
          </Button>
        );

      case "confirm":
        if (previewFailed) {
          return (
            <>
              <Button variant="primary" onClick={retryPreview}>
                Check again
              </Button>
              <Button variant="link" onClick={backToVersions}>
                Back
              </Button>
            </>
          );
        }
        return (
          <>
            <GatedButton
              variant="danger"
              onClick={handleConfirmDowngrade}
              disabledReason={commitGate.reason ?? (stale ? PREVIEW_STALE_REASON : acknowledgement?.reason)}
            >
              {commitLabel}
            </GatedButton>
            {stale && (
              <Button variant="secondary" onClick={retryPreview}>
                Refresh preview
              </Button>
            )}
            <Button variant="link" onClick={backToVersions}>
              Back
            </Button>
          </>
        );

      case "downgrading":
        return stopAsked ? (
          <>
            <Button variant="danger" onClick={handleStop} aria-describedby={stopQuestionId}>
              {`Stop ${stopVerb} ${packageName}`}
            </Button>
            <Button variant="link" onClick={handleKeepRunning} ref={keepRunningRef} aria-describedby={stopQuestionId}>
              Keep running
            </Button>
          </>
        ) : (
          <>
            {runInBackground && (
              <Button variant="secondary" onClick={handleRunInBackground}>
                Run in background
              </Button>
            )}
            <Button variant="secondary" onClick={handleStopRequest} ref={cancelButtonRef}>
              Cancel
            </Button>
          </>
        );

      case "cancelling":
        return (
          <Button variant="secondary" isAriaDisabled isLoading ref={cancellingRef}>
            Cancelling…
          </Button>
        );

      case "failed":
        return (
          <>
            <Button variant="primary" onClick={retryPreview} ref={terminalFocusRef}>
              Try again
            </Button>
            <Button variant="link" onClick={handleClose}>
              Close
            </Button>
          </>
        );

      case "success":
      case "stopped":
        return (
          <Button variant="primary" onClick={handleClose} ref={terminalFocusRef}>
            Close
          </Button>
        );

      case "error":
        return (
          <>
            <Button variant="primary" onClick={() => loadVersions(source)}>
              Retry
            </Button>
            <Button variant="link" onClick={handleClose}>
              Close
            </Button>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <Modal
      variant={ModalVariant.medium}
      aria-label={`Downgrade ${packageName}`}
      isOpen={isOpen}
      appendTo={appendTo}
      onClose={dismissable ? handleClose : undefined}
      onEscapePress={dismissable ? undefined : () => {}}
      aria-labelledby={titleId}
    >
      <ModalHeader title={`${verb} ${packageName}`} labelId={titleId} />
      <ModalBody>{renderContent()}</ModalBody>
      <ModalFooter>{renderFooter()}</ModalFooter>
    </Modal>
  );
};

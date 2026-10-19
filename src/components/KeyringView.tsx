import { ErrorDetails } from "./ErrorDetails";
import React, { useState, useEffect, useCallback, useRef, useMemo, useId } from "react";
import { usePagination } from "../hooks/usePagination";
import { useSortableTable } from "../hooks/useSortableTable";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useMutationGate } from "../hooks/useMutationGate";
import { GatedButton } from "./GatedButton";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import {
  Card,
  CardBody,
  CardTitle,
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
  SearchInput,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Label,
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectOption,
  SelectList,
  Content,
  ContentVariants,
  Progress,
  ProgressMeasureLocation,
} from "@patternfly/react-core";
import { ExpandableLogViewer, LogViewer } from "./LogViewer";
import { CompactPagination } from "./CompactPagination";
import { SyncAltIcon, KeyIcon, CheckCircleIcon, PlusCircleIcon, InfoCircleIcon } from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  KeyringKey,
  KeyringStatusResponse,
  getKeyringStatus,
  refreshKeyring,
  initKeyring,
} from "../api";
import type { ErrorCode } from "../api";
import { isNetworkError } from "../offline";
import { NetworkErrorState } from "./NetworkErrorState";
import { TimeAgo } from "./TimeAgo";
import { HelpPopover, helpInfo } from "./HelpPopover";
import { useDebouncedValue } from "../hooks/useDebounce";
import { useAnnounce, useResultAnnouncement } from "../contexts/AnnouncerContext";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import { plural, sanitizeErrorMessage } from "../utils";
import { PackageActionModal, installConfig } from "./PackageActionModal";
import type { KeyringContext } from "../contexts/NavigationContext";
import { ImportKeyModal, keyName } from "./ImportKeyModal";
import { UndoAlert } from "./UndoAlert";
import { LoadErrorState, toLoadFailure } from "./LoadErrorState";
import { CancellationNotice } from "./CancellationNotice";
import { useStreamingLog } from "../hooks/useStreamingLog";

interface KeyNotice {
  key: KeyringKey;
  signed: boolean;
  existed: boolean;
}

function keyNoticeTitle({ key, signed, existed }: KeyNotice): string {
  if (signed) return `Locally signed key for ${keyName(key)}`;
  return existed
    ? `Key for ${keyName(key)} was already in the keyring and is still not trusted`
    : `Key for ${keyName(key)} was added to the keyring but not trusted`;
}

function keyNoticeLabel({ signed, existed }: KeyNotice): string {
  if (signed) return "Signed";
  return existed ? "Fetched" : "New";
}

// Spacing between blocks is CSS-only so a copied selection stays the raw fingerprint.
const Fingerprint: React.FC<{ value: string }> = ({ value }) => (
  <>
    {(value.match(/.{1,4}/g) ?? []).map((block, i) => (
      <React.Fragment key={i}>
        {i > 0 && <wbr />}
        <span style={i > 0 ? { marginInlineStart: "0.35em" } : undefined}>{block}</span>
      </React.Fragment>
    ))}
  </>
);

type ViewState = "loading" | "ready" | "refreshing" | "initializing" | "stopped" | "error" | "refreshError" | "initError";

type KeyringRun = "refreshing" | "initializing";

const RUN_COPY: Record<KeyringRun, { question: string; consequence: string; confirm: string; stoppedTitle: string }> = {
  refreshing: {
    question: "Stop refreshing keys?",
    consequence: "Keys already refreshed stay refreshed.",
    confirm: "Stop refreshing",
    stoppedTitle: "Key refresh stopped",
  },
  initializing: {
    question: "Stop initializing the keyring?",
    consequence: "The keyring may be left partly initialized. Initialize it again afterwards.",
    confirm: "Stop initializing",
    stoppedTitle: "Keyring initialization stopped",
  },
};

export const WarningsAlert: React.FC<{ title: string; warnings: string[] }> = ({ title, warnings }) => {
  if (warnings.length === 0) return null;
  return (
    <Alert variant="warning" isInline title={title} className="pf-v6-u-mb-md">
      {warnings.length === 1 ? warnings[0] : (
        <Content component={ContentVariants.ul}>
          {warnings.map((warning, i) => <Content component={ContentVariants.li} key={`${warning}-${i}`}>{warning}</Content>)}
        </Content>
      )}
    </Alert>
  );
};

export const KeyringWarnings: React.FC<{ warnings: string[] }> = ({ warnings }) => (
  <WarningsAlert title={warnings.length === 1 ? "Keyring warning" : "Keyring warnings"} warnings={warnings} />
);

type RemedyStep = "keyring" | "keys";

const REMEDY_DONE: Record<RemedyStep, string> = {
  keyring: "archlinux-keyring updated",
  keys: "Keys refreshed",
};

// `count` is the number of packages the failed upgrade would retry.
type SignatureFailure = KeyringContext & { count?: number };

interface KeyringViewProps {
  signatureFailure?: SignatureFailure | null;
  /** Returns to the failed operation and re-runs it; used when the context has a retry. */
  onRetryFailed?: () => void;
  onDismissFailure?: () => void;
}

export const KeyringView: React.FC<KeyringViewProps> = ({ signatureFailure, onRetryFailed, onDismissFailure }) => {
  const [state, setState] = useState<ViewState>("loading");
  const [keyringData, setKeyringData] = useState<KeyringStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  const [errorDetails, setErrorDetails] = useState<string | undefined>(undefined);
  const { log, appendLog, flushLog, resetLog } = useStreamingLog();
  const [searchFilter, setSearchFilter] = useState("");
  const [trustFilter, setTrustFilter] = useState("all");
  const [trustSelectOpen, setTrustSelectOpen] = useState(false);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const runRef = useRef(0);
  const [stopAsked, setStopAsked] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [stoppedRun, setStoppedRun] = useState<KeyringRun>("refreshing");
  const [stoppedMessage, setStoppedMessage] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | undefined>(undefined);
  const [keyProgress, setKeyProgress] = useState<{ current: number; total: number } | null>(null);
  const stopQuestionId = useId();
  const stopButtonRef = useRef<React.ComponentRef<"button">>(null);
  const keepRunningRef = useRef<React.ComponentRef<"button">>(null);
  const stopFocusRef = useRef<"stop" | "keep" | null>(null);
  const stateRef = useRef(state);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { page, perPage, setPage, onSetPage, onPerPageSelect, resetPage } = usePagination();
  const { activeSortIndex, activeSortDirection, getSortParams } = useSortableTable({
    columns: { fingerprint: 0, uid: 1, trust: 2 },
    defaultDirection: "asc",
  });

  const failLoad = useCallback((ex: unknown) => {
    const failure = toLoadFailure(ex);
    setState("error");
    setError(failure.message);
    setErrorCode(failure.code);
    setErrorDetails(failure.details);
  }, []);

  const loadKeyringStatus = useCallback(async () => {
    setState("loading");
    setError(null);
    setErrorCode(undefined);
    setErrorDetails(undefined);
    try {
      const response = await getKeyringStatus();
      setKeyringData(response);
      setState("ready");
    } catch (ex) {
      failLoad(ex);
    }
  }, [failLoad]);

  useEffect(() => {
    let cancelled = false;
    getKeyringStatus()
      .then((response) => {
        if (cancelled) return;
        setKeyringData(response);
        setState("ready");
      })
      .catch((ex) => {
        if (cancelled) return;
        failLoad(ex);
      });
    return () => { cancelled = true; };
  }, [failLoad]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Background reads must preserve running and failure screens.
  const refreshKeyringStatus = useCallback(async () => {
    try {
      const response = await getKeyringStatus();
      setKeyringData(response);
      setState((s) => (s === "loading" ? "ready" : s));
    } catch (ex) {
      if (stateRef.current !== "ready" && stateRef.current !== "loading") return;
      failLoad(ex);
    }
  }, [failLoad]);

  useRefreshOnActivate(refreshKeyringStatus);

  const canAdminister = useAdminPermission();
  const refreshGate = useMutationGate("refresh the keys", { permission: canAdminister, owner: "keyring" });
  const initGate = useMutationGate("initialize the keyring", { permission: canAdminister, owner: "keyring" });
  const keyringUpdateGate = useMutationGate("update archlinux-keyring", { permission: canAdminister });
  const retryGate = useMutationGate(
    signatureFailure?.origin === "install" ? "install packages" : "upgrade packages",
    { permission: canAdminister },
  );
  const [installTarget, setInstallTarget] = useState<string | null>(null);
  const addKeyGate = useMutationGate("add keys", { permission: canAdminister });
  const [addKeyOpen, setAddKeyOpen] = useState(false);
  const [keyNotice, setKeyNotice] = useState<KeyNotice | null>(null);
  const knownAtOpenRef = useRef<Set<string>>(new Set());
  // Fingerprint whose row the table pages to once the reloaded keys include it.
  const revealRef = useRef<string | null>(null);
  const addKeyButtonRef = useRef<React.ComponentRef<"button">>(null);
  const focusAddKeyRef = useRef(false);
  const [remedied, setRemedied] = useState<{ failure: SignatureFailure | null; steps: RemedyStep[] }>({ failure: null, steps: [] });
  const remedySteps = signatureFailure && remedied.failure === signatureFailure ? remedied.steps : [];
  const retryButtonRef = useRef<React.ComponentRef<"button">>(null);
  const focusRetryRef = useRef(false);
  const announce = useAnnounce();
  const failureNoun = signatureFailure?.origin === "install" ? "install" : "upgrade";
  const prevCanAdministerRef = useRef(canAdminister);
  useEffect(() => {
    const prev = prevCanAdministerRef.current;
    prevCanAdministerRef.current = canAdminister;
    if (prev === false && canAdminister === true) refreshKeyringStatus();
  }, [canAdminister, refreshKeyringStatus]);

  useEffect(() => {
    if (focusAddKeyRef.current && !addKeyOpen) {
      focusAddKeyRef.current = false;
      addKeyButtonRef.current?.focus();
    }
  });

  useEffect(() => {
    if (focusRetryRef.current && retryButtonRef.current) {
      focusRetryRef.current = false;
      retryButtonRef.current.focus();
    }
  });

  const markRemedied = (step: RemedyStep) => {
    if (!signatureFailure) return;
    setRemedied((prev) => {
      const steps = prev.failure === signatureFailure ? prev.steps : [];
      return { failure: signatureFailure, steps: steps.includes(step) ? steps : [...steps, step] };
    });
    focusRetryRef.current = true;
    announce(`${REMEDY_DONE[step]}. Retry the ${failureNoun}.`);
  };

  const runKeyringMutation = (
    start: typeof refreshKeyring,
    running: KeyringRun,
    failed: "refreshError" | "initError",
  ) => {
    setState(running);
    resetLog();
    setErrorDetails(undefined);
    setIsDetailsExpanded(true);
    setStopAsked(false);
    setStopping(false);
    stoppingRef.current = false;
    setLastEventAt(undefined);
    setKeyProgress(null);
    const run = ++runRef.current;
    const finish = () => {
      cancelRef.current = null;
      flushLog();
      stoppingRef.current = false;
      setStopping(false);
      setStopAsked(false);
    };
    const showStopped = (message: string) => {
      setStoppedRun(running);
      setStoppedMessage(message);
      setState("stopped");
    };
    const { cancel } = start({
      onData: (data) => {
        if (run === runRef.current) appendLog(data);
      },
      onEvent: (event) => {
        if (run !== runRef.current) return;
        setLastEventAt(Date.now());
        if (event.type === "event" && event.current != null && event.total) {
          setKeyProgress({ current: event.current, total: event.total });
        }
      },
      onComplete: () => {
        if (run !== runRef.current) return;
        if (stoppingRef.current) {
          announce(running === "refreshing" ? "The key refresh finished before it could be stopped" : "Initialization finished before it could be stopped");
        }
        finish();
        if (running === "refreshing") markRemedied("keys");
        loadKeyringStatus();
      },
      onError: (err, code, details) => {
        if (run !== runRef.current) return;
        setErrorDetails(details);
        const wasStopping = stoppingRef.current;
        finish();
        if (wasStopping && code === "cancelled") {
          showStopped(err);
          return;
        }
        setState(failed);
        setError(err);
        setErrorCode(code);
        setErrorDetails(details);
      },
    });
    cancelRef.current = cancel;

  };

  useEffect(() => {
    const target = stopFocusRef.current;
    stopFocusRef.current = null;
    if (target === "keep") keepRunningRef.current?.focus();
    else if (target === "stop") stopButtonRef.current?.focus();
  }, [stopAsked, stopping]);

  const askStop = () => {
    stopFocusRef.current = "keep";
    setStopAsked(true);
  };

  const answerStop = (stop: boolean) => {
    stopFocusRef.current = "stop";
    setStopAsked(false);
    if (!stop || !cancelRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setLastEventAt(Date.now());
    cancelRef.current();
  };

  const handleRefreshKeys = () => {
    if (refreshGate.blocked) return;
    runKeyringMutation(refreshKeyring, "refreshing", "refreshError");
  };
  const handleInitKeyring = () => {
    if (initGate.blocked) return;
    runKeyringMutation(initKeyring, "initializing", "initError");
  };

  const handleRetryFailed = () => {
    if (!signatureFailure) return;
    if (signatureFailure.retry) {
      onRetryFailed?.();
    } else if (signatureFailure.target) {
      setInstallTarget(signatureFailure.target);
    }
  };

  const handleInstallSuccess = () => {
    if (installTarget === "archlinux-keyring") {
      setInstallTarget(null);
      markRemedied("keyring");
    } else {
      onDismissFailure?.();
    }
    refreshKeyringStatus();
  };

  const retryCount = signatureFailure?.count;
  const retryLabel = signatureFailure?.origin === "install"
    ? "Retry install"
    : retryCount ? `Retry upgrade (${plural(retryCount, "package")})` : "Retry upgrade";
  const canRetry = !!signatureFailure && (!!signatureFailure.retry || !!signatureFailure.target);
  const failureAlert = (showRefresh: boolean) => {
    if (!signatureFailure) return null;
    const isRemedied = remedySteps.length > 0;
    const what = signatureFailure.origin === "install" && signatureFailure.target
      ? `The install of ${signatureFailure.target} stopped because a package signature could not be verified.`
      : "A package signature could not be verified.";
    return (
      <Alert
        variant={isRemedied ? "warning" : "danger"}
        isInline
        className="pf-v6-u-mb-md"
        title={`${failureNoun === "install" ? "Install" : "Upgrade"} blocked by an untrusted signature`}
        actionClose={<AlertActionCloseButton onClose={() => onDismissFailure?.()} />}
        actionLinks={
          <>
            {!remedySteps.includes("keyring") && (
              <GatedButton gate={keyringUpdateGate} variant="link" isInline onClick={() => setInstallTarget("archlinux-keyring")}>
                Update archlinux-keyring
              </GatedButton>
            )}
            {showRefresh && !remedySteps.includes("keys") && (
              <GatedButton gate={refreshGate} variant="link" isInline onClick={handleRefreshKeys}>
                Refresh keys
              </GatedButton>
            )}
            {canRetry && !isRemedied && (
              <GatedButton gate={retryGate} variant="link" isInline onClick={handleRetryFailed}>
                {retryLabel}
              </GatedButton>
            )}
          </>
        }
      >
        {isRemedied ? (
          <>
            <Content component={ContentVariants.ul} isPlainList aria-label="Completed steps">
              {remedySteps.map((step) => (
                <Content component={ContentVariants.li} key={step}>
                  <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" /> {REMEDY_DONE[step]}
                </Content>
              ))}
            </Content>
            <Content component={ContentVariants.p}>Keyring updated. Retry the {failureNoun}.</Content>
            {canRetry && (
              <GatedButton ref={retryButtonRef} gate={retryGate} variant="primary" onClick={handleRetryFailed}>
                {retryLabel}
              </GatedButton>
            )}
          </>
        ) : (
          <>
            {what} An outdated archlinux-keyring package is the usual cause. Update it or refresh the keys, then retry.
          </>
        )}
      </Alert>
    );
  };

  const installModal = installTarget ? (
    <PackageActionModal
      config={installConfig}
      packageName={installTarget}
      packageVersion="latest"
      isOpen
      onClose={() => setInstallTarget(null)}
      onSuccess={handleInstallSuccess}
    />
  ) : null;

  const openAddKey = () => {
    knownAtOpenRef.current = new Set(keyringData?.keys.map((k) => k.fingerprint.toUpperCase()) ?? []);
    setAddKeyOpen(true);
  };

  // Focus moves once the dialog has unmounted; its focus trap would pull an
  // earlier focus() back inside.
  const closeAddKey = () => {
    setAddKeyOpen(false);
    focusAddKeyRef.current = true;
  };

  const showKeyNotice = (key: KeyringKey, signed: boolean) => {
    closeAddKey();
    setKeyNotice({ key, signed, existed: knownAtOpenRef.current.has(key.fingerprint.toUpperCase()) });
    revealRef.current = key.fingerprint.toUpperCase();
    refreshKeyringStatus();
  };

  const handleAddKeyClose = (added: KeyringKey | null) => {
    if (added) {
      showKeyNotice(added, false);
      return;
    }
    closeAddKey();
  };

  const handleKeySigned = (key: KeyringKey) => showKeyNotice(key, true);

  const handleClearFilter = () => {
    setSearchFilter("");
    setTrustFilter("all");
    resetPage();
    searchInputRef.current?.focus();
  };

  const trustLevels = useMemo(() => {
    const levels = new Set(keyringData?.keys.map((k) => k.trust) ?? []);
    return Array.from(levels).sort();
  }, [keyringData]);

  const filteredKeys = useMemo(() => {
    let result = keyringData?.keys ?? [];
    if (searchFilter) {
      const search = searchFilter.toLowerCase();
      result = result.filter(
        (key) =>
          key.fingerprint.toLowerCase().includes(search) ||
          key.uid.toLowerCase().includes(search) ||
          key.trust.toLowerCase().includes(search)
      );
    }
    if (trustFilter !== "all") {
      result = result.filter((key) => key.trust === trustFilter);
    }
    return result;
  }, [keyringData, searchFilter, trustFilter]);


  const sortedKeys = useMemo(() => {
    return [...filteredKeys].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 0:
          comparison = a.fingerprint.localeCompare(b.fingerprint);
          break;
        case 1:
          comparison = a.uid.localeCompare(b.uid);
          break;
        case 2:
          comparison = a.trust.localeCompare(b.trust);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [filteredKeys, activeSortIndex, activeSortDirection]);

  useEffect(() => {
    const target = revealRef.current;
    if (!target) return;
    const index = sortedKeys.findIndex((k) => k.fingerprint.toUpperCase() === target);
    if (index >= 0) {
      revealRef.current = null;
      setPage(Math.floor(index / perPage) + 1);
    }
  }, [sortedKeys, perPage, setPage]);

  const noticeFingerprint = keyNotice?.key.fingerprint.toUpperCase();
  const noticeHidden = !!noticeFingerprint
    && !!keyringData?.keys.some((k) => k.fingerprint.toUpperCase() === noticeFingerprint)
    && !filteredKeys.some((k) => k.fingerprint.toUpperCase() === noticeFingerprint);

  const paginatedKeys = useMemo(() => {
    const start = (page - 1) * perPage;
    return sortedKeys.slice(start, start + perPage);
  }, [sortedKeys, page, perPage]);


  const getTrustDescription = (trust: string): string => {
    switch (trust.toLowerCase()) {
      case "ultimate":
        return "Ultimate trust: This key belongs to you or is fully trusted.";
      case "full":
        return "Full trust: Signatures from this key are fully trusted.";
      case "marginal":
        return "Marginal trust: Signatures from this key are partially trusted.";
      case "unknown":
        return "Unknown trust: Trust level has not been assigned to this key.";
      case "undefined":
        return "Undefined trust: Trust has not been defined for this key.";
      case "never":
        return "Never trust: Signatures from this key should never be trusted.";
      case "expired":
        return "Expired: This key has passed its expiration date.";
      case "revoked":
        return "Revoked: This key has been revoked and should not be trusted.";
      default:
        return "Trust level not recognized.";
    }
  };

  const debouncedFilter = useDebouncedValue(`${searchFilter}|${trustFilter}`, SEARCH_DEBOUNCE_MS);
  const filterKey = `${searchFilter}|${trustFilter}`;
  useResultAnnouncement(
    filteredKeys.length === 0
      ? "No keys match your filter"
      : `${plural(filteredKeys.length, "key")} shown`,
    debouncedFilter === filterKey ? filterKey : null,
  );

  const getTrustColor = (trust: string): "blue" | "green" | "orange" | "red" | "grey" => {
    switch (trust.toLowerCase()) {
      case "ultimate":
      case "full":
        return "green";
      case "marginal":
        return "orange";
      case "never":
      case "expired":
      case "revoked":
        return "red";
      case "unknown":
      case "undefined":
      default:
        return "grey";
    }
  };

  if (state === "loading") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading keyring status">
            <EmptyStateBody>Querying pacman keyring…</EmptyStateBody>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  if (state === "refreshError" || state === "initError") {
    const isRefresh = state === "refreshError";
    const retry = isRefresh ? handleRefreshKeys : handleInitKeyring;
    const gate = isRefresh ? refreshGate : initGate;
    return (
      <Card>
        <CardBody>
          {isNetworkError(null, errorCode) ? (
            <NetworkErrorState
              resource={isRefresh ? "keys from the keyserver" : "the Arch Linux keys"}
            />
          ) : (
            <Alert variant="danger" title={isRefresh ? "Key refresh failed" : "Keyring initialization failed"}>
              {sanitizeErrorMessage(error)}
              <ErrorDetails details={errorDetails} />
            </Alert>
          )}
          <div className="pf-v6-u-mt-md">
            <GatedButton gate={gate} variant="primary" onClick={retry}>
              Try again
            </GatedButton>{" "}
            <Button variant="link" onClick={loadKeyringStatus}>
              Back to keyring
            </Button>
          </div>
          {log && <LogViewer log={log} className="pf-v6-u-mt-md" />}
        </CardBody>
      </Card>
    );
  }

  if (state === "error") {
    return (
      <Card>
        <CardBody>
          {isNetworkError(null, errorCode) ? (
            <NetworkErrorState
              resource="the keyring"
              onRetry={loadKeyringStatus}
              retryLabel="Try again"
            />
          ) : (
            <LoadErrorState
              what="keyring status"
              error={error}
              code={errorCode}
              details={errorDetails}
              onRetry={loadKeyringStatus}
            />
          )}
        </CardBody>
      </Card>
    );
  }

  if (state === "stopped") {
    return (
      <Card>
        <CardBody>
          <EmptyState headingLevel="h2" icon={InfoCircleIcon} titleText={RUN_COPY[stoppedRun].stoppedTitle}>
            <EmptyStateBody>{stoppedMessage}<ErrorDetails details={errorDetails} /></EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={loadKeyringStatus}>Back to keyring</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
          {log && <LogViewer log={log} className="pf-v6-u-mt-md" />}
        </CardBody>
      </Card>
    );
  }

  if (state === "refreshing" || state === "initializing") {
    const title = state === "initializing" ? "Initializing keyring" : "Refreshing keys";
    const subtitle = state === "initializing"
      ? "Creating master key and populating with Arch Linux keys…"
      : "Refreshing keys from keyserver…";
    const copy = RUN_COPY[state];

    return (
      <Card>
        <CardBody>
          <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <CardTitle className="pf-v6-u-m-0">{title}</CardTitle>
            </FlexItem>
            {!stopAsked && (
              <FlexItem>
                <Button
                  ref={stopButtonRef}
                  variant="secondary"
                  onClick={askStop}
                  isAriaDisabled={stopping}
                  isLoading={stopping}
                >
                  {stopping ? "Stopping…" : "Stop"}
                </Button>
              </FlexItem>
            )}
          </Flex>

          {stopAsked && (
            <Alert variant="warning" isInline id={stopQuestionId} title={copy.question} className="pf-v6-u-mt-md">
              <Content component={ContentVariants.p}>{copy.consequence}</Content>
              <Flex spaceItems={{ default: "spaceItemsSm" }}>
                <Button variant="danger" onClick={() => answerStop(true)} aria-describedby={stopQuestionId}>
                  {copy.confirm}
                </Button>
                <Button variant="link" ref={keepRunningRef} onClick={() => answerStop(false)} aria-describedby={stopQuestionId}>
                  Keep running
                </Button>
              </Flex>
            </Alert>
          )}

          {stopping && (
            <div className="pf-v6-u-mt-md">
              <CancellationNotice lastEventAt={lastEventAt} />
            </div>
          )}

          {keyProgress ? (
            <Progress
              className="pf-v6-u-mt-md pf-v6-u-mb-md"
              value={Math.floor((keyProgress.current / keyProgress.total) * 100)}
              title="Refreshing keys from keyserver"
              measureLocation={ProgressMeasureLocation.outside}
              valueText={`Key ${keyProgress.current.toLocaleString()} of ${keyProgress.total.toLocaleString()}`}
            />
          ) : (
            <div className="pf-v6-u-mt-md pf-v6-u-mb-md">
              <Spinner size="md" aria-hidden /> {subtitle}
            </div>
          )}

          <ExpandableLogViewer
            log={log}
            placeholder="Starting…"
            isExpanded={isDetailsExpanded}
            onToggle={setIsDetailsExpanded}
          />
        </CardBody>
      </Card>
    );
  }

  if (keyringData?.status === "undetermined") {
    return (
      <>
        {failureAlert(false)}
        {installModal}
        <KeyringWarnings warnings={keyringData.warnings} />
        <Card>
          <CardBody>
            <EmptyState headingLevel="h2" icon={KeyIcon} titleText="Keyring state could not be determined">
              <EmptyStateBody>
                {canAdminister === false
                  ? "Reading the keys and their trust needs administrative access. Turn on administrative access and this page checks again. Use the Limited access button in Cockpit's top bar."
                  : "The keyring check did not produce a definite answer. The warning above says why."}
              </EmptyStateBody>
              {canAdminister !== false && (
                <EmptyStateFooter>
                  <EmptyStateActions>
                    <Button variant="primary" onClick={loadKeyringStatus}>
                      Check again
                    </Button>
                  </EmptyStateActions>
                </EmptyStateFooter>
              )}
            </EmptyState>
          </CardBody>
        </Card>
      </>
    );
  }

  if (!keyringData?.master_key_initialized) {
    return (
      <>
        {failureAlert(false)}
        {installModal}
        <KeyringWarnings warnings={keyringData?.warnings ?? []} />
        <Card>
          <CardBody>
            <EmptyState headingLevel="h2" icon={KeyIcon} titleText="Keyring not initialized">
              <EmptyStateBody>
                The pacman keyring has not been initialized. Initialize it to verify package signatures.
              </EmptyStateBody>
              <EmptyStateFooter>
                <EmptyStateActions>
                  <GatedButton gate={initGate} variant="primary" onClick={handleInitKeyring}>
                    Initialize keyring
                  </GatedButton>
                </EmptyStateActions>
              </EmptyStateFooter>
            </EmptyState>
          </CardBody>
        </Card>
      </>
    );
  }

  return (
    <>
      {failureAlert(true)}
      {installModal}
      {addKeyOpen && <ImportKeyModal gate={addKeyGate} onClose={handleAddKeyClose} onSigned={handleKeySigned} />}
      <KeyringWarnings warnings={keyringData?.warnings ?? []} />
      <UndoAlert
        title={keyNotice ? keyNoticeTitle(keyNotice) : null}
        variant={keyNotice?.signed ? "success" : "info"}
        onClose={() => setKeyNotice(null)}
      >
        {keyNotice && (keyNotice.signed
          ? `pacman now accepts packages signed by this key. Its trust is ${keyNotice.key.trust}.`
          : "pacman rejects packages signed by this key until it is locally signed.")}
        {noticeHidden && " The current filter hides it."}
      </UndoAlert>

      <Card>
        <CardBody>
        <Toolbar className="pf-v6-u-px-0">
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                ref={searchInputRef}
                placeholder="Filter keys by name, email or fingerprint"
                value={searchFilter}
                onChange={(_event: React.SyntheticEvent, value: string) => setSearchFilter(value)}
                onClear={() => setSearchFilter("")}
                aria-label="Filter keys"
              />
            </ToolbarItem>
            {trustLevels.length > 1 && (
              <ToolbarItem>
                <Select
                  isOpen={trustSelectOpen}
                  selected={trustFilter}
                  onSelect={(_event: React.MouseEvent | undefined, value: string | number | undefined) => {
                    setTrustFilter(value as string);
                    setTrustSelectOpen(false);
                  }}
                  onOpenChange={setTrustSelectOpen}
                  toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setTrustSelectOpen(!trustSelectOpen)}
                      isExpanded={trustSelectOpen}
                    >
                      {trustFilter === "all" ? "All trust levels" : trustFilter}
                    </MenuToggle>
                  )}
                >
                  <SelectList>
                    <SelectOption value="all">All trust levels</SelectOption>
                    {trustLevels.map((level) => (
                      <SelectOption key={level} value={level}>
                        {level}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </ToolbarItem>
            )}
            <ToolbarItem>
              <GatedButton gate={refreshGate} variant="secondary" icon={<SyncAltIcon />} onClick={handleRefreshKeys}>
                Refresh
              </GatedButton>{" "}
              <HelpPopover
                label="refreshing keys"
                body="Fetches and updates keys from configured keyservers. This is a network operation and can take a minute."
              />
            </ToolbarItem>
            <ToolbarItem>
              <GatedButton
                ref={addKeyButtonRef}
                gate={addKeyGate}
                variant="secondary"
                icon={<PlusCircleIcon />}
                onClick={openAddKey}
              >
                Add key
              </GatedButton>
            </ToolbarItem>
            <ToolbarItem align={{ default: "alignEnd" }}>
              {plural(keyringData?.total ?? 0, "key")} in keyring
              {filteredKeys.length !== (keyringData?.total ?? 0) && ` (${filteredKeys.length.toLocaleString()} shown)`}
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        <Table aria-label="Keyring keys" variant="compact">
          <Thead noWrap>
            <Tr>
              <Th sort={getSortParams(0)}>Fingerprint</Th>
              <Th sort={getSortParams(1)}>User ID</Th>
              <Th
                sort={getSortParams(2)}
                info={helpInfo("trust levels", (
                  <Content component={ContentVariants.dl}>
                    {trustLevels.map((level) => (
                      <React.Fragment key={level}>
                        <Content component={ContentVariants.dt}>{level}</Content>
                        <Content component={ContentVariants.dd}>{getTrustDescription(level)}</Content>
                      </React.Fragment>
                    ))}
                  </Content>
                ), "Trust levels")}
              >
                Trust
              </Th>
              <Th>Created</Th>
              <Th>Expires</Th>
            </Tr>
          </Thead>
          <Tbody>
            {paginatedKeys.map((key: KeyringKey) => (
              <Tr key={key.fingerprint}>
                <Td dataLabel="Fingerprint">
                  <code style={{ fontSize: "0.85em", overflowWrap: "anywhere" }}>
                    <Fingerprint value={key.fingerprint} />
                  </code>
                </Td>
                <Td dataLabel="User ID">
                  {key.uid || "-"}
                  {keyNotice && key.fingerprint.toUpperCase() === noticeFingerprint && (
                    <Label color="blue" isCompact className="pf-v6-u-ml-sm">{keyNoticeLabel(keyNotice)}</Label>
                  )}
                </Td>
                <Td dataLabel="Trust">
                  <Label color={getTrustColor(key.trust)}>{key.trust}</Label>
                </Td>
                <Td dataLabel="Created"><TimeAgo timestamp={key.created} fallback="-" /></Td>
                <Td dataLabel="Expires"><TimeAgo timestamp={key.expires} fallback="-" /></Td>
              </Tr>
            ))}
          </Tbody>
        </Table>

        {sortedKeys.length > 0 && (
          <Toolbar>
            <ToolbarContent>
              <ToolbarItem variant="pagination" align={{ default: "alignEnd" }}>
                <CompactPagination
                  itemCount={sortedKeys.length}
                  page={page}
                  perPage={perPage}
                  onSetPage={onSetPage}
                  onPerPageSelect={onPerPageSelect}
                />
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        )}

        {sortedKeys.length === 0 && (
          <EmptyState headingLevel="h3" titleText="No keys found">
            <EmptyStateBody>
              {searchFilter || trustFilter !== "all"
                ? "No keys match your filter."
                : "The keyring contains no keys."}
            </EmptyStateBody>
            {(searchFilter || trustFilter !== "all") && (
              <EmptyStateFooter>
                <EmptyStateActions>
                  <Button variant="primary" onClick={handleClearFilter}>
                    Clear filter
                  </Button>
                </EmptyStateActions>
              </EmptyStateFooter>
            )}
          </EmptyState>
        )}
        </CardBody>
      </Card>
    </>
  );
};

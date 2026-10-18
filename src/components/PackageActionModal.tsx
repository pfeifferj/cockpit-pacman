import React, { useState, useEffect, useCallback, useRef, useId } from "react";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useMutationGate } from "../hooks/useMutationGate";
import { useBackdropClose } from "../hooks/useBackdropClose";
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Alert,
  AlertActionLink,
  Progress,
  ProgressMeasureLocation,
  EmptyState,
  EmptyStateBody,
  Label,
  Content,
  ContentVariants,
  Spinner,
} from "@patternfly/react-core";
import { ExpandableLogViewer } from "./LogViewer";
import { ErrorAlert } from "./ErrorAlert";
import { LockErrorBody } from "./LockErrorBody";
import { CancellationNotice } from "./CancellationNotice";
import { TransactionPreview, previewSummary, type AcknowledgementState } from "./TransactionPreview";
import { GatedButton } from "./GatedButton";
import { PREVIEW_STALE_REASON, PreviewStaleAlert, usePreviewStaleness } from "./PreflightConfirmModal";
import { CheckCircleIcon } from "@patternfly/react-icons";
import {
  BackendError,
  checkLock,
  checkUpdates,
  installPackage,
  previewInstall,
  previewRemove,
  removePackage,
  ErrorCode,
  StreamingHandle,
  UpgradeCallbacks,
  type TransactionPreview as PreviewData,
} from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { useNavigation } from "../contexts/NavigationContext";
import { sanitizeErrorMessage } from "../utils";
import { initialProgress, progressPercent, progressValueText, ProgressPlan } from "../progress";
import { RunSession, useRunInBackground, useRunSnapshot, type RunStatus } from "./TransactionHost";

const UNKNOWN_PLAN: ProgressPlan = { downloadBytes: 0, packages: 0 };

// Spinner text is held back this long so a fast preview does not flash it.
const PREVIEW_TEXT_DELAY_MS = 1000;

type ModalState = "previewing" | "confirm" | "running" | "cancelling" | "success" | "stopped" | "error";

const RUN_STATE: Record<RunStatus, ModalState> = {
  running: "running",
  cancelling: "cancelling",
  success: "success",
  stopped: "stopped",
  failed: "error",
};

interface ActionConfig {
  warnPendingUpdates?: boolean;
  verb: string;
  /** Consequence text above the preview; `preview` is absent while it loads. */
  confirmPrompt: (pkg: string, preview?: PreviewData) => React.ReactNode;
  /** Commit button text; `dependencies` is dependencyCount of the preview. */
  confirmLabel: (pkg: string, dependencies?: number) => string;
  /** Resolves the transaction without committing. Without it the modal opens on the confirm step. */
  preview?: (name: string) => Promise<PreviewData>;
  /** Packages in the preview beyond the target itself. */
  dependencyCount: (preview: PreviewData) => number;
  /** The preview's blocked_by lists installed dependents of the target, so the user can resolve the block from the graph. */
  blockedByDependents?: boolean;
  /** Names this action to the Keyring tab after a signature failure. */
  keyringOrigin?: "install";
  failureTitle: (pkg: string) => string;
  confirmVariant: "primary" | "danger";
  runningText: string;
  /** Present participle for the stop confirmation, e.g. "installing". */
  stopVerb: string;
  successTitle: string;
  successText: (pkg: string) => string;
  run: (callbacks: UpgradeCallbacks, name: string, approvedRemovals?: string[]) => StreamingHandle;
}

interface PackageActionModalProps {
  packageName: string;
  packageVersion: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  /** A run already in progress, shown instead of a new preview. */
  session?: RunSession;
}

export const PackageActionModal: React.FC<PackageActionModalProps & { config: ActionConfig }> = ({
  packageName,
  packageVersion,
  isOpen,
  onClose,
  onSuccess,
  session: initialSession,
  config,
}) => {
  const permission = useAdminPermission();
  const commitGate = useMutationGate(`${config.verb.toLowerCase()} packages`, { permission });
  const [localState, setState] = useState<ModalState>(config.preview ? "previewing" : "confirm");
  const [session, setSession] = useState<RunSession | null>(initialSession ?? null);
  const run = useRunSnapshot(session);
  const state = run ? RUN_STATE[run.status] : localState;
  const log = run?.log ?? "";
  const progress = run?.progress ?? initialProgress;
  const error = run?.error ?? null;
  const errorCode = run?.errorCode;
  const errorDetails = run?.errorDetails;
  const [updateCheck, setUpdateCheck] = useState<{ count: number } | { error: string } | null>(null);
  const checkingUpdates = !!config.warnPendingUpdates && updateCheck === null;
  const finishedAfterCancel = run?.finishedAfterCancel ?? false;
  const runInBackground = useRunInBackground();
  // The page-level host owns a session it was handed, so this dialog must not cancel it on unmount.
  const handedOffRef = useRef(initialSession !== undefined);
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const dismissable = state !== "running" && state !== "cancelling";
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(initialSession !== undefined);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const stopAsked = confirmingStop && state === "running";
  const cancelButtonRef = useRef<HTMLElement>(null);
  const keepRunningRef = useRef<HTMLElement>(null);
  const cancellingRef = useRef<HTMLElement>(null);
  const stopFocusRef = useRef<"keep" | "cancel" | "cancelling" | null>(null);
  const terminalFocusRef = useRef<HTMLElement>(null);
  const prevStateRef = useRef<ModalState | null>(null);
  const stopQuestionId = useId();
  const titleId = useId();
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<AcknowledgementState | null>(null);
  const [previewError, setPreviewError] = useState<{ message: string; code?: ErrorCode; details?: string } | null>(null);
  const [showPreviewText, setShowPreviewText] = useState(false);
  const previewRequestRef = useRef(0);
  const announce = useAnnounce();
  const { onViewDependencies, onViewUpdates } = useNavigation();
  const [lastEventAt, setLastEventAt] = useState<number | undefined>(undefined);
  const [staleLock, setStaleLock] = useState(false);

  useEffect(() => session?.subscribe(() => setLastEventAt(Date.now())), [session]);

  const staleness = usePreviewStaleness(isOpen && !run && (state === "previewing" || state === "confirm"));
  const { reset: resetStale } = staleness;
  const stale = staleness.staleAt !== null;

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
      setStaleLock(false);
    };
  }, [state]);

  const startPreview = useCallback(() => {
    const request = ++previewRequestRef.current;
    setPreview(null);
    setAcknowledgement(null);
    setPreviewError(null);
    resetStale();
    if (!config.preview) {
      setState("confirm");
      return;
    }
    setState("previewing");
    config.preview(packageName).then(
      (result) => {
        if (request !== previewRequestRef.current) return;
        setPreview(result);
        setState("confirm");
        announce(`Preview ready: ${result.success ? previewSummary(result) : config.failureTitle(packageName)}`);
      },
      (ex) => {
        if (request !== previewRequestRef.current) return;
        setPreviewError({
          message: sanitizeErrorMessage(ex instanceof Error ? ex.message : String(ex)),
          code: ex instanceof BackendError ? ex.code : undefined,
          details: ex instanceof BackendError ? ex.details : undefined,
        });
        setState("confirm");
        announce("Could not check what will change");
      }
    );
  }, [config, packageName, announce, resetStale]);

  useEffect(() => {
    if (state !== "previewing") return;
    const timer = setTimeout(() => setShowPreviewText(true), PREVIEW_TEXT_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShowPreviewText(false);
    };
  }, [state]);

  useEffect(() => {
    if (!isOpen || !config.warnPendingUpdates) return;
    let stale = false;
    checkUpdates()
      .then((response) => {
        if (!stale) setUpdateCheck({ count: response.updates.length });
      })
      .catch((err: unknown) => {
        if (!stale) setUpdateCheck({ error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      stale = true;
      setUpdateCheck(null);
    };
  }, [isOpen, config.warnPendingUpdates, packageName]);

  const resetState = useCallback(() => {
    setState("confirm");
    setSession(null);
    setIsDetailsExpanded(false);
    setConfirmingStop(false);
  }, []);

  const restart = useCallback(() => {
    resetState();
    startPreview();
  }, [resetState, startPreview]);

  const resumingRef = useRef(initialSession !== undefined);
  useEffect(() => {
    if (!isOpen) {
      previewRequestRef.current++;
      return;
    }
    if (resumingRef.current) {
      resumingRef.current = false;
      return;
    }
    Promise.resolve().then(restart);
  }, [isOpen, restart]);

  useEffect(() => {
    return () => {
      if (!handedOffRef.current) sessionRef.current?.abandon();
    };
  }, []);

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

  const handleConfirm = () => {
    if (commitGate.blocked || checkingUpdates || acknowledgement?.complete === false || stale) return;
    setConfirmingStop(false);
    setIsDetailsExpanded(true);
    const next = new RunSession(`${config.verb} ${packageName}`);
    handedOffRef.current = false;
    setSession(next);
    next.start((callbacks) => config.run(callbacks, packageName, preview?.remove.map(p => p.name) ?? []), UNKNOWN_PLAN, onSuccess);
  };

  const handleRunInBackground = () => {
    if (!session || !runInBackground) return;
    handedOffRef.current = true;
    const handed = session;
    runInBackground({
      session: handed,
      render: (close) => (
        <PackageActionModal
          config={config}
          packageName={packageName}
          packageVersion={packageVersion}
          isOpen
          onClose={close}
          session={handed}
        />
      ),
    });
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

  // slow to acknowledge the graceful cancel.
  const handleStop = () => {
    stopFocusRef.current = "cancelling";
    setConfirmingStop(false);
    session?.stop();
  };


  const handleClose = () => {
    if (!handedOffRef.current) session?.abandon();
    onClose();
  };
  useBackdropClose(isOpen, dismissable ? handleClose : undefined);

  const handleViewDependents = () => {
    handleClose();
    onViewDependencies?.(packageName);
  };

  const prompt = (
    <Content>
      <Content component={ContentVariants.p}>
        {config.confirmPrompt(packageName, preview ?? undefined)}
      </Content>
      <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
        <Label isCompact variant="outline">{packageVersion}</Label>
      </Content>
      {config.warnPendingUpdates && updateCheck && (
        "error" in updateCheck ? (
          <Alert component="h2" variant="warning" isInline title="Could not check pending updates">{updateCheck.error}</Alert>
        ) : updateCheck.count > 0 && (
          <Alert component="h2" variant="warning" isInline title="Updates are pending"
            actionLinks={onViewUpdates && <AlertActionLink onClick={() => { handleClose(); onViewUpdates(); }}>View updates</AlertActionLink>}>
            Installing from newer package databases without a full upgrade can break dependencies. Upgrade the system first.
          </Alert>
        )
      )}
    </Content>
  );

  const renderContent = () => {
    switch (state) {
      case "previewing":
        return (
          <>
            {prompt}
            <Content className="pf-v6-u-mt-md">
              <Spinner size="md" aria-label="Checking what will change" />
              {showPreviewText && " Checking what will change…"}
            </Content>
          </>
        );

      case "confirm":
        return (
          <>
            {prompt}
            <div className="pf-v6-u-mt-md">
              {previewError ? (
                <ErrorAlert headingLevel="h2"
                  error={previewError.message}
                  code={previewError.code}
                  details={previewError.details}
                  title="Could not check what will change"
                  beforeNavigate={handleClose}
                  onRetry={startPreview}
                  signatureOrigin={config.keyringOrigin && { origin: config.keyringOrigin, target: packageName }}
                />
              ) : preview && (
                <>
                  <PreviewStaleAlert staleAt={staleness.staleAt} className="pf-v6-u-mb-md" />
                  <TransactionPreview
                    preview={preview}
                    failureTitle={config.failureTitle(packageName)}
                    onAcknowledgedChange={setAcknowledgement}
                    beforeNavigate={handleClose}
                  />
                </>
              )}
            </div>
          </>
        );

      case "running":
      case "cancelling": {
        const value = progressPercent(progress);
        return (
          <>
            {stopAsked && (
              <Alert component="h2"
                variant="warning"
                isInline
                id={stopQuestionId}
                title={`Stop ${config.stopVerb} ${packageName}?`}
                className="pf-v6-u-mb-md"
              >
                The transaction is stopped before packages are committed. Once the commit step starts it cannot be stopped.
              </Alert>
            )}
            {state === "cancelling" && (
              <CancellationNotice lastEventAt={lastEventAt} phase={progress.phase} />
            )}
            <Content className="pf-v6-u-mb-sm">
              <strong>
                {state === "cancelling"
                  ? "Cancelling…"
                  : progress.value === undefined ? `${config.runningText} ${packageName}` : progress.phaseLabel}
              </strong>
              {progress.item && (
                <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                  {" "}- {progress.item}
                </span>
              )}
            </Content>
            <Progress
              className="pf-v6-u-mb-md"
              value={value}
              helperText={progress.stepLabel}
              measureLocation={value !== undefined ? ProgressMeasureLocation.outside : ProgressMeasureLocation.none}
              aria-label={`${config.verb} progress`}
              valueText={progressValueText(progress)}
            />
            <ExpandableLogViewer
              log={log}
              placeholder="Starting…"
              isExpanded={isDetailsExpanded}
              onToggle={setIsDetailsExpanded}
            />
          </>
        );
      }

      case "success":
        return (
          <EmptyState
            headingLevel="h2"
            icon={CheckCircleIcon}
            titleText={finishedAfterCancel ? "The transaction finished before it could be stopped" : config.successTitle}
          >
            <EmptyStateBody>
              {config.successText(packageName)}
            </EmptyStateBody>
          </EmptyState>
        );

      case "stopped":
        return (
          <>
            <Alert component="h2" variant="custom" isInline title="Stopped" className="pf-v6-u-mb-md">
              {sanitizeErrorMessage(error)}
            </Alert>
            {staleLock && (
              <Alert component="h2" variant="warning" isInline title="Database is locked" className="pf-v6-u-mb-md">
                <LockErrorBody onRetry={restart} onAutoRetry={() => setStaleLock(false)} onCleared={() => {}} />
              </Alert>
            )}
            <ExpandableLogViewer
              log={log}
              placeholder="No output"
              isExpanded={isDetailsExpanded}
              onToggle={setIsDetailsExpanded}
            />
          </>
        );

      case "error":
        return (
          <>
            <ErrorAlert headingLevel="h2"
              error={sanitizeErrorMessage(error)}
              code={errorCode}
              details={errorDetails}
              title={`${config.verb} failed`}
              className="pf-v6-u-mb-md"
              beforeNavigate={handleClose}
              onRetry={restart}
              signatureOrigin={config.keyringOrigin && { origin: config.keyringOrigin, target: packageName }}
            />
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
      case "previewing":
        return (
          <Button variant="link" onClick={handleClose}>
            Cancel
          </Button>
        );

      case "confirm":
        if (config.blockedByDependents && preview && !preview.success && preview.blocked_by.length > 0) {
          return (
            <>
              <Button variant="primary" onClick={handleClose}>
                Close
              </Button>
              {onViewDependencies && (
                <Button variant="link" onClick={handleViewDependents}>
                  View dependents
                </Button>
              )}
            </>
          );
        }
        if (previewError || (preview && !preview.success)) {
          return (
            <>
              <Button variant="primary" onClick={startPreview}>
                Check again
              </Button>
              <Button variant="link" onClick={handleClose}>
                Close
              </Button>
            </>
          );
        }
        return (
          <>
            <GatedButton
              variant={config.confirmVariant}
              onClick={handleConfirm}
              disabledReason={commitGate.reason ?? (checkingUpdates ? "Checking pending updates…" : stale ? PREVIEW_STALE_REASON : acknowledgement?.reason)}
            >
              {config.confirmLabel(packageName, preview ? config.dependencyCount(preview) : 0)}
            </GatedButton>
            {stale && (
              <Button variant="secondary" onClick={startPreview}>
                Refresh preview
              </Button>
            )}
            <Button variant="link" onClick={handleClose}>
              Cancel
            </Button>
          </>
        );

      case "running":
        return stopAsked ? (
          <>
            <Button variant="danger" onClick={handleStop} aria-describedby={stopQuestionId}>
              {`Stop ${config.stopVerb} ${packageName}`}
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
            <Button variant="primary" onClick={restart} ref={terminalFocusRef}>
              Try again
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
      variant={ModalVariant.small}
      isOpen={isOpen}
      onClose={dismissable ? handleClose : undefined}
      onEscapePress={dismissable ? undefined : () => {}}
      aria-labelledby={titleId}
    >
      <ModalHeader title={`${config.verb} ${packageName}`} labelId={titleId} />
      <ModalBody>{renderContent()}</ModalBody>
      <ModalFooter>{renderFooter()}</ModalFooter>
    </Modal>
  );
};

const withDependencies = (n: number) =>
  n === 0 ? "" : ` and ${n} ${n === 1 ? "dependency" : "dependencies"}`;

export const installConfig: ActionConfig = {
  warnPendingUpdates: true,
  verb: "Install",
  confirmPrompt: (pkg) => <>Install <strong>{pkg}</strong>?</>,
  confirmLabel: (pkg, dependencies = 0) => `Install ${pkg}${withDependencies(dependencies)}`,
  preview: previewInstall,
  keyringOrigin: "install",
  dependencyCount: (p) => p.add.filter((a) => a.reason === "dependency").length,
  failureTitle: (pkg) => `Cannot install ${pkg}`,
  confirmVariant: "primary",
  runningText: "Installing",
  stopVerb: "installing",
  successTitle: "Package installed",
  successText: (pkg) => `${pkg} has been installed.`,
  run: installPackage,
};

const removedDependencies = (p: PreviewData) => p.remove.filter((r) => r.reason === "dependency").length;

export const uninstallConfig: ActionConfig = {
  verb: "Remove",
  confirmPrompt: (pkg, preview) => (
    <>
      Removes <strong>{pkg}</strong>
      {preview
        ? removedDependencies(preview) > 0 && `${withDependencies(removedDependencies(preview))} that nothing else needs`
        : " and any dependencies that nothing else needs"}
      . Modified configuration files under /etc are kept as .pacsave files.
    </>
  ),
  confirmLabel: (pkg, dependencies = 0) => `Remove ${pkg}${withDependencies(dependencies)}`,
  preview: previewRemove,
  dependencyCount: removedDependencies,
  blockedByDependents: true,
  failureTitle: (pkg) => `Cannot remove ${pkg}`,
  confirmVariant: "danger",
  runningText: "Removing",
  stopVerb: "removing",
  successTitle: "Package removed",
  successText: (pkg) => `${pkg} has been removed.`,
  run: removePackage,
};

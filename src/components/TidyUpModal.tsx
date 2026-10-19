import React, { useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Content,
  ContentVariants,
  Flex,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  Progress,
  ProgressMeasureLocation,
  Spinner,
  Title,
} from "@patternfly/react-core";
import {
  cleanCache,
  getActiveTransaction,
  onSystemChanged,
  BackendError,
  type ErrorCode,
  formatSize,
  previewRemoveOrphans,
  previewCacheCleanup,
  removeOrphans,
  type StreamEvent,
  type StreamingHandle,
  type TransactionPreview as PreviewData,
} from "../api";
import { DEFAULT_KEEP_VERSIONS, type CleanupProjection } from "../cacheProjection";
import { initialProgress, progressPercent, progressValueText, reduceProgress, type ProgressPlan } from "../progress";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { useBackdropClose } from "../hooks/useBackdropClose";
import type { MutationGate } from "../hooks/useMutationGate";
import { plural } from "../utils";
import { GatedButton } from "./GatedButton";
import { ExpandableLogViewer, LogViewer } from "./LogViewer";
import { CancellationNotice } from "./CancellationNotice";
import { useStreamingLog } from "../hooks/useStreamingLog";
import { ErrorDetails } from "./ErrorDetails";
import { PREVIEW_STALE_REASON } from "./PreflightConfirmModal";
import { TransactionPreview, type AcknowledgementState } from "./TransactionPreview";

type Part = "orphans" | "cache";

type PartStatus = "success" | "failed" | "stopped" | "skipped";

interface PartResult {
  status: PartStatus;
  message?: string;
  code?: ErrorCode;
  details?: string;
  /** A skipped cache clean whose orphan removal finished after a stop was requested. */
  afterStopRequest?: boolean;
}

type OrphanPreview =
  | { status: "loading" }
  | { status: "ready"; preview: PreviewData }
  | { status: "error"; message: string; details?: string };

type Phase = "confirm" | "running" | "done";

const REMOVAL_PLAN: ProgressPlan = { downloadBytes: 0, packages: 0 };


const PART_NAME: Record<Part, string> = { orphans: "Orphan removal", cache: "Cache clean" };

const STOP_COPY: Record<Part, { title: string; body: string }> = {
  orphans: {
    title: "Stop removing orphan packages?",
    body: "The transaction is stopped before packages are removed, and the cache clean does not start. Once the commit step starts it cannot be stopped.",
  },
  cache: {
    title: "Stop cleaning the cache?",
    body: "Files already deleted stay deleted.",
  },
};

const cacheFiles = (n: number) => plural(n, "cache file");

function outcomeTitle(results: Partial<Record<Part, PartResult>>): string {
  const all = Object.values(results);
  if (all.some((r) => r?.status === "failed")) return "Tidy-up failed";
  if (all.some((r) => r?.status === "stopped" || r?.afterStopRequest)) return "Tidy-up stopped";
  return "Tidy-up finished";
}

export function tidyCommitLabel(orphans: number | null, cacheFileCount: number | null): string {
  const parts: string[] = [];
  if (orphans !== null) parts.push(`remove ${plural(orphans, "orphan")}`);
  if (cacheFileCount !== null) parts.push(`delete up to ${cacheFiles(cacheFileCount)}`);
  const text = parts.join(" and ");
  return text ? text[0].toUpperCase() + text.slice(1) : "Tidy up";
}

export interface TidyUpModalProps {
  onClose: () => void;
  orphans: string[];
  /** Cache files beyond the newest DEFAULT_KEEP_VERSIONS of each package. */
  cache: CleanupProjection;
  gate?: MutationGate;
  /** Called after a mounted run finishes. */
  onFinished?: () => void;
}

/** Mount once per plan; orphan failure or cancellation skips cache cleanup. */
export const TidyUpModal: React.FC<TidyUpModalProps> = ({ onClose, orphans: initialOrphans, cache: initialCache, gate, onFinished }) => {
  const [orphans] = useState(() => [...initialOrphans]);
  const [cache] = useState(initialCache);
  const titleId = useId();
  const questionId = useId();
  const announce = useAnnounce();

  const [phase, setPhase] = useState<Phase>("confirm");
  const [orphanPreview, setOrphanPreview] = useState<OrphanPreview | null>(orphans.length > 0 ? { status: "loading" } : null);
  const [includeOrphans, setIncludeOrphans] = useState(orphans.length > 0);
  const [cachePreview, setCachePreview] = useState<{ status: "loading" } | { status: "ready"; projection: CleanupProjection } | { status: "error"; message: string; details?: string }>({ status: "loading" });
  const [includeCache, setIncludeCache] = useState(cache.files > 0);
  const [acknowledgement, setAcknowledgement] = useState<AcknowledgementState | null>(null);
  const [current, setCurrent] = useState<Part>("orphans");
  const [results, setResults] = useState<Partial<Record<Part, PartResult>>>({});
  const orphanLog = useStreamingLog();
  const cacheLog = useStreamingLog();
  const logs = { orphans: orphanLog.log, cache: cacheLog.log };
  const [stale, setStale] = useState(false);
  const staleRef = useRef(false);
  const runningRef = useRef(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const mounted = useRef(true);
  const [orphanProgress, setOrphanProgress] = useState(initialProgress);
  const [cacheCount, setCacheCount] = useState<{ current: number; total: number } | null>(null);
  const [stopAsked, setStopAsked] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | undefined>(undefined);
  const [logExpanded, setLogExpanded] = useState(false);

  const handleRef = useRef<StreamingHandle | null>(null);
  const runRef = useRef(0);
  const stoppingRef = useRef(false);
  const keepRunningRef = useRef<React.ComponentRef<"button">>(null);
  const stopButtonRef = useRef<React.ComponentRef<"button">>(null);
  const closeButtonRef = useRef<React.ComponentRef<"button">>(null);
  const focusAfterRef = useRef<"keep" | "stop" | null>(null);

  const running = phase === "running";

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onSystemChanged(() => {
      if (runningRef.current) return;
      staleRef.current = true;
      setStale(true);
    });
    return () => {
      mounted.current = false;
      stoppingRef.current = true;
      handleRef.current?.setReopen?.(undefined);
      handleRef.current?.cancel();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (orphans.length === 0) return;
    staleRef.current = false;
    let dropped = false;
    const controller = new AbortController();
    previewRemoveOrphans(orphans, controller.signal).then(
      (preview) => {
        if (dropped) return;
        setOrphanPreview({ status: "ready", preview });
        if (!preview.success) setIncludeOrphans(false);
        announce(preview.success ? "Preview ready" : "These orphan packages cannot be removed");
      },
      (ex) => {
        if (dropped) return;
        setOrphanPreview({ status: "error", message: ex instanceof Error ? ex.message : String(ex), details: ex instanceof BackendError ? ex.details : undefined });
        setIncludeOrphans(false);
        announce("Could not check what orphan removal changes");
      },
    );
    return () => { dropped = true; controller.abort(); };
  }, [orphans, announce, previewAttempt]);

  useEffect(() => {
    let dropped = false;
    const controller = new AbortController();
    staleRef.current = false;
    previewCacheCleanup(DEFAULT_KEEP_VERSIONS, { mode: "all" }, controller.signal).then(
      projection => { if (!dropped) setCachePreview({ status: "ready", projection }); },
      ex => {
        if (dropped) return;
        setCachePreview({ status: "error", message: ex instanceof Error ? ex.message : String(ex), details: ex instanceof BackendError ? ex.details : undefined });
        setIncludeCache(false);
      },
    );
    return () => { dropped = true; controller.abort(); };
  }, [previewAttempt]);

  useEffect(() => {
    const target = focusAfterRef.current;
    focusAfterRef.current = null;
    if (target === "keep") keepRunningRef.current?.focus();
    else if (target === "stop") stopButtonRef.current?.focus();
  }, [stopAsked, stopping]);

  // Each phase change unmounts the focused footer button; move focus to its replacement.
  useEffect(() => {
    if (phase === "running") stopButtonRef.current?.focus();
    else if (phase === "done") closeButtonRef.current?.focus();
  }, [phase]);

  const close = () => {
    if (runningRef.current || running) return;
    onClose();
  };
  useBackdropClose(!running, close);

  const preview = orphanPreview?.status === "ready" ? orphanPreview.preview : null;
  const orphanAvailable = !!preview?.success && preview.remove.length > 0;
  const removeCount = preview ? preview.remove.length : orphans.length;
  const cachePlan = cachePreview.status === "ready" ? cachePreview.projection : cache;
  const cacheAvailable = cachePlan.files > 0;
  const runOrphans = includeOrphans && orphanAvailable;
  const runCache = includeCache && cacheAvailable && cachePreview.status === "ready";

  const appendLog = (part: Part) => part === "orphans" ? orphanLog.appendLog : cacheLog.appendLog;

  const finish = (next: Partial<Record<Part, PartResult>>) => {
    orphanLog.flushLog();
    cacheLog.flushLog();
    runningRef.current = false;
    if (!mounted.current) return;
    handleRef.current = null;
    stoppingRef.current = false;
    setStopping(false);
    setStopAsked(false);
    setResults(next);
    setPhase("done");
    announce(outcomeTitle(next));
    onFinished?.();
  };

  const outcome = (code: string | undefined): PartStatus =>
    stoppingRef.current && code === "cancelled" ? "stopped" : "failed";

  const startCache = (prior: Partial<Record<Part, PartResult>>) => {
    const run = runRef.current;
    setStopAsked((asked) => {
      if (asked) focusAfterRef.current = "stop";
      return false;
    });
    setCurrent("cache");
    setCacheCount(null);
    setLastEventAt(undefined);
    let completeMessage: string | undefined;
    handleRef.current = cleanCache(
      {
        onEvent: (event: StreamEvent) => {
          if (!mounted.current || run !== runRef.current) return;
          setLastEventAt(Date.now());
          if (event.type === "event" && event.total) setCacheCount({ current: event.current ?? 0, total: event.total });
          if (event.type === "complete" && event.message) completeMessage = event.message;
        },
        onData: (data) => {
          if (mounted.current && run === runRef.current) appendLog("cache")(data);
        },
        onComplete: () => {
          if (!mounted.current || run !== runRef.current) return;
          finish({ ...prior, cache: { status: "success", message: completeMessage } });
        },
        onError: (err, code, details) => {
          if (!mounted.current || run !== runRef.current) return;
          finish({ ...prior, cache: { status: outcome(code), message: err, code, details } });
        },
      },
      DEFAULT_KEEP_VERSIONS,
    );
    handleRef.current.setReopen?.(() => stopButtonRef.current?.focus());
  };

  const startOrphans = () => {
    const run = runRef.current;
    const withCache = runCache;
    setCurrent("orphans");
    setOrphanProgress(initialProgress);
    setLastEventAt(undefined);
    handleRef.current = removeOrphans(
      {
        onEvent: (event) => {
          if (!mounted.current || run !== runRef.current) return;
          setLastEventAt(Date.now());
          setOrphanProgress((prev) => reduceProgress(prev, event, REMOVAL_PLAN));
        },
        onData: (data) => {
          if (mounted.current && run === runRef.current) appendLog("orphans")(data);
        },
        onComplete: () => {
          if (!mounted.current || run !== runRef.current) return;
          const done = { orphans: { status: "success" as const } };
          if (withCache && stoppingRef.current) finish({ ...done, cache: { status: "skipped", afterStopRequest: true } });
          else if (withCache) startCache(done);
          else finish(done);
        },
        onError: (err, code, details) => {
          if (!mounted.current || run !== runRef.current) return;
          finish({
            orphans: { status: outcome(code), message: err, code, details },
            ...(withCache ? { cache: { status: "skipped" as const } } : {}),
          });
        },
      },
      orphans,
      preview?.remove.map(pkg => pkg.name) ?? [],
    );
    handleRef.current.setReopen?.(() => stopButtonRef.current?.focus());
  };

  const commit = () => {
    if (runningRef.current || phase !== "confirm" || orphanPreview?.status === "loading" || (includeCache && cachePreview.status === "loading")) return;
    if ((!runOrphans && !runCache) || staleRef.current || gate?.blocked || getActiveTransaction()) return;
    if (runOrphans && acknowledgement?.complete !== true) return;
    runningRef.current = true;
    runRef.current++;
    setPhase("running");
    setLogExpanded(false);
    if (runOrphans) startOrphans();
    else startCache({});
  };

  const askStop = () => {
    focusAfterRef.current = "keep";
    setStopAsked(true);
  };

  const answerStop = (stop: boolean) => {
    focusAfterRef.current = "stop";
    setStopAsked(false);
    if (!stop || !handleRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setLastEventAt(Date.now());
    handleRef.current.cancel();
  };

  const noneChecked = !runOrphans && !runCache;
  const previewPending = orphanPreview?.status === "loading" || (includeCache && cachePreview.status === "loading");
  const disabledReason = stale ? PREVIEW_STALE_REASON : previewPending
    ? "Checking what tidy-up changes"
    : noneChecked
      ? "Check at least one part"
      : runOrphans
        ? acknowledgement?.reason
        : undefined;
  const commitLabel = tidyCommitLabel(runOrphans ? removeCount : null, runCache ? cachePlan.files : null);

  const title = phase === "confirm"
    ? "Tidy up after the upgrade"
    : phase === "running"
      ? "Tidying up"
      : outcomeTitle(results);

  const refreshPreviews = () => {
    if (runningRef.current) return;
    staleRef.current = true;
    setStale(false);
    setAcknowledgement(null);
    if (orphans.length > 0) setOrphanPreview({ status: "loading" });
    setCachePreview({ status: "loading" });
    setPreviewAttempt(value => value + 1);
  };

  const confirmBody = (
    <>
      {stale && <Alert variant="warning" isInline title={PREVIEW_STALE_REASON}>
        <Button variant="link" isInline onClick={refreshPreviews}>Refresh preview</Button>
      </Alert>}
      <Content component={ContentVariants.p}>Nothing is changed until you confirm. Uncheck a part to leave it out.</Content>
      {orphans.length > 0 && (
        <section className="pf-v6-u-mt-md" aria-label="Orphan packages">
          <Checkbox
            id={`${titleId}-orphans`}
            label={<strong>Remove {plural(removeCount, "orphan package")}</strong>}
            isChecked={runOrphans}
            isDisabled={!orphanAvailable}
            onChange={(_event, checked) => setIncludeOrphans(checked)}
            description={orphanPreview?.status === "loading" ? undefined : "Packages the upgrade left that nothing depends on."}
          />
          <div className="pf-v6-u-ml-lg">
            {orphanPreview?.status === "loading" && (
              <Content component={ContentVariants.p} className="pf-v6-u-mt-sm">
                <Spinner size="sm" aria-hidden /> Checking what will be removed…
              </Content>
            )}
            {orphanPreview?.status === "error" && (
              <Alert component="h2" variant="danger" isInline title="Could not check what orphan removal changes" className="pf-v6-u-mt-sm" actionLinks={<Button variant="link" isInline onClick={refreshPreviews}>Retry preview</Button>}>
                {orphanPreview.message}
                <ErrorDetails details={orphanPreview.details} />
              </Alert>
            )}
            {preview && (runOrphans || !preview.success) && (
              <TransactionPreview
                preview={preview}
                failureTitle="Cannot remove these orphan packages"
                onAcknowledgedChange={setAcknowledgement}
                beforeNavigate={close}
              />
            )}
          </div>
        </section>
      )}
      {cachePreview.status === "loading" && <Content component={ContentVariants.p}><Spinner size="sm" aria-hidden /> Checking cache cleanup…</Content>}
      {cachePreview.status === "error" && <Alert component="h2" variant="danger" isInline title="Could not preview cache cleanup" actionLinks={<Button variant="link" isInline onClick={refreshPreviews}>Retry preview</Button>}>
        {cachePreview.message}<ErrorDetails details={cachePreview.details} />
      </Alert>}
      {cacheAvailable && (
        <section className="pf-v6-u-mt-lg" aria-label="Package cache">
          <Checkbox
            id={`${titleId}-cache`}
            label={
              <strong>
                Delete up to {plural(cachePlan.files, "old cache file")}, keeping {plural(DEFAULT_KEEP_VERSIONS, "version")} ({formatSize(cachePlan.bytes)})
              </strong>
            }
            isChecked={includeCache && cacheAvailable}
            isDisabled={cachePreview.status === "error"}
            onChange={(_event, checked) => setIncludeCache(checked)}
            description={`The ${DEFAULT_KEEP_VERSIONS} newest versions of each cached package stay, so a downgrade from the cache remains possible.`}
          />
        </section>
      )}
    </>
  );

  const cachePercent = cacheCount ? Math.floor((cacheCount.current / cacheCount.total) * 100) : undefined;
  const orphanPercent = progressPercent(orphanProgress);
  const runningBody = (
    <>
      {runOrphans && runCache && (
        <Content component={ContentVariants.p}>
          Step {current === "orphans" ? 1 : 2} of 2: {PART_NAME[current]}
        </Content>
      )}
      {stopAsked && (
        <Alert component="h2" variant="warning" isInline id={questionId} title={STOP_COPY[current].title} className="pf-v6-u-mb-md">
          <Content component={ContentVariants.p}>{STOP_COPY[current].body}</Content>
          <Flex spaceItems={{ default: "spaceItemsSm" }}>
            <Button variant="danger" onClick={() => answerStop(true)} aria-describedby={questionId}>
              {current === "orphans" ? "Stop removing orphan packages" : "Stop cleaning the cache"}
            </Button>
            <Button variant="link" ref={keepRunningRef} onClick={() => answerStop(false)} aria-describedby={questionId}>
              Keep running
            </Button>
          </Flex>
        </Alert>
      )}
      {stopping && (
        <CancellationNotice
          lastEventAt={lastEventAt}
          phase={current === "orphans" ? orphanProgress.phase : undefined}
        />
      )}
      {current === "orphans" ? (
        orphanPercent === undefined ? (
          <Content component={ContentVariants.p}>
            <Spinner size="md" aria-hidden /> Removing orphan packages…
          </Content>
        ) : (
          <Progress
            value={orphanPercent}
            title="Removing orphan packages"
            measureLocation={ProgressMeasureLocation.outside}
            valueText={progressValueText(orphanProgress)}
          />
        )
      ) : cachePercent === undefined ? (
        <Content component={ContentVariants.p}>
          <Spinner size="md" aria-hidden /> Cleaning the cache…
        </Content>
      ) : (
        <Progress
          value={cachePercent}
          title="Deleting old cache files"
          measureLocation={ProgressMeasureLocation.outside}
          valueText={`${cacheCount!.current.toLocaleString()} of ${plural(cacheCount!.total, "file")}`}
        />
      )}
      <ExpandableLogViewer
        log={logs[current]}
        placeholder="Starting…"
        isExpanded={logExpanded}
        onToggle={setLogExpanded}
        aria-label={`${PART_NAME[current]} output`}
      />
    </>
  );

  const resultLine = (part: Part, result: PartResult): React.ReactNode => {
    if (part === "orphans") {
      switch (result.status) {
        case "success": return `Removed ${plural(removeCount, "orphan package")}.`;
        case "stopped": return "Orphan removal stopped.";
        case "failed": return "Orphan removal failed.";
        case "skipped": return null;
      }
    }
    switch (result.status) {
      case "success": return `Deleted old cache files, keeping ${plural(DEFAULT_KEEP_VERSIONS, "version")} of each package.`;
      case "stopped": return "Cache clean stopped.";
      case "failed": return "Cache clean failed.";
      case "skipped":
        if (result.afterStopRequest) return "The cache clean did not start because you stopped the tidy-up.";
        return `The cache clean did not start because orphan removal ${results.orphans?.status === "stopped" ? "was stopped" : "failed"}.`;
    }
  };

  const doneBody = (
    <>
      {(["orphans", "cache"] as const).map((part) => {
        const result = results[part];
        if (!result) return null;
        const variant = result.status === "success" ? "success" : result.status === "failed" ? "danger" : "info";
        return (
          <section key={part} className="pf-v6-u-mb-md" aria-label={PART_NAME[part]}>
            <Alert component="h2" variant={variant} isInline isPlain title={resultLine(part, result)}>
              {result.message}
              <ErrorDetails details={result.details} />
            </Alert>
            {logs[part] && (
              <>
                <Title headingLevel="h3" size="md" className="pf-v6-u-mt-sm">{PART_NAME[part]} output</Title>
                <LogViewer log={logs[part]} aria-label={`${PART_NAME[part]} output`} />
              </>
            )}
          </section>
        );
      })}
    </>
  );

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen
      onClose={running ? undefined : close}
      aria-labelledby={titleId}
    >
      <ModalHeader title={title} labelId={titleId} />
      <ModalBody>{phase === "confirm" ? confirmBody : phase === "running" ? runningBody : doneBody}</ModalBody>
      <ModalFooter>
        {phase === "confirm" && (
          <>
            <GatedButton
              gate={gate}
              disabledReason={disabledReason}
              variant={runOrphans ? "danger" : "primary"}
              onClick={commit}
            >
              {commitLabel}
            </GatedButton>
            <Button variant="link" onClick={close}>Cancel</Button>
          </>
        )}
        {phase === "running" && (
          <Button
            variant="secondary"
            ref={stopButtonRef}
            onClick={askStop}
            isAriaDisabled={stopping || stopAsked}
            isLoading={stopping}
          >
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
        {phase === "done" && <Button variant="primary" ref={closeButtonRef} onClick={close}>Close</Button>}
      </ModalFooter>
    </Modal>
  );
};

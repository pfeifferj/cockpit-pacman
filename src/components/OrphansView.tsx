import React, { useState, useEffect, useCallback, useRef, useMemo, useId } from "react";
import { usePreviewStaleness, PreviewStaleAlert, PREVIEW_STALE_REASON } from "./PreflightConfirmModal";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { useSortableTable } from "../hooks/useSortableTable";
import {
  Alert,
  AlertActionLink,
  Button,
  Spinner,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Content,
  ContentVariants,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Flex,
  FlexItem,
  Label,
  SearchInput,
  Checkbox,
  ExpandableSection,
  List,
  ListItem,
  Progress,
  ProgressMeasureLocation,
} from "@patternfly/react-core";
import { ExpandableLogViewer, LogViewer } from "./LogViewer";
import { TrashIcon, CheckCircleIcon } from "@patternfly/react-icons";
import { StatBox } from "./StatBox";
import { ErrorDetails } from "./ErrorDetails";
import { ErrorAlert } from "./ErrorAlert";
import { CancellationNotice } from "./CancellationNotice";
import { HelpPopover } from "./HelpPopover";
import { TransactionPreview, previewSummary, type AcknowledgementState } from "./TransactionPreview";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  BackendError,
  type ErrorCode,
  OrphanPackage,
  OrphanResponse,
  listOrphans,
  previewRemoveOrphans,
  removeOrphans,
  formatSize,
  type TransactionPreview as PreviewData,
} from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { PackageRowActions, fromRowActions } from "./PackageRowActions";
import { RowSelectCell } from "./RowSelectCell";
import { TimeAgo } from "./TimeAgo";
import { progressPercent, progressValueText, type ProgressPlan } from "../progress";
import { RunSession, useHeldRun, useRunInBackground, useRunSnapshot, type RunOutcome, type RunSnapshot } from "./TransactionHost";
import { useNavigation } from "../contexts/NavigationContext";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useMutationGate } from "../hooks/useMutationGate";
import { GatedButton } from "./GatedButton";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";

const REMOVAL_PLAN: ProgressPlan = { downloadBytes: 0, packages: 0 };

const REMOVED_NAMES_SHOWN = 10;

// Spinner text is held back this long so a fast preview does not flash it.
const PREVIEW_TEXT_DELAY_MS = 1000;

const orphanCount = (n: number) => `${n} ${n === 1 ? "orphan" : "orphans"}`;

const RUN_OWNER = "orphans";

const orphanPackages = (n: number) => `${n} orphan ${n === 1 ? "package" : "packages"}`;

class OrphanRemoval extends RunSession {
  constructor(readonly names: string[], readonly freed: number) {
    super(`Removing ${orphanPackages(names.length)}`);
  }

  outcomeTitle(status: RunOutcome): string {
    if (status === "success") return `Removed ${orphanPackages(this.names.length)}`;
    return status === "stopped"
      ? `Stopped removing ${orphanPackages(this.names.length)}`
      : `Failed to remove ${orphanPackages(this.names.length)}`;
  }
}

interface OrphanError {
  message: string;
  code?: ErrorCode;
  details?: string;
}

type ViewState = "loading" | "ready";

const RemovalProgress: React.FC<{ session: RunSession; snapshot: RunSnapshot; heading?: string }> = ({
  session,
  snapshot,
  heading,
}) => {
  const [asking, setAsking] = useState(false);
  const [logExpanded, setLogExpanded] = useState(true);
  const [lastEventAt, setLastEventAt] = useState<number | undefined>(undefined);
  const questionId = useId();
  const cancelRef = useRef<HTMLElement>(null);
  const keepRef = useRef<HTMLElement>(null);
  const focusRef = useRef<"keep" | "cancel" | null>(null);
  const cancelling = snapshot.status === "cancelling";

  useEffect(() => session.subscribe(() => setLastEventAt(Date.now())), [session]);

  useEffect(() => {
    const target = focusRef.current;
    focusRef.current = null;
    if (target === "keep") keepRef.current?.focus();
    else if (target === "cancel") cancelRef.current?.focus();
  }, [asking]);

  const answer = (stop: boolean) => {
    focusRef.current = "cancel";
    setAsking(false);
    if (stop) session.stop();
  };

  return (
    <>
      <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }} className="pf-v6-u-mb-md">
        <FlexItem>
          {heading && <strong>{heading}</strong>}
        </FlexItem>
        {!asking && (
          <FlexItem>
            <Button
              ref={cancelRef}
              variant="secondary"
              onClick={() => {
                focusRef.current = "keep";
                setAsking(true);
              }}
              isAriaDisabled={cancelling}
              isLoading={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          </FlexItem>
        )}
      </Flex>

      {asking && (
        <Alert component="h2" variant="warning" isInline id={questionId} title="Stop removing orphan packages?" className="pf-v6-u-mb-md">
          <Content component={ContentVariants.p}>
            The transaction is stopped before packages are removed. Once the commit step starts it cannot be stopped.
          </Content>
          <Flex spaceItems={{ default: "spaceItemsSm" }}>
            <Button variant="danger" onClick={() => answer(true)} aria-describedby={questionId}>
              Stop removing orphan packages
            </Button>
            <Button variant="link" ref={keepRef} onClick={() => answer(false)} aria-describedby={questionId}>
              Keep running
            </Button>
          </Flex>
        </Alert>
      )}

      {cancelling && (
        <CancellationNotice

          lastEventAt={lastEventAt}
          phase={snapshot.progress.phase}
        />
      )}

      <RemovalProgressBar snapshot={snapshot} />

      <ExpandableLogViewer
        log={snapshot.log}
        placeholder="Starting…"
        isExpanded={logExpanded}
        onToggle={setLogExpanded}
      />
    </>
  );
};

const RemovalProgressBar: React.FC<{ snapshot: RunSnapshot }> = ({ snapshot }) => {
  const { progress } = snapshot;
  const value = progressPercent(progress);
  if (value === undefined) {
    return (
      <Content component={ContentVariants.p} className="pf-v6-u-mb-md">
        <Spinner size="md" aria-hidden /> {progress.phaseLabel}
        {progress.stepLabel && ` (${progress.stepLabel})`}
      </Content>
    );
  }
  return (
    <Progress
      className="pf-v6-u-mb-md"
      value={value}
      title={progress.phaseLabel}
      helperText={progress.stepLabel}
      measureLocation={ProgressMeasureLocation.outside}
      valueText={progressValueText(progress)}
    />
  );
};

const RemovedNames: React.FC<{ names: string[] }> = ({ names }) => {
  const [expanded, setExpanded] = useState(false);
  const list = (
    <List isPlain aria-label="Removed packages">
      {names.map((name) => <ListItem key={name}>{name}</ListItem>)}
    </List>
  );
  if (names.length <= REMOVED_NAMES_SHOWN) return list;
  return (
    <ExpandableSection
      toggleText={expanded ? "Hide removed packages" : `Show ${names.length} removed packages`}
      isExpanded={expanded}
      onToggle={(_event, next) => setExpanded(next)}
    >
      {list}
    </ExpandableSection>
  );
};

const RemovalResult: React.FC<{ snapshot: RunSnapshot; removal: OrphanRemoval; onBack?: () => void }> = ({ snapshot, removal, onBack }) => {
  const [logExpanded, setLogExpanded] = useState(true);

  if (snapshot.status === "success") {
    const count = removal.names.length;
    return (
      <>
        <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="Orphan packages removed">
          <EmptyStateBody>
            {snapshot.finishedAfterCancel && "The removal finished before it could be stopped. "}
            {`Removed ${count} ${count === 1 ? "package" : "packages"}`}
            {removal.freed > 0 ? `, freeing ${formatSize(removal.freed)}.` : "."}
            <RemovedNames names={removal.names} />
          </EmptyStateBody>
          {onBack && (
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={onBack}>
                  Back to orphan list
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          )}
        </EmptyState>
        {snapshot.log && <LogViewer log={snapshot.log} className="pf-v6-u-mt-md" />}
      </>
    );
  }

  const stopped = snapshot.errorCode === "cancelled";
  return (
    <>
      <Alert component="h2"
        variant={stopped ? "info" : "danger"}
        isInline
        title={stopped ? "Orphan removal stopped" : "Orphan removal failed"}
        actionLinks={onBack && <AlertActionLink onClick={onBack}>Back to orphan list</AlertActionLink>}
      >
        {stopped ? "The transaction was stopped before packages were removed. Your selection is kept." : (
          <>
            {snapshot.error}
            <ErrorDetails details={snapshot.errorDetails} />
          </>
        )}
      </Alert>
      {snapshot.log && (
        <ExpandableLogViewer
          log={snapshot.log}
          isExpanded={logExpanded}
          onToggle={setLogExpanded}
          className="pf-v6-u-mt-md"
        />
      )}
    </>
  );
};

const RemovalDialog: React.FC<{ session: OrphanRemoval; onClose: () => void }> = ({ session, onClose }) => {
  const snapshot = useRunSnapshot(session);
  const titleId = useId();
  if (!snapshot) return null;
  const { status } = snapshot;
  const running = status === "running" || status === "cancelling";
  return (
    <Modal variant={ModalVariant.medium} isOpen onClose={onClose} aria-labelledby={titleId}>
      <ModalHeader title={running ? session.title : session.outcomeTitle(status)} labelId={titleId} />
      <ModalBody>
        {running ? (
          <RemovalProgress session={session} snapshot={snapshot} />
        ) : (
          <RemovalResult snapshot={snapshot} removal={session} />
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant={running ? "secondary" : "primary"} onClick={onClose}>
          {running ? "Run in background" : "Close"}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

interface RemovalConfirm {
  targets: string[];
  preview: PreviewData | null;
  error: { message: string; code?: ErrorCode; details?: string } | null;
}

interface OrphansViewProps {
  onRowClick: (pkgName: string) => void;
  onOrphansLoaded?: (count: number) => void;
  refreshTrigger?: number;
  onViewDependencies?: (pkgName: string) => void;
}

export const OrphansView: React.FC<OrphansViewProps> = ({ onRowClick, onOrphansLoaded, refreshTrigger, onViewDependencies }) => {
  const [orphanData, setOrphanData] = useState<OrphanResponse | null>(null);
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [error, setError] = useState<OrphanError | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [confirm, setConfirm] = useState<RemovalConfirm | null>(null);
  const staleness = usePreviewStaleness(confirm !== null);
  const { reset: resetStaleness } = staleness;
  const [acknowledgement, setAcknowledgement] = useState<AcknowledgementState | null>(null);
  const [showPreviewText, setShowPreviewText] = useState(false);
  const previewRequestRef = useRef(0);
  const closeConfirm = useCallback(() => {
    previewRequestRef.current++;
    setConfirm(null);
  }, []);
  useBackdropClose(confirm !== null, closeConfirm);
  const confirmTitleId = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Names from the last load; a name absent from it arrives selected.
  const knownNamesRef = useRef<Set<string>>(new Set());
  const announce = useAnnounce();
  const held = useHeldRun(RUN_OWNER);
  const [removal, setRemoval] = useState<OrphanRemoval | null>(() =>
    held.run?.session instanceof OrphanRemoval ? held.run.session : null,
  );
  const removalSnapshot = useRunSnapshot(removal);
  const runInBackground = useRunInBackground();
  const { onViewOrphans } = useNavigation();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const canAdmin = useAdminPermission();
  const removeGate = useMutationGate("remove orphan packages", { permission: canAdmin, owner: "orphans" });

  const { activeSortIndex, activeSortDirection, getSortParams } = useSortableTable({
    sortableColumns: [1, 3, 4],
    defaultDirection: "asc",
  });

  const removalRef = useRef(removal);
  const unmountRef = useRef({ runInBackground, onViewOrphans, release: held.release });
  useEffect(() => {
    removalRef.current = removal;
    unmountRef.current = { runInBackground, onViewOrphans, release: held.release };
  });

  // A removal survives the view: a filter toggle or browser Back hands it to
  // the page-level host, and mounting again takes it back.
  useEffect(() => {
    const taken = removalRef.current;
    if (taken) unmountRef.current.release(taken);
    return () => {
      const session = removalRef.current;
      if (!session?.running) return;
      const { runInBackground: adopt, onViewOrphans: navigate } = unmountRef.current;
      if (!adopt) {
        session.abandon();
        return;
      }
      adopt({
        session,
        owner: RUN_OWNER,
        navigate,
        render: (close) => <RemovalDialog session={session} onClose={close} />,
      });
    };
  }, []);

  const loadOrphans = useCallback(async (background = false) => {
    const request = ++requestRef.current;
    if (!background) setViewState("loading");
    try {
      const response = await listOrphans();
      if (request !== requestRef.current) return;
      setError(null);
      const names = response.orphans.map(o => o.name);
      const known = knownNamesRef.current;
      setSelected(prev => new Set(names.filter(n => prev.has(n) || !known.has(n))));
      knownNamesRef.current = new Set(names);
      setOrphanData(response);
      onOrphansLoaded?.(response.orphans.length);
      setViewState("ready");
    } catch (ex) {
      if (request !== requestRef.current) return;
      setError({
        message: ex instanceof Error ? ex.message : String(ex),
        code: ex instanceof BackendError ? ex.code : undefined,
        details: ex instanceof BackendError ? ex.details : undefined,
      });
      setViewState("ready");
    }
  }, [onOrphansLoaded]);

  useEffect(() => {
    Promise.resolve().then(() => loadOrphans());
  }, [loadOrphans]);

  const viewStateRef = useRef(viewState);
  useEffect(() => {
    viewStateRef.current = viewState;
  });

  // A running removal and its outcome stay put; their own actions reload the list.
  const previousRefresh = useRef(refreshTrigger);
  useEffect(() => {
    if (previousRefresh.current === refreshTrigger) return;
    previousRefresh.current = refreshTrigger;
    if (!removalRef.current) void loadOrphans(true);
  }, [refreshTrigger, loadOrphans]);

  useRefreshOnActivate(() => {
    if (viewStateRef.current !== "ready" || removalRef.current) return;
    loadOrphans(true);
  });

  const retryLoad = useCallback(() => loadOrphans(), [loadOrphans]);
  const reloadAfterReasonChange = useCallback(() => {
    if (viewStateRef.current !== "ready" || removalRef.current) return;
    loadOrphans(true);
  }, [loadOrphans]);
  const runPreview = useCallback((targets: string[]) => {
    resetStaleness();
    const request = ++previewRequestRef.current;
    setConfirm({ targets, preview: null, error: null });
    setAcknowledgement(null);
    previewRemoveOrphans(targets).then(
      (preview) => {
        if (request !== previewRequestRef.current) return;
        setConfirm({ targets, preview, error: null });
        announce(`Preview ready: ${preview.success ? previewSummary(preview) : "Cannot remove orphans"}`);
      },
      (ex) => {
        if (request !== previewRequestRef.current) return;
        setConfirm({
          targets,
          preview: null,
          error: {
            message: ex instanceof Error ? ex.message : String(ex),
            code: ex instanceof BackendError ? ex.code : undefined,
            details: ex instanceof BackendError ? ex.details : undefined,
          },
        });
        announce("Could not check what will change");
      },
    );
  }, [announce, resetStaleness]);

  const previewing = confirm !== null && confirm.preview === null && confirm.error === null;
  useEffect(() => {
    if (!previewing) return;
    const timer = setTimeout(() => setShowPreviewText(true), PREVIEW_TEXT_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShowPreviewText(false);
    };
  }, [previewing]);

  const startRemoval = () => {
    if (removeGate.blocked || staleness.staleAt || !confirm?.preview || acknowledgement?.complete === false) return;
    requestRef.current++;
    const targets = confirm.targets;
    const removed = confirm.preview.remove;
    const next = new OrphanRemoval(
      removed.map((item) => item.name),
      removed.reduce((sum, item) => sum + item.installed_size, 0),
    );
    previewRequestRef.current++;
    setConfirm(null);
    setRemoval(next);
    next.start((callbacks) => removeOrphans(callbacks, targets, removed.map(pkg => pkg.name)), REMOVAL_PLAN);
  };

  const handleClearFilter = () => {
    setSearchValue("");
    searchInputRef.current?.focus();
  };

  const backToList = () => {
    if (removalSnapshot?.status === "success") knownNamesRef.current = new Set();
    setRemoval(null);
    loadOrphans();
  };

  const filteredAndSorted = useMemo(() => {
    if (!orphanData?.orphans) return [];
    const searchLower = searchValue.toLowerCase();
    const filtered = searchValue
      ? orphanData.orphans.filter(pkg =>
          pkg.name.toLowerCase().includes(searchLower) ||
          (pkg.description?.toLowerCase().includes(searchLower) ?? false)
        )
      : orphanData.orphans;
    return [...filtered].sort((a, b) => {
      if (activeSortIndex === null) return 0;
      let comparison = 0;
      switch (activeSortIndex) {
        case 1:
          comparison = a.name.localeCompare(b.name);
          break;
        case 3:
          comparison = a.installed_size - b.installed_size;
          break;
        case 4:
          comparison = (a.install_date ?? 0) - (b.install_date ?? 0);
          break;
        default:
          return 0;
      }
      return activeSortDirection === "asc" ? comparison : -comparison;
    });
  }, [orphanData, activeSortIndex, activeSortDirection, searchValue]);

  const filteredSelectedCount = filteredAndSorted.filter(p => selected.has(p.name)).length;
  const allFilteredSelected = filteredAndSorted.length > 0 && filteredSelectedCount === filteredAndSorted.length;
  const hiddenSelectedCount = selected.size - filteredSelectedCount;

  const toggleSelected = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const setFilteredSelected = (select: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const p of filteredAndSorted) {
        if (select) next.add(p.name);
        else next.delete(p.name);
      }
      return next;
    });
  };

  const selectedTargets = () => (orphanData?.orphans ?? []).map(o => o.name).filter(n => selected.has(n));

  if (removal && removalSnapshot) {
    return removal.running ? (
      <RemovalProgress session={removal} snapshot={removalSnapshot} heading="Removing orphan packages" />
    ) : (
      <RemovalResult snapshot={removalSnapshot} removal={removal} onBack={backToList} />
    );
  }

  if (viewState === "loading") {
    return (
      <div className="pf-v6-u-p-xl pf-v6-u-text-align-center">
        <Spinner /> Checking for orphan packages…
      </div>
    );
  }

  if (error) {
    return (
      <ErrorAlert headingLevel="h2"
        error={error.message}
        code={error.code}
        details={error.details}
        title="Error loading orphans"
        isInline
        onRetry={retryLoad}
        showRetry
      />
    );
  }

  const removeLabel = `Remove ${orphanCount(selected.size)}${hiddenSelectedCount > 0 ? ` (${hiddenSelectedCount} hidden by filter)` : ""}`;

  if (!orphanData?.orphans.length) {
    return (
      <EmptyState headingLevel="h2" icon={CheckCircleIcon} titleText="No orphan packages">
        <EmptyStateBody>
          Your system has no orphan packages. Orphans are packages that were installed as dependencies but are no longer required by any other package.
        </EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="secondary" onClick={retryLoad}>
              Refresh
            </Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  }

  return (
    <>
      <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }} className="pf-v6-u-mb-md">
        <FlexItem>
          <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
            <FlexItem>
              <StatBox
                label="Space to Free"
                value={formatSize(orphanData.total_size)}
                color="success"
              />
            </FlexItem>
            <FlexItem>
              <HelpPopover
                label="orphan packages"
                header="Orphan packages"
                body="Packages installed automatically as dependencies but no longer required by anything else. Safe to remove, can be reinstalled from repos if needed."
              />
            </FlexItem>
          </Flex>
        </FlexItem>
        <Flex spaceItems={{ default: "spaceItemsMd" }} alignItems={{ default: "alignItemsCenter" }}>
          <FlexItem>
            <SearchInput
              ref={searchInputRef}
              placeholder="Filter orphans by name or description"
              aria-label="Filter orphans"
              value={searchValue}
              onChange={(_event, value) => setSearchValue(value)}
              onClear={() => setSearchValue("")}
            />
          </FlexItem>
          <FlexItem>
            <GatedButton
              gate={removeGate}
              disabledReason={selected.size === 0 && "Select at least one orphan"}
              variant="danger"
              icon={<TrashIcon />}
              onClick={() => runPreview(selectedTargets())}
            >
              {removeLabel}
            </GatedButton>
          </FlexItem>
        </Flex>
      </Flex>

      <Table aria-label="Orphan packages" variant="compact">
        <Thead>
          <Tr>
            <Th screenReaderText="Select">
              <Checkbox
                id="select-all-orphans"
                isChecked={allFilteredSelected ? true : filteredSelectedCount > 0 ? null : false}
                onChange={() => setFilteredSelected(!allFilteredSelected)}
                aria-label={searchValue ? "Select all matching orphans" : "Select all orphans"}
              />
            </Th>
            <Th sort={getSortParams(1)}>Package</Th>
            <Th>Version</Th>
            <Th sort={getSortParams(3)}>Size</Th>
            <Th sort={getSortParams(4)}>Installed</Th>
            <Th>Repository</Th>
            <Th screenReaderText="Actions" />
          </Tr>
        </Thead>
        <Tbody>
          {filteredAndSorted.map((pkg: OrphanPackage) => (
            <Tr key={pkg.name} isClickable onRowClick={(event) => !fromRowActions(event) && onRowClick(pkg.name)} isRowSelected={selected.has(pkg.name)}>
              <RowSelectCell
                label={`Select ${pkg.name}`}
                isSelected={selected.has(pkg.name)}
                onSelect={() => toggleSelected(pkg.name)}
              />
              <Td dataLabel="Package">
                <Button variant="link" isInline className="pf-v6-u-p-0">
                  {pkg.name}
                </Button>
              </Td>
              <Td dataLabel="Version">{pkg.version}</Td>
              <Td dataLabel="Size">{formatSize(pkg.installed_size)}</Td>
              <Td dataLabel="Installed"><TimeAgo timestamp={pkg.install_date} /></Td>
              <Td dataLabel="Repository">
                <Label isCompact color="grey">
                  {pkg.repository || "user"}
                </Label>
              </Td>
              <Td isActionCell>
                <PackageRowActions
                  name={pkg.name}
                  installedVersion={pkg.version}
                  repository={pkg.repository}
                  reason="dependency"
                  onViewDetails={() => onRowClick(pkg.name)}
                  onViewDependencies={onViewDependencies}
                  onReasonChange={reloadAfterReasonChange}
                  onRemove={() => runPreview([pkg.name])}
                  removeGate={removeGate}
                />
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      {filteredAndSorted.length === 0 && (
        <EmptyState headingLevel="h3" titleText="No orphans match your filter">
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={handleClearFilter}>
                Clear filter
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      )}

      <Modal
        variant={ModalVariant.medium}
        isOpen={confirm !== null}
        onClose={closeConfirm}
        aria-labelledby={confirmTitleId}
      >
        <ModalHeader title="Remove orphan packages?" labelId={confirmTitleId} />
        <ModalBody>
          <PreviewStaleAlert staleAt={staleness.staleAt} />
          {confirm && (previewing ? (
            <Content component={ContentVariants.p}>
              <Spinner size="md" aria-label="Checking what will change" />
              {showPreviewText && " Checking what will change…"}
            </Content>
          ) : confirm.error ? (
            <ErrorAlert headingLevel="h2"
              error={confirm.error.message}
              code={confirm.error.code}
              details={confirm.error.details}
              title="Could not check what will change"
              beforeNavigate={closeConfirm}
              onRetry={() => runPreview(confirm.targets)}
            />
          ) : confirm.preview && (
            <TransactionPreview
              preview={confirm.preview}
              failureTitle="Cannot remove orphans"
              onAcknowledgedChange={setAcknowledgement}
              beforeNavigate={closeConfirm}
            />
          ))}
        </ModalBody>
        <ModalFooter>
          {confirm?.preview?.success ? (
            <GatedButton
              key="confirm"
              variant="danger"
              onClick={startRemoval}
              disabledReason={removeGate.reason ?? (staleness.staleAt ? PREVIEW_STALE_REASON : acknowledgement?.reason)}
            >
              {`Remove ${orphanCount(confirm.preview.remove.length)}`}
            </GatedButton>
          ) : confirm && !previewing && (
            <Button key="retry" variant="primary" onClick={() => runPreview(confirm.targets)}>
              Check again
            </Button>
          )}
          {staleness.staleAt && confirm && <Button variant="secondary" onClick={() => runPreview(confirm.targets)}>Refresh preview</Button>}
          <Button key="cancel" variant="link" onClick={closeConfirm}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
};

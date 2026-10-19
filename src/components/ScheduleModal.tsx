import React, { useState, useEffect, useCallback, useRef, useId } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose";
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Alert,
  Spinner,
  Switch,
  FormGroup,
  FormSelect,
  FormSelectOption,
  NumberInput,
  HelperText,
  HelperTextItem,
  TextInput,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Label,
  Flex,
  FlexItem,
  ExpandableSection,
  EmptyState,
  EmptyStateBody,
  Content,
  ContentVariants,
} from "@patternfly/react-core";
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  OutlinedClockIcon,
  ClockIcon,
} from "@patternfly/react-icons";
import { Table, Caption, Thead, Tr, Th, Tbody, Td, ExpandableRowContent } from "@patternfly/react-table";
import {
  ScheduleConfig,
  ScheduleMode,
  ScheduledRunEntry,
  ScheduledRunStatus,
  BackendError,
  type ErrorCode,
  getScheduleConfig,
  setScheduleConfig,
  getScheduledRuns,
} from "../api";
import type { ScheduledCurrentRun } from "../bindings";
import { TimeAgo } from "./TimeAgo";
import { ErrorAlert } from "./ErrorAlert";
import { plural, sanitizeErrorMessage } from "../utils";

/**
 * A run's wall-clock time. `null` means the record predates the field, or the
 * run was killed before it could be stamped.
 */
export function formatDuration(secs: number | null): string {
  if (secs === null) return "-";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${secs % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (message: string) => void;
  initialHistoryExpanded?: boolean;
  focusRun?: string;
}

const RUN_STATUS = {
  ok: { Icon: CheckCircleIcon, token: "success", label: "Success" },
  skipped: { Icon: ExclamationTriangleIcon, token: "warning", label: "Skipped" },
  failed: { Icon: ExclamationCircleIcon, token: "danger", label: "Failed" },
  unrecorded: { Icon: ExclamationTriangleIcon, token: "warning", label: "Record unavailable" },
} as const;

/**
 * Keyed off `status`, never `success`: LogEntry sets success = status !=
 * "failed", so a skipped run is truthy and rendered as a green Success.
 * `success` is only the fallback for records written before status existed.
 */
function runStatus(run: ScheduledRunEntry): ScheduledRunStatus {
  if (run.status === "ok" || run.status === "skipped" || run.status === "failed" || run.status === "unrecorded") return run.status;
  return run.success ? "ok" : "failed";
}

export function runPackages(run: ScheduledRunEntry): string {
  if (run.packages_upgraded === null || run.packages_checked === null) return "Unknown";
  return run.packages_upgraded > 0
    ? `${run.packages_upgraded.toLocaleString()} upgraded`
    : `${run.packages_checked.toLocaleString()} checked`;
}

function runReason(run: ScheduledRunEntry): string {
  return run.error || run.details.join(", ");
}

export const RunStatus: React.FC<{ run: ScheduledRunEntry }> = ({ run }) => {
  const { Icon, token, label } = RUN_STATUS[runStatus(run)];
  return (
    <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
      <FlexItem>
        <Icon color={`var(--pf-t--global--icon--color--status--${token}--default)`} />
      </FlexItem>
      <FlexItem>{label}</FlexItem>
      {run.removed_stale_lock && (
        <FlexItem>
          <Label color="orange" isCompact>
            Recovered
          </Label>
        </FlexItem>
      )}
    </Flex>
  );
};

export const RunDetails: React.FC<{ run: ScheduledRunEntry }> = ({ run }) => {
  const reason = runReason(run);
  return (
    <Content>
      {reason && (
        <Content component={ContentVariants.p}>
          {runStatus(run) === "failed" ? "Error: " : "Details: "}
          {reason}
        </Content>
      )}
      {run.removed_stale_lock && (
        <Content component={ContentVariants.p}>
          Cleared a leftover pacman lock that no process was holding.
        </Content>
      )}
    </Content>
  );
};

const SCHEDULE_PRESETS = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

const MODE_OPTIONS: { value: ScheduleMode; label: string }[] = [
  { value: "upgrade", label: "Auto-upgrade" },
  { value: "check", label: "Check only" },
];

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  isOpen,
  onClose,
  onSaved,
  initialHistoryExpanded = false,
  focusRun,
}) => {
  const openHistory = initialHistoryExpanded || focusRun !== undefined;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<ScheduleConfig | null>(null);
  const [error, setError] = useState<{ title: string; message: string; code?: ErrorCode; details?: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<ScheduleMode>("upgrade");
  const [schedulePreset, setSchedulePreset] = useState("weekly");
  const [customSchedule, setCustomSchedule] = useState("");
  const [maxPackages, setMaxPackages] = useState(0);

  const [runs, setRuns] = useState<ScheduledRunEntry[]>([]);
  const [currentRun, setCurrentRun] = useState<ScheduledCurrentRun | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  const historyFocusPending = useRef(false);
  const historyCaptionRef = useRef<HTMLElement>(null);
  const historyRegionRef = useRef<HTMLDivElement>(null);
  const keepEditingRef = useRef<HTMLElement>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getScheduleConfig();
      setConfig(response);
      setEnabled(response.enabled);
      setMode(response.mode as ScheduleMode);
      setMaxPackages(response.max_packages);

      const isPreset = SCHEDULE_PRESETS.some(
        (p) => p.value === response.schedule && p.value !== "custom"
      );
      if (isPreset) {
        setSchedulePreset(response.schedule);
        setCustomSchedule("");
      } else {
        setSchedulePreset("custom");
        setCustomSchedule(response.schedule);
      }
    } catch (ex) {
      setError({ title: "Could not load the schedule", message: ex instanceof Error ? ex.message : String(ex), code: ex instanceof BackendError ? ex.code : undefined, details: ex instanceof BackendError ? ex.details : undefined });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const response = await getScheduledRuns({ limit: 10 });
      setRuns(response.runs);
      setCurrentRun(response.current_run ?? null);
      setRunsError(response.warning ?? null);
    } catch (ex) {
      setRuns([]);
      setCurrentRun(null);
      setRunsError(sanitizeErrorMessage(ex instanceof Error ? ex.message : String(ex)));
    } finally {
      setRunsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    historyFocusPending.current = openHistory;
    Promise.resolve().then(() => {
      setConfirmDiscard(false);
      setRunsLoaded(false);
      setExpandedRuns(new Set());
      if (openHistory) setHistoryExpanded(true);
      void loadConfig();
      void loadRuns();
    });
    const poll = window.setInterval(() => void loadRuns(), 5000);
    return () => window.clearInterval(poll);
  }, [isOpen, openHistory, loadConfig, loadRuns]);

  // Runs after the modal's own initial focus, once the history has rendered.
  useEffect(() => {
    if (!historyFocusPending.current || loading || !runsLoaded || !historyExpanded) return;
    historyFocusPending.current = false;
    const index = focusRun === undefined ? -1 : runs.findIndex((run) => run.timestamp === focusRun);
    const row = index >= 0 ? historyRegionRef.current?.querySelector<HTMLElement>(`#simple-node${index}`) : null;
    (row ?? historyCaptionRef.current ?? historyRegionRef.current)?.focus();
  }, [loading, runsLoaded, historyExpanded, runs, focusRun]);

  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
  }, [confirmDiscard]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const schedule = schedulePreset === "custom" ? customSchedule : schedulePreset;
      const response = await setScheduleConfig({
        enabled,
        mode,
        schedule,
        max_packages: maxPackages,
      });
      onSaved?.(response.message);
      onClose();
    } catch (ex) {
      setError({ title: "Could not save the schedule", message: ex instanceof Error ? ex.message : String(ex), code: ex instanceof BackendError ? ex.code : undefined, details: ex instanceof BackendError ? ex.details : undefined });
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = () => {
    if (!config) return false;
    const currentSchedule = schedulePreset === "custom" ? customSchedule : schedulePreset;
    return (
      enabled !== config.enabled ||
      mode !== config.mode ||
      currentSchedule !== config.schedule ||
      maxPackages !== config.max_packages
    );
  };

  const requestClose = () => {
    if (saving) return;
    if (hasChanges()) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };
  useBackdropClose(isOpen, requestClose);
  const titleId = useId();

  const discardChanges = () => {
    setConfirmDiscard(false);
    onClose();
  };

  const toggleRun = (index: number) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen={isOpen}
      onClose={requestClose}
      aria-labelledby={titleId}
    >
      <ModalHeader title="Scheduled upgrades" labelId={titleId} />
      <ModalBody>
        {loading ? (
          <EmptyState headingLevel="h2" icon={Spinner} titleText="Loading schedule configuration" />
        ) : (
          <>
            {error && (
              <ErrorAlert
                headingLevel="h2"
                title={error.title}
                error={sanitizeErrorMessage(error.message)}
                code={error.code}
                details={error.details}
                isInline
                className="pf-v6-u-mb-md"
              />
            )}

            <FormGroup label="Enable scheduled upgrades" fieldId="schedule-enabled">
              <Switch
                id="schedule-enabled"
                isChecked={enabled}
                onChange={(_event, checked) => setEnabled(checked)}
                label={enabled ? "Enabled" : "Disabled"}
              />
              <HelperText>
                <HelperTextItem>
                  When enabled, the system will automatically check for and apply updates according to the schedule.
                </HelperTextItem>
              </HelperText>
            </FormGroup>

            <FormGroup label="Mode" fieldId="schedule-mode" className="pf-v6-u-mt-md">
              <FormSelect
                id="schedule-mode"
                value={mode}
                onChange={(_event, value) => setMode(value as ScheduleMode)}
                isDisabled={!enabled}
              >
                {MODE_OPTIONS.map((option) => (
                  <FormSelectOption
                    key={option.value}
                    value={option.value}
                    label={option.label}
                  />
                ))}
              </FormSelect>
              <HelperText>
                <HelperTextItem>
                  {mode === "upgrade"
                    ? "Safe updates will be applied automatically. Updates requiring manual intervention will be skipped."
                    : "Only logs available updates to the journal without applying them."}
                </HelperTextItem>
              </HelperText>
            </FormGroup>

            <FormGroup label="Schedule" fieldId="schedule-preset" className="pf-v6-u-mt-md">
              <FormSelect
                id="schedule-preset"
                value={schedulePreset}
                onChange={(_event, value) => setSchedulePreset(value)}
                isDisabled={!enabled}
              >
                {SCHEDULE_PRESETS.map((preset) => (
                  <FormSelectOption key={preset.value} value={preset.value} label={preset.label} />
                ))}
              </FormSelect>
            </FormGroup>

            {schedulePreset === "custom" && (
              <FormGroup
                label="Custom schedule (systemd OnCalendar format)"
                fieldId="schedule-custom"
                className="pf-v6-u-mt-md"
              >
                <TextInput
                  id="schedule-custom"
                  value={customSchedule}
                  onChange={(_event, value) => setCustomSchedule(value)}
                  isDisabled={!enabled}
                  placeholder="*-*-* 04:00:00"
                />
                <HelperText>
                  <HelperTextItem>
                    {'Examples: "*-*-* 04:00:00" (daily at 4am), "Mon *-*-* 03:00:00" (weekly on Monday at 3am)'}
                  </HelperTextItem>
                </HelperText>
              </FormGroup>
            )}

            {mode === "upgrade" && (
              <FormGroup
                label="Maximum packages per upgrade"
                fieldId="schedule-max-packages"
                className="pf-v6-u-mt-md"
              >
                <NumberInput
                  id="schedule-max-packages"
                  value={maxPackages}
                  onMinus={() => setMaxPackages(Math.max(0, maxPackages - 1))}
                  onPlus={() => setMaxPackages(maxPackages + 1)}
                  onChange={(event) => {
                    const value = parseInt((event.target as HTMLInputElement).value, 10);
                    if (!isNaN(value) && value >= 0) setMaxPackages(value);
                  }}
                  min={0}
                  isDisabled={!enabled}
                />
                <HelperText>
                  <HelperTextItem>
                    {maxPackages === 0
                      ? "No limit - all available updates will be applied."
                      : `Upgrades with more than ${plural(maxPackages, "package")} will be skipped as a safety measure.`}
                  </HelperTextItem>
                </HelperText>
              </FormGroup>
            )}

            {config?.timer_error && (
              <Alert isInline variant="warning" title="Timer status unavailable">
                {config.timer_error}
              </Alert>
            )}
            {config && config.timer_active !== null && config.timer_active !== config.enabled && (
              <Alert isInline variant="warning" title="Timer and saved settings differ">
                Save the schedule to apply these settings to the timer.
              </Alert>
            )}
            {currentRun && (
              <Alert isInline variant="info" title={currentRun.state === "deactivating" ? "Scheduled upgrade is stopping" : "Scheduled upgrade is running"}>
                {currentRun.started_at && <>Started <TimeAgo timestamp={currentRun.started_at} />. </>}
                Package changes and hooks may still be running. Completed history will update after the service exits.
              </Alert>
            )}
            {config && (
              <DescriptionList isHorizontal className="pf-v6-u-mt-lg">
                <DescriptionListGroup>
                  <DescriptionListTerm>Timer status</DescriptionListTerm>
                  <DescriptionListDescription>
                    {config.timer_active === null ? (
                      <Label color="orange">Unknown</Label>
                    ) : config.timer_active ? (
                      <Label color="green" icon={<CheckCircleIcon />}>
                        Active
                      </Label>
                    ) : (
                      <Label color="grey" icon={<OutlinedClockIcon />}>
                        Inactive
                      </Label>
                    )}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                {config.timer_next_run && (
                  <DescriptionListGroup>
                    <DescriptionListTerm>Next run</DescriptionListTerm>
                    <DescriptionListDescription><TimeAgo timestamp={config.timer_next_run} /></DescriptionListDescription>
                  </DescriptionListGroup>
                )}
                {/* The schedule the timer is actually on, as systemd normalises
                    it. Shown because a lost drop-in falls back to the unit's own
                    OnCalendar, and the configured value above keeps claiming
                    otherwise. */}
                {config.timer_calendar && (
                  <DescriptionListGroup>
                    <DescriptionListTerm>Timer calendar</DescriptionListTerm>
                    <DescriptionListDescription>
                      <code>{config.timer_calendar}</code>
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                )}
              </DescriptionList>
            )}

            <ExpandableSection
              toggleText={historyExpanded ? "Hide run history" : "Show run history"}
              onToggle={(_event, expanded) => setHistoryExpanded(expanded)}
              isExpanded={historyExpanded}
              className="pf-v6-u-mt-lg"
            >
              <div ref={historyRegionRef} tabIndex={-1} role="group" aria-label="Run history">
                {runsError !== null && (
                  <Alert
                    component="h2"
                    variant="warning"
                    isInline
                    title="Could not read the run history"
                    className="pf-v6-u-mt-sm"
                  >
                    {runsError}
                  </Alert>
                )}
                {runs.length === 0 && !runsError ? (
                  <EmptyState headingLevel="h2" icon={ClockIcon} titleText="No scheduled runs yet">
                    <EmptyStateBody>
                      Scheduled upgrade history will appear here once the timer runs.
                    </EmptyStateBody>
                  </EmptyState>
                ) : runs.length > 0 ? (
                  <Table aria-label="Scheduled run history" variant="compact">
                    <Caption>
                      <span ref={historyCaptionRef} tabIndex={-1}>Last {runs.length.toLocaleString()} scheduled {runs.length === 1 ? "run" : "runs"}</span>
                    </Caption>
                    <Thead>
                      <Tr>
                        <Th screenReaderText="Row details" />
                        <Th>Timestamp</Th>
                        <Th>Mode</Th>
                        <Th>Status</Th>
                        <Th>Packages</Th>
                        <Th>Duration</Th>
                      </Tr>
                    </Thead>
                    {runs.map((run, index) => {
                      const hasDetails = !!runReason(run) || run.removed_stale_lock;
                      const isExpanded = expandedRuns.has(index);
                      return (
                        <Tbody key={`${run.timestamp}-${index}`} isExpanded={hasDetails && isExpanded}>
                          <Tr isRowSelected={run.timestamp === focusRun}>
                            <Td
                              expand={hasDetails ? {
                                rowIndex: index,
                                isExpanded,
                                onToggle: () => toggleRun(index),
                                expandId: "scheduled-run",
                              } : undefined}
                            />
                            {/* PF names each expand toggle by "simple-node<rowIndex>", so the timestamp labels it. */}
                            <Td dataLabel="Timestamp" id={`simple-node${index}`} tabIndex={run.timestamp === focusRun ? -1 : undefined}><TimeAgo timestamp={run.timestamp} /></Td>
                            <Td dataLabel="Mode">
                              <Label color={run.mode === "upgrade" ? "blue" : "grey"} isCompact>
                                {run.mode}
                              </Label>
                            </Td>
                            <Td dataLabel="Status"><RunStatus run={run} /></Td>
                            <Td dataLabel="Packages">{runPackages(run)}</Td>
                            <Td dataLabel="Duration">{formatDuration(run.duration_secs)}</Td>
                          </Tr>
                          {hasDetails && (
                            <Tr isExpanded={isExpanded}>
                              <Td colSpan={6}>
                                <ExpandableRowContent><RunDetails run={run} /></ExpandableRowContent>
                              </Td>
                            </Tr>
                          )}
                        </Tbody>
                      );
                    })}
                  </Table>
                ) : null}
              </div>
            </ExpandableSection>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        {confirmDiscard ? (
          <Alert
            component="h2"
            variant="warning"
            isInline
            isPlain
            isLiveRegion
            title="Discard changes to the schedule?"
            actionLinks={
              <>
                <Button variant="danger" onClick={discardChanges}>Discard changes</Button>
                <Button ref={keepEditingRef} variant="link" onClick={() => setConfirmDiscard(false)}>
                  Keep editing
                </Button>
              </>
            }
          />
        ) : (
          <>
            <Button
              variant="primary"
              onClick={handleSave}
              isDisabled={loading || !config || (!hasChanges() && config.timer_active === config.enabled) || saving}
              isLoading={saving}
            >
              Save
            </Button>
            <Button variant="link" onClick={requestClose}>
              Close
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};

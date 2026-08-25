import React, { useState, useEffect, useCallback } from "react";
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
  Tooltip,
} from "@patternfly/react-core";
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  OutlinedClockIcon,
  ClockIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  ScheduleConfig,
  ScheduleMode,
  ScheduledRunEntry,
  ScheduledRunStatus,
  getScheduleConfig,
  setScheduleConfig,
  getScheduledRuns,
} from "../api";
import { TimeAgo } from "./TimeAgo";
import { sanitizeErrorMessage } from "../utils";

/**
 * A run's wall-clock time. `null` means the record predates the field, or the
 * run was killed before it could be stamped.
 */
function formatDuration(secs: number | null): string {
  if (secs === null) return "-";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${secs % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const RUN_STATUS = {
  ok: { Icon: CheckCircleIcon, token: "success", label: "Success" },
  skipped: { Icon: ExclamationTriangleIcon, token: "warning", label: "Skipped" },
  failed: { Icon: ExclamationCircleIcon, token: "danger", label: "Failed" },
} as const;

/**
 * Keyed off `status`, never `success`: LogEntry sets success = status !=
 * "failed", so a skipped run is truthy and rendered as a green Success.
 * `success` is only the fallback for records written before status existed.
 */
const RunStatus: React.FC<{ run: ScheduledRunEntry }> = ({ run }) => {
  const status: ScheduledRunStatus =
    run.status === "ok" || run.status === "skipped" || run.status === "failed"
      ? run.status
      : run.success
        ? "ok"
        : "failed";
  const { Icon, token, label } = RUN_STATUS[status];

  // A skip carries its reason in details, a failure in error.
  const reason = run.error || run.details.join(", ");
  const cell = (
    <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
      <FlexItem>
        <Icon color={`var(--pf-t--global--icon--color--status--${token}--default)`} />
      </FlexItem>
      <FlexItem>{label}</FlexItem>
    </Flex>
  );
  const statusCell = reason ? <Tooltip content={reason}>{cell}</Tooltip> : cell;

  if (!run.removed_stale_lock) return statusCell;

  // Kept out of the reason tooltip: two nested tooltips fight over the same hover.
  return (
    <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
      <FlexItem>{statusCell}</FlexItem>
      <FlexItem>
        <Tooltip content="This run cleared a leftover pacman lock that no process was holding, so the run before it was killed part way through a transaction.">
          <Label color="orange" isCompact>
            Recovered
          </Label>
        </Tooltip>
      </FlexItem>
    </Flex>
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
}) => {
  useBackdropClose(isOpen, onClose);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<ScheduleConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<ScheduleMode>("upgrade");
  const [schedulePreset, setSchedulePreset] = useState("weekly");
  const [customSchedule, setCustomSchedule] = useState("");
  const [maxPackages, setMaxPackages] = useState(0);

  const [runs, setRuns] = useState<ScheduledRunEntry[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);

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
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const response = await getScheduledRuns({ limit: 10 });
      setRuns(response.runs);
      setRunsError(null);
    } catch (ex) {
      setRuns([]);
      setRunsError(sanitizeErrorMessage(ex instanceof Error ? ex.message : String(ex)));
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    Promise.resolve().then(() => {
      setSaveMessage(null);
      void loadConfig();
      void loadRuns();
    });
  }, [isOpen, loadConfig, loadRuns]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      const schedule = schedulePreset === "custom" ? customSchedule : schedulePreset;
      const response = await setScheduleConfig({
        enabled,
        mode,
        schedule,
        max_packages: maxPackages,
      });
      setSaveMessage(response.message);
      await loadConfig();
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
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

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen={isOpen}
      onClose={onClose}
    >
      <ModalHeader title="Scheduled Upgrades" />
      <ModalBody>
        {loading ? (
          <EmptyState headingLevel="h4" icon={Spinner} titleText="Loading schedule configuration" />
        ) : (
          <>
            {error && (
              <Alert variant="danger" title="Error" isInline className="pf-v6-u-mb-md">
                {sanitizeErrorMessage(error)}
              </Alert>
            )}

            {saveMessage && (
              <Alert variant="success" title="Saved" isInline className="pf-v6-u-mb-md">
                {saveMessage}
              </Alert>
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
                      : `Upgrades with more than ${maxPackages} package${maxPackages !== 1 ? "s" : ""} will be skipped as a safety measure.`}
                  </HelperTextItem>
                </HelperText>
              </FormGroup>
            )}

            {config && (
              <DescriptionList isHorizontal className="pf-v6-u-mt-lg">
                <DescriptionListGroup>
                  <DescriptionListTerm>Timer Status</DescriptionListTerm>
                  <DescriptionListDescription>
                    {config.timer_active ? (
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
                    <DescriptionListTerm>Next Run</DescriptionListTerm>
                    <DescriptionListDescription><TimeAgo timestamp={config.timer_next_run} /></DescriptionListDescription>
                  </DescriptionListGroup>
                )}
                {/* The schedule the timer is actually on, as systemd normalises
                    it. Shown because a lost drop-in falls back to the unit's own
                    OnCalendar, and the configured value above keeps claiming
                    otherwise. */}
                {config.timer_calendar && (
                  <DescriptionListGroup>
                    <DescriptionListTerm>Timer Calendar</DescriptionListTerm>
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
              {runsError !== null ? (
                <Alert
                  variant="warning"
                  isInline
                  title="Could not read the run history"
                  className="pf-v6-u-mt-sm"
                >
                  {runsError}
                </Alert>
              ) : runs.length === 0 ? (
                <EmptyState headingLevel="h4" icon={ClockIcon} titleText="No scheduled runs yet">
                  <EmptyStateBody>
                    Scheduled upgrade history will appear here once the timer runs.
                  </EmptyStateBody>
                </EmptyState>
              ) : (
                <Table aria-label="Scheduled run history" variant="compact">
                  <Thead>
                    <Tr>
                      <Th>Timestamp</Th>
                      <Th>Mode</Th>
                      <Th>Status</Th>
                      <Th>Packages</Th>
                      <Th>Duration</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {runs.map((run, index) => (
                      <Tr key={`${run.timestamp}-${index}`}>
                        <Td dataLabel="Timestamp"><TimeAgo timestamp={run.timestamp} /></Td>
                        <Td dataLabel="Mode">
                          <Label color={run.mode === "upgrade" ? "blue" : "grey"} isCompact>
                            {run.mode}
                          </Label>
                        </Td>
                        <Td dataLabel="Status"><RunStatus run={run} /></Td>
                        <Td dataLabel="Packages">
                          {run.packages_upgraded > 0
                            ? `${(run.packages_upgraded).toLocaleString()} upgraded`
                            : `${(run.packages_checked).toLocaleString()} checked`}
                        </Td>
                        <Td dataLabel="Duration">{formatDuration(run.duration_secs)}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </ExpandableSection>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          onClick={handleSave}
          isDisabled={loading || !hasChanges() || saving}
          isLoading={saving}
        >
          Save
        </Button>
        <Button variant="link" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};

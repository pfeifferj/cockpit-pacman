import React, { useState, useEffect, useCallback } from "react";
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
  OutlinedClockIcon,
  ClockIcon,
} from "@patternfly/react-icons";
import { Table, Thead, Tr, Th, Tbody, Td } from "@patternfly/react-table";
import {
  ScheduleConfig,
  ScheduleMode,
  ScheduledRunEntry,
  getScheduleConfig,
  setScheduleConfig,
  getScheduledRuns,
  formatNumber,
} from "../api";
import { sanitizeErrorMessage } from "../utils";

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
}

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

const formatTimestamp = (timestamp: string): string => {
  try {
    // Handle systemd format: "Wed 2026-01-21 22:03:15 CET"
    const systemdMatch = timestamp.match(/^\w+\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    if (systemdMatch) {
      const date = new Date(`${systemdMatch[1]}T${systemdMatch[2]}`);
      if (!isNaN(date.getTime())) {
        return date.toLocaleString();
      }
    }
    // Handle ISO format and other standard formats
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
      return date.toLocaleString();
    }
    return timestamp;
  } catch {
    return timestamp;
  }
};

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  isOpen,
  onClose,
}) => {
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
  const [historyExpanded, setHistoryExpanded] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getScheduleConfig();
      setConfig(response);
      setEnabled(response.enabled);
      setMode(response.mode);
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
    } catch {
      // Ignore errors loading run history
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadConfig();
      loadRuns();
      setSaveMessage(null);
    }
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
                    <DescriptionListDescription>{formatTimestamp(config.timer_next_run)}</DescriptionListDescription>
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
              {runs.length === 0 ? (
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
                    </Tr>
                  </Thead>
                  <Tbody>
                    {runs.map((run, index) => (
                      <Tr key={`${run.timestamp}-${index}`}>
                        <Td dataLabel="Timestamp">{formatTimestamp(run.timestamp)}</Td>
                        <Td dataLabel="Mode">
                          <Label color={run.mode === "upgrade" ? "blue" : "grey"} isCompact>
                            {run.mode}
                          </Label>
                        </Td>
                        <Td dataLabel="Status">
                          {run.success ? (
                            run.details.length > 0 ? (
                              <Tooltip content={run.details.join(", ")}>
                                <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                                  <FlexItem>
                                    <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" />
                                  </FlexItem>
                                  <FlexItem>Success</FlexItem>
                                </Flex>
                              </Tooltip>
                            ) : (
                              <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                                <FlexItem>
                                  <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" />
                                </FlexItem>
                                <FlexItem>Success</FlexItem>
                              </Flex>
                            )
                          ) : (
                            <Tooltip content={run.error || run.details.join(", ") || "Unknown error"}>
                              <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                                <FlexItem>
                                  <ExclamationCircleIcon color="var(--pf-t--global--icon--color--status--danger--default)" />
                                </FlexItem>
                                <FlexItem>Failed</FlexItem>
                              </Flex>
                            </Tooltip>
                          )}
                        </Td>
                        <Td dataLabel="Packages">
                          {run.packages_upgraded > 0
                            ? `${formatNumber(run.packages_upgraded)} upgraded`
                            : `${formatNumber(run.packages_checked)} checked`}
                        </Td>
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

import React, { useState, useEffect, useMemo } from "react";
import { Tooltip } from "@patternfly/react-core";
import { parseTimestamp, formatRelativeTime, formatFullTimestamp, formatFullDate, subscribeToTick } from "../timeFormat";

interface TimeAgoProps {
  timestamp: string | number | null | undefined;
  dateOnly?: boolean;
  fallback?: string;
  live?: boolean;
}

export const TimeAgo: React.FC<TimeAgoProps> = ({
  timestamp,
  dateOnly = false,
  fallback = "Unknown",
  live = true,
}) => {
  const [, setTick] = useState(0);

  const date = useMemo(() => parseTimestamp(timestamp ?? null), [timestamp]);

  useEffect(() => {
    if (!live || !date) return;
    return subscribeToTick(() => setTick(t => t + 1));
  }, [live, date]);

  if (!date) {
    return <span>{fallback}</span>;
  }

  const relative = formatRelativeTime(date);
  const full = dateOnly ? formatFullDate(date) : formatFullTimestamp(date);

  return (
    <Tooltip content={full}>
      <span style={{ borderBottom: "1px dotted var(--pf-t--global--border--color--default)", cursor: "default" }}>
        {relative}
      </span>
    </Tooltip>
  );
};

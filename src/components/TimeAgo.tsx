import React, { useState, useEffect, useMemo } from "react";
import { Tooltip } from "@patternfly/react-core";
import { parseTimestamp, formatRelativeTime, formatFullTimestamp, formatFullDate, subscribeToTick } from "../timeFormat";

interface TimeAgoProps {
  timestamp: string | number | null | undefined;
  dateOnly?: boolean;
  fallback?: string;
}

export const TimeAgo: React.FC<TimeAgoProps> = ({
  timestamp,
  dateOnly = false,
  fallback = "Unknown",
}) => {
  const [, setTick] = useState(0);

  const date = useMemo(() => parseTimestamp(timestamp ?? null), [timestamp]);

  useEffect(() => {
    if (!date) return;
    return subscribeToTick(() => setTick(t => t + 1));
  }, [date]);

  if (!date) {
    return <span>{fallback}</span>;
  }

  const relative = formatRelativeTime(date);
  const full = dateOnly ? formatFullDate(date) : formatFullTimestamp(date);

  return (
    <Tooltip content={full} trigger="mouseenter focus">
      <time
        dateTime={date.toISOString()}
        tabIndex={0}
        style={{ borderBottom: "1px dotted var(--pf-t--global--border--color--default)", cursor: "default" }}
      >
        {relative}
      </time>
    </Tooltip>
  );
};

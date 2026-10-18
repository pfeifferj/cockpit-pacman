import React, { useLayoutEffect, useRef, useState } from "react";
import { Button, CodeBlock, CodeBlockCode, ExpandableSection } from "@patternfly/react-core";
import { LOG_CONTAINER_HEIGHT } from "../constants";

interface LogViewerProps {
  log: string;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}

const FOLLOW_THRESHOLD_PX = 24;

/**
 * Scrollable log output. It follows new lines only while scrolled to within
 * FOLLOW_THRESHOLD_PX of the bottom; scrolling up pauses following.
 */
export const LogViewer: React.FC<LogViewerProps> = ({ log, placeholder, className, "aria-label": ariaLabel = "Output" }) => {
  const ref = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);

  const setFollow = (value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  };

  useLayoutEffect(() => {
    if (ref.current && followingRef.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [log]);

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
    if (atBottom !== followingRef.current) setFollow(atBottom);
  };

  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setFollow(true);
    // The button unmounts once following resumes; keep keyboard focus on the log.
    el.focus();
  };

  return (
    <div
      ref={ref}
      className={className}
      style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}
      onScroll={handleScroll}
      tabIndex={0}
      role="log"
      aria-live="off"
      aria-label={ariaLabel}
    >
      <CodeBlock>
        <CodeBlockCode>{log || placeholder}</CodeBlockCode>
      </CodeBlock>
      {!following && (
        <div style={{ position: "sticky", bottom: 0, display: "flex", justifyContent: "flex-end" }}>
          <Button
            variant="link"
            size="sm"
            onClick={jumpToLatest}
            style={{ background: "var(--pf-t--global--background--color--primary--default)" }}
          >
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
};

interface ExpandableLogViewerProps extends Omit<LogViewerProps, "className"> {
  isExpanded: boolean;
  onToggle: (expanded: boolean) => void;
  className?: string;
}

/** LogViewer behind a Show/Hide details toggle. */
export const ExpandableLogViewer: React.FC<ExpandableLogViewerProps> = ({ isExpanded, onToggle, className, ...logProps }) => (
  <ExpandableSection
    toggleText={isExpanded ? "Hide details" : "Show details"}
    onToggle={(_event, expanded) => onToggle(expanded)}
    isExpanded={isExpanded}
    className={className}
  >
    <LogViewer {...logProps} />
  </ExpandableSection>
);

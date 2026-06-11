import React from "react";
import { CodeBlock, CodeBlockCode, ExpandableSection } from "@patternfly/react-core";
import { useAutoScrollLog } from "../hooks/useAutoScrollLog";
import { LOG_CONTAINER_HEIGHT } from "../constants";

interface LogViewerProps {
  log: string;
  placeholder?: string;
  className?: string;
}

/** Scrollable log output that follows the latest line. */
export const LogViewer: React.FC<LogViewerProps> = ({ log, placeholder, className }) => {
  const ref = useAutoScrollLog(log);
  return (
    <div ref={ref} className={className} style={{ maxHeight: LOG_CONTAINER_HEIGHT, overflow: "auto" }}>
      <CodeBlock>
        <CodeBlockCode>{log || placeholder}</CodeBlockCode>
      </CodeBlock>
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

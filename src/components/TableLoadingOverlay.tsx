import React from "react";
import { Spinner } from "@patternfly/react-core";

interface TableLoadingOverlayProps {
  loading: boolean;
  children: React.ReactNode;
}

/**
 * Wraps a table with a loading overlay that shows a spinner in the top-right
 * corner and fades the content while loading.
 */
export const TableLoadingOverlay: React.FC<TableLoadingOverlayProps> = ({
  loading,
  children,
}) => (
  <div style={{ position: "relative" }}>
    {loading && (
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          padding: "0.5rem",
          zIndex: 1,
        }}
      >
        <Spinner size="md" />
      </div>
    )}
    <div
      style={{
        opacity: loading ? 0.6 : 1,
        transition: "opacity 0.2s",
      }}
    >
      {children}
    </div>
  </div>
);

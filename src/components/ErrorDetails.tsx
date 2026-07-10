import React from "react";

/** Muted secondary line for a backend error's context chain. */
export const ErrorDetails: React.FC<{ details?: string }> = ({ details }) =>
  details ? (
    <div
      style={{
        marginTop: "0.5rem",
        color: "var(--pf-t--global--text--color--subtle)",
        fontSize: "0.85em",
        whiteSpace: "pre-wrap",
      }}
    >
      {details}
    </div>
  ) : null;

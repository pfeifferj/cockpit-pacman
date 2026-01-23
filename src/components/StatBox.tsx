import React from "react";
import { Spinner } from "@patternfly/react-core";

export type StatColor = "default" | "info" | "success" | "danger" | "warning";

const COLOR_MAP: Record<StatColor, string | undefined> = {
  default: undefined,
  info: "var(--pf-t--global--color--status--info--default)",
  success: "var(--pf-t--global--color--status--success--default)",
  danger: "var(--pf-t--global--color--status--danger--default)",
  warning: "var(--pf-t--global--color--status--warning--default)",
};

export interface StatBoxProps {
  value: React.ReactNode;
  label: string;
  color?: StatColor;
  isLoading?: boolean;
  onClick?: () => void;
}

export const StatBox: React.FC<StatBoxProps> = ({ value, label, color = "default", isLoading, onClick }) => (
  <div
    style={{
      textAlign: "center",
      padding: "0.75rem 1.5rem",
      background: "var(--pf-t--global--background--color--secondary--default)",
      borderRadius: "6px",
      cursor: onClick ? "pointer" : undefined,
      transition: onClick ? "background 0.15s ease" : undefined,
    }}
    onClick={onClick}
    onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
    role={onClick ? "button" : undefined}
    tabIndex={onClick ? 0 : undefined}
  >
    <div style={{ fontSize: "1.5rem", fontWeight: 600, color: COLOR_MAP[color], minHeight: "2.25rem", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {isLoading ? <Spinner size="md" /> : value}
    </div>
    <div
      style={{
        fontSize: "0.75rem",
        color: "var(--pf-t--global--text--color--subtle)",
        textTransform: "uppercase",
      }}
    >
      {label}
    </div>
  </div>
);

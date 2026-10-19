import React, { useId } from "react";
import { Spinner, Tooltip } from "@patternfly/react-core";

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
  /** Accessible name of a clickable box; defaults to "<value> <label>". */
  ariaLabel?: string;
  isActive?: boolean;
  /** Longer explanation, shown as a Tooltip and exposed as the box's description. */
  description?: string;
}

const boxStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "0.75rem 1.5rem",
  background: "var(--pf-t--global--background--color--secondary--default)",
  borderRadius: "6px",
};

export const StatBox: React.FC<StatBoxProps> = ({ value, label, color = "default", isLoading, onClick, ariaLabel, isActive, description }) => {
  const descriptionId = useId();
  const content = (
    <>
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
    </>
  );

  if (!onClick) {
    const box = <div style={boxStyle}>{content}</div>;
    return description ? <Tooltip content={description}>{box}</Tooltip> : box;
  }

  const valueText = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const name = ariaLabel ?? (isLoading || !valueText ? label : `${valueText} ${label}`);
  const button = (
    <button
      type="button"
      style={{
        ...boxStyle,
        display: "block",
        border: 0,
        font: "inherit",
        color: "inherit",
        cursor: "pointer",
        transition: "background 0.15s ease",
        outline: isActive ? "2px solid var(--pf-t--global--border--color--brand--default)" : undefined,
        outlineOffset: isActive ? "-2px" : undefined,
      }}
      aria-pressed={isActive}
      aria-label={name}
      aria-describedby={description ? descriptionId : undefined}
      onClick={onClick}
    >
      {content}
    </button>
  );

  if (!description) return button;
  return (
    <>
      <Tooltip content={description} aria="none">{button}</Tooltip>
      <span id={descriptionId} hidden>{description}</span>
    </>
  );
};

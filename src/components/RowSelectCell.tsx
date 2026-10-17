import React, { useId } from "react";
import { Td } from "@patternfly/react-table";

interface RowSelectCellProps {
  label: string;
  isSelected: boolean;
  isDisabled?: boolean;
  description?: string;
  onSelect: (selected: boolean) => void;
}

const stopRowActivation = (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
};

/** Named row checkbox that prevents selection events from activating the row. */
export const RowSelectCell: React.FC<RowSelectCellProps> = ({ label, isSelected, isDisabled, description, onSelect }) => {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <Td
      className="pf-v6-c-table__check"
      dataLabel="Select"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={stopRowActivation}
    >
      <label>
        <input
          type="checkbox"
          name={`select-${id}`}
          className={isDisabled ? "pf-v6-c-check__input" : undefined}
          aria-label={label}
          aria-describedby={description ? descriptionId : undefined}
          checked={isSelected}
          disabled={isDisabled}
          onChange={(e) => onSelect(e.currentTarget.checked)}
        />
      </label>
      {description && <span id={descriptionId} className="pf-v6-screen-reader">{description}</span>}
    </Td>
  );
};

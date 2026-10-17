import type React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Table, Tbody, Tr } from "@patternfly/react-table";
import { RowSelectCell } from "./RowSelectCell";

const renderRow = (props: Partial<React.ComponentProps<typeof RowSelectCell>> = {}) => {
  const onRowClick = vi.fn();
  const onRowKeyDown = vi.fn();
  const onSelect = vi.fn();
  render(
    <Table aria-label="Packages">
      <Tbody>
        <Tr isClickable onRowClick={onRowClick} onKeyDown={onRowKeyDown}>
          <RowSelectCell label="Select vim" isSelected={false} onSelect={onSelect} {...props} />
        </Tr>
      </Tbody>
    </Table>,
  );
  return { onRowClick, onRowKeyDown, onSelect };
};

describe("RowSelectCell", () => {
  it("names the checkbox by its label inside a PF check cell with a data label", () => {
    renderRow();
    const box = screen.getByRole("checkbox", { name: "Select vim" });
    const cell = box.closest("td")!;
    expect(cell).toHaveClass("pf-v6-c-table__check");
    expect(cell).toHaveAttribute("data-label", "Select");
    expect(box.getAttribute("name")).not.toMatch(/^checkrow/);
  });

  it("reports the new state on click without activating the row", () => {
    const { onSelect, onRowClick } = renderRow();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select vim" }));
    expect(onSelect).toHaveBeenCalledWith(true);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("keeps Enter and Space from reaching the row", () => {
    const { onRowKeyDown } = renderRow();
    const box = screen.getByRole("checkbox", { name: "Select vim" });
    fireEvent.keyDown(box, { key: " " });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onRowKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(onRowKeyDown).toHaveBeenCalledTimes(1);
  });

  it("toggles on Space as a native checkbox", () => {
    const { onSelect } = renderRow({ isSelected: true });
    const box = screen.getByRole("checkbox", { name: "Select vim" });
    expect(box).toBeChecked();
    box.focus();
    // The browser's Space default is the toggle; jsdom does not synthesize its click.
    expect(fireEvent.keyDown(box, { key: " " })).toBe(true);
    expect(fireEvent.keyUp(box, { key: " " })).toBe(true);
    fireEvent.click(box);
    expect(onSelect).toHaveBeenCalledWith(false);
    expect(box.tagName).toBe("INPUT");
    expect(box).toHaveAttribute("type", "checkbox");
  });

  it("describes a disabled row and keeps its name", () => {
    renderRow({ isDisabled: true, description: "Ignored during upgrades" });
    const box = screen.getByRole("checkbox", { name: "Select vim" });
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription("Ignored during upgrades");
  });

  it("gives each row its own input name", () => {
    render(
      <Table aria-label="Packages">
        <Tbody>
          <Tr><RowSelectCell label="Select vim" isSelected={false} onSelect={vi.fn()} /></Tr>
          <Tr><RowSelectCell label="Select git" isSelected={false} onSelect={vi.fn()} /></Tr>
        </Tbody>
      </Table>,
    );
    const names = screen.getAllByRole("checkbox").map((b) => b.getAttribute("name"));
    expect(new Set(names).size).toBe(2);
  });
});

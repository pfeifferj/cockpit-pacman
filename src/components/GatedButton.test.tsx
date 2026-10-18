import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dropdown, DropdownList, MenuToggle } from "@patternfly/react-core";
import { GatedButton, GatedDropdownItem } from "./GatedButton";
import type { MutationGate } from "../hooks/useMutationGate";

const open: MutationGate = { blocked: false };
const busy: MutationGate = { blocked: true, reason: "An upgrade is running. Wait for it to finish." };

describe("GatedButton", () => {
  it("runs onClick and has no description while the gate is open", () => {
    const onClick = vi.fn();
    render(<GatedButton gate={open} onClick={onClick}>Save</GatedButton>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("aria-describedby");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is aria-disabled, described by the reason and inert while blocked", async () => {
    const onClick = vi.fn();
    render(<GatedButton gate={busy} onClick={onClick}>Save</GatedButton>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(busy.reason);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    act(() => button.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(busy.reason!);
  });

  it("uses a local reason, and the gate reason wins over it", () => {
    const { rerender } = render(<GatedButton gate={open} disabledReason="Select at least one update">Apply</GatedButton>);
    const button = screen.getByRole("button", { name: "Apply" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Select at least one update");
    rerender(<GatedButton gate={busy} disabledReason="Select at least one update">Apply</GatedButton>);
    expect(button).toHaveAccessibleDescription(busy.reason);
    rerender(<GatedButton gate={open} disabledReason={false}>Apply</GatedButton>);
    expect(button).not.toHaveAttribute("aria-disabled", "true");
  });

  it("keeps the same focused element while the gate flips, and hides the tooltip on unblock", async () => {
    const { rerender } = render(<GatedButton gate={open}>Save</GatedButton>);
    const button = screen.getByRole("button", { name: "Save" });
    act(() => button.focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    rerender(<GatedButton gate={busy}>Save</GatedButton>);
    expect(screen.getByRole("button", { name: "Save" })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(busy.reason!);

    rerender(<GatedButton gate={open}>Save</GatedButton>);
    expect(screen.getByRole("button", { name: "Save" })).toBe(button);
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("hides the tooltip on Escape", async () => {
    render(<GatedButton gate={busy}>Save</GatedButton>);
    const button = screen.getByRole("button", { name: "Save" });
    act(() => button.focus());
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(button, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(button).toHaveAccessibleDescription(busy.reason);
  });

  it("keeps a caller's aria-describedby", () => {
    render(
      <>
        <span id="extra">Extra</span>
        <GatedButton gate={busy} aria-describedby="extra">Save</GatedButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveAccessibleDescription(`Extra ${busy.reason}`);
  });
});

describe("GatedDropdownItem", () => {
  const menu = (gate: MutationGate, onClick = vi.fn()) => (
    <Dropdown
      isOpen
      toggle={(ref) => <MenuToggle ref={ref}>Actions</MenuToggle>}
    >
      <DropdownList>
        <GatedDropdownItem gate={gate} onClick={onClick}>Ignore package</GatedDropdownItem>
      </DropdownList>
    </Dropdown>
  );

  it("describes and blocks the item while the gate is closed, and releases it after", () => {
    const onClick = vi.fn();
    const { rerender } = render(menu(busy, onClick));
    const item = screen.getByRole("menuitem", { name: "Ignore package" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription(busy.reason);
    fireEvent.click(item);
    expect(onClick).not.toHaveBeenCalled();

    rerender(menu(open, onClick));
    expect(screen.getByRole("menuitem", { name: "Ignore package" })).toBe(item);
    expect(item).not.toHaveAttribute("aria-disabled");
    expect(item).not.toHaveAttribute("aria-describedby");
    fireEvent.click(item);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UndoAlert } from "./UndoAlert";

describe("UndoAlert", () => {
  it("keeps an empty live region mounted before the alert appears", () => {
    const { container, rerender } = render(<UndoAlert title={null} onClose={vi.fn()} />);
    const region = container.querySelector("[aria-live='polite']");
    expect(region).toBeEmptyDOMElement();

    rerender(<UndoAlert title="Saved /etc/pacman.conf" onUndo={vi.fn()} onClose={vi.fn()} />);
    expect(container.querySelector("[aria-live='polite']")).toBe(region);
    expect(region).toHaveTextContent("Saved /etc/pacman.conf");
  });

  it("runs Undo, and blocks it with a described reason", () => {
    const onUndo = vi.fn();
    const { rerender } = render(<UndoAlert title="Changes discarded" onUndo={onUndo} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);

    rerender(
      <UndoAlert
        title="Changes discarded"
        onUndo={onUndo}
        gate={{ blocked: true, reason: "An upgrade is running. Wait for it to finish." }}
        onClose={vi.fn()}
      />,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(undo).toHaveAccessibleDescription("An upgrade is running. Wait for it to finish.");
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("omits Undo when the change cannot be undone", () => {
    render(<UndoAlert title="Saved /etc/pacman.conf" onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("names the inverse action and gates it like Undo", () => {
    const onUndo = vi.fn();
    const { rerender } = render(
      <UndoAlert title="Signed off vim 9.1-1" undoLabel="Revoke" onUndo={onUndo} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(onUndo).toHaveBeenCalledTimes(1);

    rerender(
      <UndoAlert
        title="Signed off vim 9.1-1"
        undoLabel="Revoke"
        onUndo={onUndo}
        disabledReason="Wait for the sign off to finish"
        onClose={vi.fn()}
      />,
    );
    const revoke = screen.getByRole("button", { name: "Revoke" });
    expect(revoke).toHaveAttribute("aria-disabled", "true");
    expect(revoke).toHaveAccessibleDescription("Wait for the sign off to finish");
    fireEvent.click(revoke);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConfirmModal, type ConfirmModalProps, type ConfirmSeverity } from "./ConfirmModal";
import { sweepA11y } from "../test/a11ySweep";

function renderConfirm(severity?: ConfirmSeverity, extra: Partial<ConfirmModalProps> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmModal isOpen title="Delete it?" severity={severity} commitLabel="Delete" onConfirm={onConfirm} onClose={onClose} {...extra}>
      The file is gone afterwards.
    </ConfirmModal>,
  );
  return { onConfirm, onClose };
}

describe("ConfirmModal", () => {
  afterEach(cleanup);

  it("is named by its title and passes the a11y sweep", () => {
    renderConfirm();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Delete it?");
    sweepA11y({ dialogs: ["Delete it?"] });
  });

  it.each([
    [undefined, null, "pf-m-primary"],
    ["warning", "pf-m-warning", "pf-m-primary"],
    ["danger", "pf-m-danger", "pf-m-danger"],
  ] as const)("maps severity %s to the title icon and commit variant", (severity, titleClass, commitClass) => {
    renderConfirm(severity);
    const title = document.querySelector(".pf-v6-c-modal-box__title")!;
    if (titleClass) expect(title).toHaveClass(titleClass);
    else expect(title).not.toHaveClass("pf-m-icon");
    expect(screen.getByRole("dialog")).toHaveAccessibleName(severity ? /Delete it\?$/ : "Delete it?");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(commitClass);
  });

  it("commits and cancels through its callbacks", () => {
    const { onConfirm, onClose } = renderConfirm("danger");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a gated commit focusable with its reason and does not commit", () => {
    const { onConfirm } = renderConfirm("danger", { gate: { blocked: true, reason: "An upgrade is running." } });
    const commit = screen.getByRole("button", { name: "Delete" });
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).toHaveAccessibleDescription("An upgrade is running.");
    fireEvent.click(commit);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocks the commit with a local reason, focusable and described", () => {
    const { onConfirm } = renderConfirm("danger", { disabledReason: "Listing installed packages…" });
    const commit = screen.getByRole("button", { name: "Delete" });
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).not.toBeDisabled();
    expect(commit).toHaveAccessibleDescription("Listing installed packages…");
    fireEvent.click(commit);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

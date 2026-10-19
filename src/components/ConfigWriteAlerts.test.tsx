import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ConfigFileEditor } from "../hooks/useConfigFileEditor";
import { sweepA11y } from "../test/a11ySweep";
import { ConfigPendingChanges, ConfigWriteAlerts, RestoreGuardModal } from "./ConfigWriteAlerts";

const FILE = "/etc/pacman.conf";
const LABEL = "pacman.conf";

type Editor = ConfigFileEditor<string>;

function stubEditor(overrides: Partial<Editor> = {}): Editor {
  const base = {
    file: FILE,
    changeSources: "IgnorePkg from Updates, or another program",
    pendingChanges: [] as string[],
    hasChanges: false,
    lockReason: null,
    saveError: null,
    configChanged: false,
    refreshError: null,
    retryRefresh: vi.fn(),
    outsideNotice: null,
    dismissOutsideNotice: vi.fn(),
    restoreError: null,
    retryRestore: vi.fn(),
    dismissRestoreError: vi.fn(),
    reapplied: null,
    reapply: vi.fn(),
    dismissReapplied: vi.fn(),
    lastWrite: null,
    dismissLastWrite: vi.fn(),
    discarded: null,
    undoDiscard: vi.fn(),
    dismissDiscarded: vi.fn(),
    outsideChange: null,
    openForceSave: vi.fn(),
    closeForceSave: vi.fn(),
    save: vi.fn(),
    forceSave: vi.fn(),
    restoreConflict: null,
    confirmRestore: vi.fn(),
    cancelRestore: vi.fn(),
    undo: vi.fn(),
  };
  return { ...base, ...overrides } as unknown as Editor;
}

function renderAlerts(editor: Editor, saveBlockedReason: string | null = null) {
  return render(
    <ConfigWriteAlerts
      editor={editor}
      fileLabel={LABEL}
      notSavedTitle="pacman.conf not saved"
      saveBlockedReason={saveBlockedReason}
      restoreGate={{ blocked: false }}
    />,
  );
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a PF alert or dialog title, which carries a screen-reader severity prefix such as "Warning alert:". */
function titled(text: string): RegExp {
  return new RegExp(`(^|alert:)${escape(text)}$`);
}

function closeNamed(title: string): RegExp {
  return new RegExp(`^Close .*alert: ${escape(title)}$`);
}

function alertTitled(name: string | RegExp): HTMLElement {
  const heading = screen.getByRole("heading", { name: typeof name === "string" ? titled(name) : name });
  return heading.closest<HTMLElement>(".pf-v6-c-alert")!;
}

describe("ConfigWriteAlerts", () => {
  it("renders nothing visible with no state", () => {
    renderAlerts(stubEditor());
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    sweepA11y();
  });

  it("shows a save error with the message, the kept edits and Try again", () => {
    const save = vi.fn();
    renderAlerts(stubEditor({
      saveError: { message: "Permission denied", code: undefined },
      save,
      pendingChanges: ["Disabled [extra]"],
      hasChanges: true,
    }));
    const alert = alertTitled(/pacman\.conf not saved/);
    expect(alert).toHaveTextContent("Permission denied");
    expect(alert).toHaveTextContent("Your changes are still here.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(save).toHaveBeenCalledTimes(1);
    sweepA11y();
  });

  it("keeps Try again focusable with its reason while saving is blocked", () => {
    const save = vi.fn();
    renderAlerts(stubEditor({ saveError: { message: "boom", code: undefined }, save }), "Turn on administrative access to save");
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).toHaveAccessibleDescription("Turn on administrative access to save");
    fireEvent.click(retry);
    expect(save).not.toHaveBeenCalled();
    sweepA11y();
  });

  it("offers reapply and a force save for config_changed", () => {
    const reapply = vi.fn();
    const openForceSave = vi.fn();
    renderAlerts(stubEditor({
      saveError: { message: "changed", code: "config_changed" },
      configChanged: true,
      pendingChanges: ["Disabled [extra]", "Enabled [multilib]"],
      hasChanges: true,
      reapply,
      openForceSave,
    }));
    const alert = alertTitled(`${FILE} changed since you started editing`);
    expect(alert).toHaveTextContent("Nothing was written.");
    expect(alert).toHaveTextContent("IgnorePkg from Updates, or another program");
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Reload and reapply my 2 changes" }));
    expect(reapply).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Save my version anyway" }));
    expect(openForceSave).toHaveBeenCalledTimes(1);
    sweepA11y();
  });

  it("names the force-save dialog and lists the outside change before the commit", async () => {
    const forceSave = vi.fn();
    const closeForceSave = vi.fn();
    renderAlerts(stubEditor({
      saveError: { message: "changed", code: "config_changed" },
      configChanged: true,
      pendingChanges: ["Disabled [extra]"],
      hasChanges: true,
      outsideChange: { status: "ready", revision: "fresh", changes: ["IgnorePkg: added linux"] },
      forceSave,
      closeForceSave,
    }));
    const dialog = screen.getByRole("dialog", { name: titled(`Replace ${LABEL}?`) });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    const change = within(dialog).getByText("IgnorePkg: added linux");
    const commit = within(dialog).getByRole("button", { name: `Replace ${LABEL}` });
    expect(change.compareDocumentPosition(commit) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(commit).toHaveClass("pf-m-danger");
    sweepA11y({ dialogs: [titled(`Replace ${LABEL}?`)] });
    fireEvent.click(commit);
    expect(forceSave).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(closeForceSave).toHaveBeenCalledTimes(1);
  });

  it("names the read in progress and a failed read in the force-save dialog", () => {
    const { rerender } = renderAlerts(stubEditor({ outsideChange: { status: "loading" } }));
    expect(screen.getByRole("progressbar", { name: `Reading ${FILE}` })).toBeInTheDocument();
    sweepA11y({ dialogs: [titled(`Replace ${LABEL}?`)] });
    rerender(
      <ConfigWriteAlerts
        editor={stubEditor({ outsideChange: { status: "failed", message: "No such file" } })}
        fileLabel={LABEL}
        notSavedTitle="pacman.conf not saved"
        saveBlockedReason={null}
        restoreGate={{ blocked: false }}
      />,
    );
    expect(screen.getByRole("dialog", { name: titled(`Replace ${LABEL}?`) }))
      .toHaveTextContent("The current file could not be read: No such file");
  });

  it("keeps entries on a failed refresh and says the edits are still here", () => {
    const retryRefresh = vi.fn();
    renderAlerts(stubEditor({
      refreshError: "Connection lost",
      retryRefresh,
      pendingChanges: ["Disabled [extra]"],
      hasChanges: true,
    }));
    const alert = alertTitled(`Could not refresh ${LABEL}`);
    expect(alert).toHaveTextContent("Connection lost Your 1 unsaved change is still here.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(retryRefresh).toHaveBeenCalledTimes(1);
    sweepA11y();
  });

  it("asks a named confirm before restoring over a changed file", async () => {
    const confirmRestore = vi.fn();
    const cancelRestore = vi.fn();
    renderAlerts(stubEditor({
      restoreConflict: { timestamp: 1, title: "Restored", changes: ["Enabled [testing]"] },
      confirmRestore,
      cancelRestore,
    }));
    const name = titled(`Restore over the changed ${LABEL}?`);
    const dialog = screen.getByRole("dialog", { name });
    expect(within(dialog).getByText("Enabled [testing]")).toBeInTheDocument();
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    sweepA11y({ dialogs: [name] });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace changes and restore" }));
    expect(confirmRestore).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(cancelRestore).toHaveBeenCalledTimes(1);
  });

  it("shows a restore failure with Try again and a named close", () => {
    const retryRestore = vi.fn();
    const dismissRestoreError = vi.fn();
    renderAlerts(stubEditor({
      restoreError: { message: "Backup missing", timestamp: 1, title: "Restored" },
      retryRestore,
      dismissRestoreError,
    }));
    const alert = alertTitled(`${FILE} not restored`);
    expect(alert).toHaveTextContent("Backup missing The file was not changed.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(retryRestore).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: closeNamed(`${FILE} not restored`) }));
    expect(dismissRestoreError).toHaveBeenCalledTimes(1);
    sweepA11y();
  });

  it("names skipped edits after a reapply and moves focus into the result", async () => {
    renderAlerts(stubEditor({
      reapplied: { applied: 1, skipped: ["[extra]: SigLevel"], outside: false },
    }));
    const alert = alertTitled("1 change no longer applies");
    expect(alert).toHaveClass("pf-m-warning");
    expect(within(alert).getByText("[extra]: SigLevel")).toBeInTheDocument();
    expect(alert).toHaveTextContent("1 change is ready to save on top of the current file.");
    await waitFor(() => expect(alert).toContainElement(document.activeElement as HTMLElement));
    sweepA11y();
  });

  it("leaves focus alone when an outside change was reapplied unasked", () => {
    const outside = document.createElement("button");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    outside.focus();
    try {
      renderAlerts(stubEditor({
        reapplied: { applied: 2, skipped: [], outside: true },
      }));
      const alert = alertTitled(`${LABEL} changed since you started editing`);
      expect(alert).toHaveTextContent("Your 2 changes were reapplied to the file as it is now.");
      expect(outside).toHaveFocus();
      sweepA11y();
    } finally {
      outside.remove();
    }
  });

  it("offers Undo for the last write and blocks it while edits are pending", () => {
    const undo = vi.fn();
    const editor = stubEditor({ lastWrite: { title: `${LABEL} saved`, revision: "saved", backupTimestamp: 42 }, undo });
    const { rerender } = renderAlerts(editor);
    const alert = alertTitled(`${LABEL} saved`);
    fireEvent.click(within(alert).getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    sweepA11y();
    rerender(
      <ConfigWriteAlerts
        editor={stubEditor({ lastWrite: { title: `${LABEL} saved`, revision: "saved", backupTimestamp: 42 }, undo, hasChanges: true })}
        fileLabel={LABEL}
        notSavedTitle="pacman.conf not saved"
        saveBlockedReason={null}
        restoreGate={{ blocked: false }}
      />,
    );
    const blocked = screen.getByRole("button", { name: "Undo" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAccessibleDescription("Save or discard your changes first");
  });

  it("omits Undo for a write that made no backup", () => {
    renderAlerts(stubEditor({ lastWrite: { title: `${LABEL} saved`, backupTimestamp: null } }));
    expect(alertTitled(`${LABEL} saved`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("offers Undo after a discard", () => {
    const undoDiscard = vi.fn();
    const dismissDiscarded = vi.fn();
    renderAlerts(stubEditor({ discarded: ["core"], undoDiscard, dismissDiscarded }));
    const alert = alertTitled("Changes discarded");
    expect(alert).toHaveClass("pf-m-info");
    fireEvent.click(within(alert).getByRole("button", { name: "Undo" }));
    expect(undoDiscard).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: closeNamed("Changes discarded") }));
    expect(dismissDiscarded).toHaveBeenCalledTimes(1);
    sweepA11y();
  });

  it("shows an outside notice whose Show changes reveals the list", () => {
    const dismissOutsideNotice = vi.fn();
    renderAlerts(stubEditor({
      outsideNotice: { at: new Date(2026, 9, 2, 14, 5), changes: ["Enabled [multilib]"] },
      dismissOutsideNotice,
    }));
    const alert = alertTitled(new RegExp(`^Info alert:${escape(LABEL)} changed at `));
    const toggle = within(alert).getByRole("button", { name: "Show changes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(alert).getByText("Enabled [multilib]")).not.toBeVisible();
    sweepA11y();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide changes");
    expect(within(alert).getByText("Enabled [multilib]")).toBeVisible();
    fireEvent.click(within(alert).getByRole("button", { name: new RegExp(`^Close .*alert: ${escape(LABEL)} changed at `) }));
    expect(dismissOutsideNotice).toHaveBeenCalledTimes(1);
    sweepA11y();
  });

  it("explains an outside change in lines the table does not show", () => {
    renderAlerts(stubEditor({ outsideNotice: { at: new Date(), changes: [] } }));
    expect(screen.queryByRole("button", { name: "Show changes" })).not.toBeInTheDocument();
    expect(screen.getByText(/such as comments or options/)).toBeInTheDocument();
    sweepA11y();
  });
});

describe("ConfigPendingChanges", () => {
  it("lists pending changes and Discard calls onDiscard", () => {
    const onDiscard = vi.fn();
    render(
      <ConfigPendingChanges
        editor={stubEditor({ pendingChanges: ["Disabled [extra]", "Enabled [multilib]"], hasChanges: true })}
        renderText={() => "[core]\nInclude = /etc/pacman.d/mirrorlist"}
        textCaption="The repository sections as they will be saved."
        onDiscard={onDiscard}
      />,
    );
    expect(screen.getByRole("button", { name: "Pending changes (2)" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Disabled [extra]")).toBeVisible();
    expect(screen.getByText("Enabled [multilib]")).toBeVisible();
    sweepA11y();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("blocks Discard with a reason while the file is being written", () => {
    const onDiscard = vi.fn();
    render(
      <ConfigPendingChanges
        editor={stubEditor({ pendingChanges: ["Disabled [extra]"], hasChanges: true, lockReason: `${FILE} is being written` })}
        renderText={() => ""}
        textCaption=""
        onDiscard={onDiscard}
      />,
    );
    const discard = screen.getByRole("button", { name: "Discard changes" });
    expect(discard).toHaveAttribute("aria-disabled", "true");
    expect(discard).toHaveAccessibleDescription(`${FILE} is being written`);
    fireEvent.click(discard);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("renders nothing without pending changes", () => {
    const { container } = render(
      <ConfigPendingChanges editor={stubEditor()} renderText={() => ""} textCaption="" onDiscard={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("RestoreGuardModal", () => {
  function renderGuard(onConfirm = vi.fn(), onCancel = vi.fn()) {
    render(
      <RestoreGuardModal
        isOpen
        file={FILE}
        fileLabel={LABEL}
        changes={["Disabled [extra]"]}
        backupDate="2 Oct 2026, 14:05"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return { onConfirm, onCancel };
  }

  it("is named by its title and names each edit it drops", async () => {
    renderGuard();
    const dialog = screen.getByRole("dialog", { name: titled(`Restore ${LABEL} backup?`) });
    expect(within(dialog).getByText("Disabled [extra]")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("replaced with the backup from 2 Oct 2026, 14:05.");
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    sweepA11y({ dialogs: [titled(`Restore ${LABEL} backup?`)] });
  });

  it("calls through on confirm and on cancel", () => {
    const { onConfirm, onCancel } = renderGuard();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes and restore" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

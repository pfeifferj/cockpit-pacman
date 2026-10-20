import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfigReconciliationModal } from "./ConfigReconciliationModal";
import * as api from "../api";
import { mockPermission } from "../test/setup";

vi.mock("../api", async () => ({
  ...await vi.importActual<typeof import("../api")>("../api"),
  getPacnewStatus: vi.fn(), previewPacnew: vi.fn(), resolvePacnew: vi.fn(),
  getActiveTransaction: vi.fn(() => null), onActiveTransactionChanged: vi.fn(() => () => {}),
}));

const file: api.PacnewFile = { path: "/etc/example.conf.pacnew", package: "example", kind: "pacnew", mtime: 1 };
const preview: api.PacnewPreview = {
  path: file.path, current_path: "/etc/example.conf", kind: "pacnew",
  revision: "opaque-pair-revision", current_content: "setting=local\n", pending_content: "setting=new\n",
};
const response: api.PacnewResolveResponse = {
  success: true, message: "Configuration resolved", backup_paths: ["/etc/.example.conf.backup"], warnings: [],
};
const close = vi.fn();
const scanned = vi.fn();

async function mount(files = [file]) {
  await act(async () => { render(<ConfigReconciliationModal files={files} onClose={close} onScanned={scanned} />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPermission.mockReturnValue({ allowed: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() });
  vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: true, files: [file] });
  vi.mocked(api.previewPacnew).mockResolvedValue(preview);
  vi.mocked(api.resolvePacnew).mockResolvedValue(response);
  vi.mocked(api.getActiveTransaction).mockReturnValue(null);
});
afterEach(cleanup);

describe("configuration reconciliation", () => {
  it("keeps the preview when its selected option is selected again", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Configuration file"), { target: { value: file.path } });
    expect(screen.getByRole("button", { name: "Use new version" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Configuration changes")).toBeInTheDocument();
  });

  it("shows a diff and sends the opaque revision when choosing the pending version", async () => {
    await mount();
    expect(screen.getByText("(example)", { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText("Configuration changes")).toHaveTextContent("− setting=local");
    expect(screen.getByLabelText("Configuration changes")).toHaveTextContent("+ setting=new");
    vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: false, files: [] });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use new version" })); });
    expect(api.resolvePacnew).toHaveBeenCalledWith({ path: file.path, revision: preview.revision, resolution: "use_pending" });
    expect(scanned).toHaveBeenLastCalledWith({ has_pacnew: false, files: [] });
    expect(screen.getByText("/etc/.example.conf.backup")).toBeInTheDocument();
    expect(screen.getByText("No configuration files need review.")).toBeInTheDocument();
  });

  it("keeps the current file with a separate resolution", async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep current" })); });
    expect(api.resolvePacnew).toHaveBeenCalledWith({ path: file.path, revision: preview.revision, resolution: "keep_current" });
  });

  it("ignores an initial scan that finishes after a successful resolution", async () => {
    let finishScan!: (value: api.PacnewStatus) => void;
    vi.mocked(api.getPacnewStatus).mockReturnValueOnce(new Promise(resolve => { finishScan = resolve; }));
    await mount();
    vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: false, files: [] });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep current" })); });
    await act(async () => { finishScan({ has_pacnew: true, files: [file] }); });
    expect(screen.getByText("No configuration files need review.")).toBeInTheDocument();
    expect(api.previewPacnew).toHaveBeenCalledTimes(1);
  });

  it("explains absent-current pacsave restoration without claiming it is a new version", async () => {
    vi.mocked(api.previewPacnew).mockResolvedValue({ ...preview, kind: "pacsave", current_content: null });
    await mount();
    expect(screen.getByText("There is no current file")).toBeInTheDocument();
    expect(screen.getByText(/Keeping the current state leaves this path absent/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore saved version" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use new version" })).not.toBeInTheDocument();
  });

  it("saves edited text exactly and preserves CRLF line endings", async () => {
    vi.mocked(api.previewPacnew).mockResolvedValue({ ...preview, current_content: "setting=local\r\n" });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "setting=merged\nother=yes\n" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save merge" })); });
    expect(api.resolvePacnew).toHaveBeenCalledWith({
      path: file.path, revision: preview.revision, resolution: "save_merged", merged_content: "setting=merged\r\nother=yes\r\n",
    });
  });

  it("retains an edited merge after a stale error and an explicit reload", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "my merge\n" } });
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new api.BackendError("Changed outside Cockpit", "config_changed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save merge" })); });
    expect(screen.getByLabelText("Merged configuration")).toHaveValue("my merge\n");
    expect(screen.getByRole("button", { name: "Save merge" })).toHaveAttribute("aria-disabled", "true");
    vi.mocked(api.previewPacnew).mockResolvedValue({ ...preview, revision: "new-revision", current_content: "external edit\n" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload files" })); });
    expect(screen.getByLabelText("Merged configuration")).toHaveValue("my merge\n");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save merge" })); });
    expect(api.resolvePacnew).toHaveBeenLastCalledWith({
      path: file.path, revision: "new-revision", resolution: "save_merged", merged_content: "my merge\n",
    });
  });

  it("drops a pending discard prompt once a retried save applies", async () => {
    const other = { ...file, path: "/etc/other.conf.pacnew" };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "my merge\n" } });
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new Error("Write failed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save merge" })); });
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Use new version" }));
    expect(screen.getByText("Discard your unsaved edits?")).toBeInTheDocument();
    vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: true, files: [other] });
    vi.mocked(api.previewPacnew).mockResolvedValue({ ...preview, path: other.path, revision: "other-revision" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(api.resolvePacnew).toHaveBeenLastCalledWith({
      path: file.path, revision: preview.revision, resolution: "save_merged", merged_content: "my merge\n",
    });
    expect(screen.getByLabelText("Configuration file")).toHaveValue(other.path);
    expect(screen.queryByText("Discard your unsaved edits?")).not.toBeInTheDocument();
  });

  it("cancels a failed merge's retry once the draft changes", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "complete draft\n" } });
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new Error("Write failed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save merge" })); });
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "complete dra" } });
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(api.resolvePacnew).toHaveBeenCalledOnce();
  });

  it("cancels a failed choice's retry once a merge is typed", async () => {
    await mount();
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new Error("Write failed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep current" })); });
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "typed merge\n" } });
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(api.resolvePacnew).toHaveBeenCalledOnce();
  });

  it("initializes another file correctly after a failed reload and discarded edits", async () => {
    const other = { ...file, path: "/etc/other.conf.pacnew" };
    vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: true, files: [file, other] });
    await mount([file, other]);
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "unsaved" } });
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new api.BackendError("Stale", "config_changed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save merge" })); });
    vi.mocked(api.previewPacnew).mockRejectedValueOnce(new Error("Read failed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload files" })); });
    fireEvent.change(screen.getByLabelText("Configuration file"), { target: { value: other.path } });
    vi.mocked(api.previewPacnew).mockResolvedValue({ ...preview, path: other.path, current_content: "other contents\n" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard edits" })); });
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    expect(screen.getByLabelText("Merged configuration")).toHaveValue("other contents\n");
  });

  it("requires confirmation before closing with unsaved edits", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "unsaved" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]);
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(screen.getByLabelText("Merged configuration")).toHaveValue("unsaved");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]);
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("blocks close and page reload while a write is pending", async () => {
    let finish!: (value: api.PacnewResolveResponse) => void;
    vi.mocked(api.resolvePacnew).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Use new version" }));
    expect(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]).toBeDisabled();
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    await act(async () => { finish(response); });
  });

  it("does not read protected contents without administrative access", async () => {
    mockPermission.mockReturnValue({ allowed: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() });
    await mount();
    expect(api.previewPacnew).not.toHaveBeenCalled();
    expect(api.getPacnewStatus).not.toHaveBeenCalled();
    expect(api.resolvePacnew).not.toHaveBeenCalled();
  });

  it("preserves edited text when administrative access is toggled", async () => {
    const permission = { allowed: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() };
    mockPermission.mockReturnValue(permission);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "keep my edits\n" } });
    const changed = permission.addEventListener.mock.calls[0][1] as () => void;
    await act(async () => { permission.allowed = false; changed(); });
    await act(async () => { permission.allowed = true; changed(); });
    expect(screen.getByLabelText("Merged configuration")).toHaveValue("keep my edits\n");
  });

  it("keeps a stale preview blocked when administrative access is toggled", async () => {
    const permission = { allowed: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() };
    mockPermission.mockReturnValue(permission);
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new api.BackendError("Configuration changed", "config_changed"));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep current" })); });
    const changed = permission.addEventListener.mock.calls[0][1] as () => void;
    await act(async () => { permission.allowed = false; changed(); });
    await act(async () => { permission.allowed = true; changed(); });
    expect(screen.getByRole("button", { name: "Keep current" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload files" })); });
    expect(screen.getByRole("button", { name: "Keep current" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("retries a failed write even while the operation gate is still closing", async () => {
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new Error("Write failed"));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep current" })); });
    vi.mocked(api.getActiveTransaction).mockReturnValue({ command: "external", target: "pacman", startedAt: 1 });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(api.resolvePacnew).toHaveBeenCalledTimes(2);
  });

  it("refuses to edit files with mixed line endings", async () => {
    vi.mocked(api.previewPacnew).mockResolvedValue({ ...preview, current_content: "a=1\r\nb=2\n" });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    expect(screen.getByRole("heading", { name: /Merge this file manually/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Merged configuration")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save merge" })).toHaveAttribute("aria-disabled", "true");
  });

  it("moves focus to the discard prompt", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "edited\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep current" }));
    expect(screen.getByRole("button", { name: "Discard edits and keep current" })).toHaveFocus();
  });

  it("blocks writes while another package operation runs", async () => {
    vi.mocked(api.getActiveTransaction).mockReturnValue({ command: "external", target: "pacman", startedAt: 1 });
    await mount();
    const use = screen.getByRole("button", { name: "Use new version" });
    expect(use).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(use);
    expect(api.resolvePacnew).not.toHaveBeenCalled();
  });

  it("keeps cleanup warnings visible after applying a configuration", async () => {
    vi.mocked(api.resolvePacnew).mockResolvedValue({ ...response, warnings: ["Saved, but the pending file could not be removed"] });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use new version" })); });
    expect(screen.getByText("Saved, but the pending file could not be removed")).toBeInTheDocument();
    expect(screen.getByText("/etc/.example.conf.backup")).toBeInTheDocument();
  });

  it("points files outside /etc to manual review without reading them", async () => {
    const outside = { ...file, path: "/var/named/localhost.zone.pacnew", package: "bind" };
    vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: true, files: [outside] });
    await mount([outside]);
    expect(api.previewPacnew).not.toHaveBeenCalled();
    expect(screen.getByText("Review this file manually")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use new version" })).not.toBeInTheDocument();
  });

  it("suggests manual review when a file cannot be compared here", async () => {
    vi.mocked(api.previewPacnew).mockRejectedValue(new api.BackendError("example.conf.pacnew is a symbolic link", "validation_error"));
    await mount();
    expect(screen.getByText("Could not read the configuration")).toBeInTheDocument();
    expect(screen.getByText(/Review this file manually, for example with pacdiff/)).toBeInTheDocument();
  });

  it("rescans the file list when reloading after a change", async () => {
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new api.BackendError("Configuration changed", "config_changed"));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep current" })); });
    const other = { ...file, path: "/etc/other.conf.pacnew" };
    vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: true, files: [file, other] });
    const scans = vi.mocked(api.getPacnewStatus).mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload files" })); });
    expect(api.getPacnewStatus).toHaveBeenCalledTimes(scans + 1);
    expect(screen.getByRole("option", { name: other.path })).toBeInTheDocument();
  });

  it("titles a later read failure by its own cause after a stale save", async () => {
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new api.BackendError("Configuration changed", "config_changed"));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep current" })); });
    expect(screen.getByText("The configuration changed")).toBeInTheDocument();
    vi.mocked(api.previewPacnew).mockRejectedValueOnce(new Error("Read failed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload files" })); });
    expect(screen.getByText("Could not read the configuration")).toBeInTheDocument();
    expect(screen.queryByText("The configuration changed")).not.toBeInTheDocument();
  });

  it("names the write that discarding edits continues with", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep current" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard edits and keep current" })); });
    expect(api.resolvePacnew).toHaveBeenCalledWith({ path: file.path, revision: preview.revision, resolution: "keep_current" });
  });

  it("keeps the administrative scan when a write fails before it finishes", async () => {
    let finishScan!: (value: api.PacnewStatus) => void;
    vi.mocked(api.getPacnewStatus).mockReturnValueOnce(new Promise(resolve => { finishScan = resolve; }));
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new Error("Write failed"));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep current" })); });
    const other = { ...file, path: "/etc/other.conf.pacnew" };
    await act(async () => { finishScan({ has_pacnew: true, files: [file, other] }); });
    expect(screen.getByText("Could not apply the choice")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: other.path })).toBeInTheDocument();
  });

  it("keeps a dirty selected file when the initial scan no longer lists it", async () => {
    let finishScan!: (value: api.PacnewStatus) => void;
    vi.mocked(api.getPacnewStatus).mockReturnValueOnce(new Promise(resolve => { finishScan = resolve; }));
    const other = { ...file, path: "/etc/other.conf.pacnew" };
    vi.mocked(api.previewPacnew).mockImplementation(async path => ({ ...preview, path, current_content: path === file.path ? preview.current_content : "other contents\n" }));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "my unsaved merge\n" } });

    await act(async () => { finishScan({ has_pacnew: true, files: [other] }); });

    expect(screen.getByLabelText("Configuration file")).toHaveValue(file.path);
    expect(screen.getByLabelText("Merged configuration")).toHaveValue("my unsaved merge\n");
    expect(api.previewPacnew).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Configuration file"), { target: { value: other.path } });
    expect(screen.getByText("Discard your unsaved edits?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(screen.getByLabelText("Configuration file")).toHaveValue(file.path);
    expect(screen.getByLabelText("Merged configuration")).toHaveValue("my unsaved merge\n");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save merge" })); });
    expect(api.resolvePacnew).toHaveBeenCalledWith({ path: file.path, revision: preview.revision, resolution: "save_merged", merged_content: "my unsaved merge\n" });
  });

  it.each([false, true])("keeps a stale draft after its pending file disappears (other files remain: %s)", async anotherRemains => {
    const other = { ...file, path: "/etc/other.conf.pacnew" };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit merged result" }));
    fireEvent.change(screen.getByLabelText("Merged configuration"), { target: { value: "recover my merge\n" } });
    vi.mocked(api.resolvePacnew).mockRejectedValueOnce(new api.BackendError("Configuration changed", "config_changed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save merge" })); });
    vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: anotherRemains, files: anotherRemains ? [other] : [] });
    vi.mocked(api.previewPacnew).mockImplementation(async path => {
      if (path === file.path) throw new api.BackendError("The pending file was removed", "not_found");
      return { ...preview, path, current_content: "other contents\n" };
    });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload files" })); });

    expect(screen.getByLabelText("Configuration file")).toHaveValue(file.path);
    expect(screen.getByLabelText("Merged configuration")).toHaveValue("recover my merge\n");
    expect(screen.getByText("Could not read the configuration")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save merge" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("No configuration files need review.")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]);
    expect(screen.getByText("Discard your unsaved edits?")).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
  });

  it("clears the previous preview when selecting a file outside /etc", async () => {
    const outside = { ...file, path: "/var/named/localhost.zone.pacnew", package: "bind" };
    vi.mocked(api.getPacnewStatus).mockResolvedValue({ has_pacnew: true, files: [file, outside] });
    await mount([file, outside]);
    await act(async () => { fireEvent.change(screen.getByLabelText("Configuration file"), { target: { value: outside.path } }); });

    expect(screen.getByLabelText("Configuration file")).toHaveValue(outside.path);
    expect(screen.getByText("Review this file manually")).toBeInTheDocument();
    expect(screen.queryByLabelText("Configuration changes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use new version" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep current" })).not.toBeInTheDocument();
    expect(api.previewPacnew).toHaveBeenCalledTimes(1);
    expect(api.resolvePacnew).not.toHaveBeenCalled();
  });
});

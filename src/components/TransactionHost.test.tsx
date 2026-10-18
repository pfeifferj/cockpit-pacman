import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useState } from "react";
import { render, screen, fireEvent, act, cleanup, waitFor, within } from "@testing-library/react";
import { TransactionHost, TransactionHostProvider } from "./TransactionHost";
import { TransactionBanner } from "./TransactionBanner";
import { PackageActionModal, installConfig } from "./PackageActionModal";
import * as api from "../api";
import { mutationGate } from "../hooks/useMutationGate";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { mockSpawn } from "../test/setup";
import { createMockStreamingProcess } from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    checkUpdates: vi.fn().mockResolvedValue({ updates: [], warnings: [] }),
  };
});

const preview: api.TransactionPreview = {
  success: true,
  add: [{ name: "vim", version: "9.1-1", repo: "extra", download_size: 1, installed_size: 1, reason: "target" }],
  remove: [],
  conflicts: [],
  replacements: [],
  providers: [],
  import_keys: [],
  warnings: [],
  blocked_by: [],
  total_download_size: 1,
  net_installed_size: 1,
};

const config = { ...installConfig, preview: () => Promise.resolve(preview) };

const Launcher: React.FC<{ dialog: (onClose: () => void) => React.ReactNode }> = ({ dialog }) => {
  const [open, setOpen] = useState(true);
  return open ? <>{dialog(() => setOpen(false))}</> : null;
};

function renderPage(dialog: (onClose: () => void) => React.ReactNode) {
  return render(
    <AnnouncerProvider>
      <TransactionHostProvider>
        <TransactionBanner activeSlug="search" activeOptions={{}} onNavigate={vi.fn()} />
        <TransactionHost />
        <Launcher dialog={dialog} />
      </TransactionHostProvider>
    </AnnouncerProvider>,
  );
}

function spawnProcess() {
  const proc = createMockStreamingProcess();
  const close = vi.spyOn(proc, "close");
  const input = vi.spyOn(proc, "input");
  mockSpawn.mockReturnValueOnce(proc);
  return { proc, close, input };
}

const emit = (proc: ReturnType<typeof createMockStreamingProcess>, event: object) =>
  act(() => {
    proc._emit(JSON.stringify(event) + "\n");
    if ("type" in event && event.type === "complete") proc._complete();
  });

async function backgroundInstall() {
  const spawned = spawnProcess();
  renderPage((onClose) => (
    <PackageActionModal packageName="vim" packageVersion="9.1-1" isOpen onClose={onClose} config={config} />
  ));
  fireEvent.click(await screen.findByRole("button", { name: "Install vim" }));
  emit(spawned.proc, { type: "log", level: "info", message: "fetching vim" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));
  });
  return spawned;
}

describe("TransactionHost", () => {
  let finish: (() => void) | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    finish = undefined;
  });

  afterEach(() => {
    finish?.();
    cleanup();
  });

  it("keeps a backgrounded install running and the gate blocked after its dialog unmounts", async () => {
    const { proc, close, input } = await backgroundInstall();
    finish = () => emit(proc, { type: "complete", success: true });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(api.getActiveTransaction()?.command).toBe("install-package");
    expect(mutationGate("install packages", true, api.getActiveTransaction()).blocked).toBe(true);
    expect(screen.getByText("Installing vim is running")).toBeInTheDocument();
  });

  it("moves focus to View progress, which reopens the same run with its log", async () => {
    const { proc } = await backgroundInstall();
    finish = () => emit(proc, { type: "complete", success: true });
    const viewProgress = screen.getByRole("button", { name: "View progress" });
    await waitFor(() => expect(viewProgress).toHaveFocus());

    emit(proc, { type: "log", level: "info", message: "installing vim" });
    fireEvent.click(viewProgress);

    const dialog = screen.getByRole("dialog", { name: "Install vim" });
    expect(await within(dialog).findByText(/fetching vim/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/installing vim/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Run in background" })).toBeInTheDocument();
  });

  it("cancels from the reopened dialog through the same handle", async () => {
    const { proc, input } = await backgroundInstall();
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop installing vim" }));
    expect(input).toHaveBeenCalledWith("cancel\n", true);

    emit(proc, { type: "complete", success: false, message: "cancelled" });
    expect(screen.getByRole("dialog", { name: "Install vim" })).toBeInTheDocument();
    expect(api.getActiveTransaction()).toBeNull();
  });

  it("shows the outcome of a run that ends in the background and reopens its result", async () => {
    const { proc } = await backgroundInstall();
    emit(proc, { type: "complete", success: true });

    expect(screen.queryByText("Installing vim is running")).not.toBeInTheDocument();
    expect(screen.getByText("Install vim finished")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View result" }));
    const dialog = screen.getByRole("dialog", { name: "Install vim" });
    expect(within(dialog).getByText("Package installed")).toBeInTheDocument();

    const buttons = within(dialog).getAllByRole("button", { name: "Close" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Install vim finished")).not.toBeInTheDocument();
  });

  it("names a failed background run and lets it be dismissed", async () => {
    const { proc } = await backgroundInstall();
    emit(proc, { type: "complete", success: false, message: "target not found: vim" });

    expect(screen.getByText("Install vim failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Close .*alert/i }));
    expect(screen.queryByText("Install vim failed")).not.toBeInTheDocument();
  });



});

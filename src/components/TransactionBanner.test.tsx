import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { TransactionBanner, useTransactionAnnouncements } from "./TransactionBanner";
import {
  runUpgrade,
  removeOrphans,
  installPackage,
  cleanCache,
  getActiveTransaction,
  getTransactionOutcome,
  dismissTransactionOutcome,
  refreshExternalLockHolder,
  type StreamingHandle,
} from "../api";
import { mockSpawn } from "../test/setup";
import { createMockSpawnPromise, createMockStreamingProcess } from "../test/mocks";
import type { RouteOptions } from "../hooks/useRoute";
import { sweepA11y } from "../test/a11ySweep";

const announce = vi.hoisted(() => vi.fn());
vi.mock("../contexts/AnnouncerContext", () => ({ useAnnounce: () => announce }));

const noop = { onComplete: vi.fn(), onError: vi.fn() };

const end = (proc: ReturnType<typeof createMockStreamingProcess>, success: boolean) =>
  act(() => (proc._emit(JSON.stringify({ type: "complete", success, message: success ? undefined : "failed" }) + "\n"), proc._complete()));

const lockStatus = (process?: string) =>
  createMockSpawnPromise(JSON.stringify({
    locked: process !== undefined, stale: false, lock_path: "/var/lib/pacman/db.lck", holder_unknown: false,
    ...(process ? { blocking_process: process } : {}),
  }));

function start(run: () => void) {
  const proc = createMockStreamingProcess();
  mockSpawn.mockReturnValueOnce(proc);
  act(run);
  return () => act(() => (proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n"), proc._complete()));
}

describe("TransactionBanner", () => {
  let finish: (() => void) | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    announce.mockReset();
    dismissTransactionOutcome();
    finish = undefined;
  });

  afterEach(() => {
    finish?.();
    cleanup();
  });

  it("renders nothing while idle", () => {
    const { container } = render(<TransactionBanner activeSlug="cache" activeOptions={{}} onNavigate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hides on the owner tab and shows with the label elsewhere", () => {
    finish = start(() => { runUpgrade(noop); });
    const onNavigate = vi.fn();
    const { rerender } = render(<TransactionBanner activeSlug="updates" activeOptions={{}} onNavigate={onNavigate} />);
    expect(screen.queryByText("An upgrade is running")).not.toBeInTheDocument();

    rerender(<TransactionBanner activeSlug="cache" activeOptions={{}} onNavigate={onNavigate} />);
    expect(screen.getByText("An upgrade is running")).toBeInTheDocument();
    sweepA11y();
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(onNavigate).toHaveBeenCalledWith("updates", undefined);
  });

  it("disappears when the transaction ends", () => {
    finish = start(() => { runUpgrade(noop); });
    render(<TransactionBanner activeSlug="history" activeOptions={{}} onNavigate={vi.fn()} />);
    expect(screen.getByText("An upgrade is running")).toBeInTheDocument();
    finish();
    finish = undefined;
    expect(screen.queryByText("An upgrade is running")).not.toBeInTheDocument();
  });

  it("routes orphan removal to the orphan filter and hides only there", () => {
    finish = start(() => { removeOrphans(noop); });
    const onNavigate = vi.fn();
    const { rerender } = render(
      <TransactionBanner activeSlug="installed" activeOptions={{ filter: "explicit" }} onNavigate={onNavigate} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(onNavigate).toHaveBeenCalledWith("installed", { filter: "orphan" });

    rerender(<TransactionBanner activeSlug="installed" activeOptions={{ filter: "orphan" }} onNavigate={onNavigate} />);
    expect(screen.queryByText("Orphan removal is running")).not.toBeInTheDocument();
  });

  it("offers no route for commands that run in a modal", () => {
    finish = start(() => { installPackage(noop, "vim"); });
    render(<TransactionBanner activeSlug="search" activeOptions={{}} onNavigate={vi.fn()} />);
    expect(screen.getByText("Installing vim is running")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View progress" })).not.toBeInTheDocument();
  });

  it("offers View progress through a reopen set on the running handle", () => {
    let handle: StreamingHandle | undefined;
    finish = start(() => { handle = installPackage(noop, "vim"); });
    const reopen = vi.fn();
    render(<TransactionBanner activeSlug="search" activeOptions={{}} onNavigate={vi.fn()} />);

    act(() => handle!.setReopen!(reopen));
    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(reopen).toHaveBeenCalledTimes(1);

    finish();
    finish = undefined;
    expect(getActiveTransaction()).toBeNull();
    act(() => handle!.setReopen!(vi.fn()));
    expect(getActiveTransaction()).toBeNull();
  });

  it("shows the fixed body copy and is not a live region", () => {
    finish = start(() => { runUpgrade(noop); });
    render(<TransactionBanner activeSlug="history" activeOptions={{}} onNavigate={vi.fn()} />);
    const title = screen.getByText("An upgrade is running");
    expect(screen.getByText(/Other package changes are unavailable until it finishes\./)).toBeInTheDocument();
    expect(title.closest("[aria-live]")).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the phase and percent of the run", async () => {
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    act(() => { runUpgrade(noop); });
    finish = () => end(proc, true);
    render(<TransactionBanner activeSlug="history" activeOptions={{}} onNavigate={vi.fn()} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    act(() => proc._emit(JSON.stringify({ type: "progress", operation: "upgrade_start", package: "a", percent: 100, current: 2, total: 4 }) + "\n"));
    const bar = await screen.findByRole("progressbar", { name: "Upgrading packages" });
    expect(bar).toHaveAttribute("aria-valuenow", "47");
    expect(screen.getByText("Upgrading packages")).toBeInTheDocument();
  });

  it("keeps a success outcome on other tabs until dismissed", () => {
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    act(() => { runUpgrade(noop); });
    const onNavigate = vi.fn();
    render(<TransactionBanner activeSlug="cache" activeOptions={{}} onNavigate={onNavigate} />);
    end(proc, true);

    expect(screen.getByText("Upgrade finished")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View result" }));
    expect(onNavigate).toHaveBeenCalledWith("updates", undefined);
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(screen.queryByText("Upgrade finished")).not.toBeInTheDocument();
    expect(getTransactionOutcome()).toBeNull();
  });

  it("shows a failed outcome as danger with View details", () => {
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    act(() => { cleanCache(noop, 2); });
    const { container } = render(<TransactionBanner activeSlug="updates" activeOptions={{}} onNavigate={vi.fn()} />);
    end(proc, false);

    expect(screen.getByText("Cache clean failed")).toBeInTheDocument();
    expect(container.querySelector(".pf-m-danger")).not.toBeNull();
    expect(screen.getByRole("button", { name: "View details" })).toBeInTheDocument();
  });

  it("shows no outcome for runs whose dialog reports it", () => {
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    act(() => { installPackage(noop, "vim"); });
    const { container } = render(<TransactionBanner activeSlug="search" activeOptions={{}} onNavigate={vi.fn()} />);
    end(proc, true);
    expect(container).toBeEmptyDOMElement();
  });

  it("names an outside lock holder without View progress", async () => {
    mockSpawn.mockReturnValueOnce(lockStatus("pacman (pid 42)"));
    await act(async () => { await refreshExternalLockHolder(); });
    render(<TransactionBanner activeSlug="updates" activeOptions={{}} onNavigate={vi.fn()} />);
    expect(screen.getByText("pacman (pid 42) is running")).toBeInTheDocument();
    expect(screen.getByText("Other package changes are unavailable until it finishes.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View progress" })).not.toBeInTheDocument();

    mockSpawn.mockReturnValueOnce(lockStatus());
    await act(async () => { await refreshExternalLockHolder(); });
    expect(screen.queryByText("pacman (pid 42) is running")).not.toBeInTheDocument();
  });
});

describe("useTransactionAnnouncements", () => {
  const Harness = ({ slug, options = {} }: { slug: string; options?: RouteOptions }) => {
    useTransactionAnnouncements(slug, options);
    return <TransactionBanner activeSlug={slug} activeOptions={options} onNavigate={vi.fn()} />;
  };

  beforeEach(() => {
    mockSpawn.mockReset();
    announce.mockReset();
    dismissTransactionOutcome();
  });

  afterEach(() => cleanup());

  it("announces start and end once each for a run owned by another tab", () => {
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    render(<Harness slug="history" />);
    act(() => { runUpgrade(noop); });
    act(() => proc._emit(JSON.stringify({ type: "progress", operation: "upgrade_start", package: "a", percent: 50, current: 1, total: 2 }) + "\n"));
    end(proc, true);
    expect(announce.mock.calls).toEqual([["An upgrade started"], ["Upgrade finished", { assertive: false }]]);
  });

  it("stays silent on the owner tab and dismisses the outcome there", () => {
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    render(<Harness slug="updates" />);
    act(() => { runUpgrade(noop); });
    end(proc, false);
    expect(announce).not.toHaveBeenCalled();
    expect(getTransactionOutcome()).toBeNull();
  });

  it("dismisses an outcome when the owner tab is visited", () => {
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    const { rerender } = render(<Harness slug="history" />);
    act(() => { runUpgrade(noop); });
    end(proc, false);
    expect(announce).toHaveBeenLastCalledWith("Upgrade failed", { assertive: true });
    expect(screen.getByText("Upgrade failed")).toBeInTheDocument();

    rerender(<Harness slug="updates" />);
    expect(getTransactionOutcome()).toBeNull();
    rerender(<Harness slug="history" />);
    expect(screen.queryByText("Upgrade failed")).not.toBeInTheDocument();
  });

  it("leaves dialog runs to their dialog", () => {
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    render(<Harness slug="search" />);
    act(() => { installPackage(noop, "vim"); });
    end(proc, true);
    expect(announce).not.toHaveBeenCalled();
  });

  it("announces an outside holder once across polls and when it finishes", async () => {
    render(<Harness slug="cache" />);
    for (let i = 0; i < 2; i++) {
      mockSpawn.mockReturnValueOnce(lockStatus("pacman (pid 42)"));
      await act(async () => { await refreshExternalLockHolder(); });
    }
    mockSpawn.mockReturnValueOnce(lockStatus());
    await act(async () => { await refreshExternalLockHolder(); });
    expect(announce.mock.calls).toEqual([["pacman (pid 42) is running"], ["pacman (pid 42) finished"]]);
  });
});

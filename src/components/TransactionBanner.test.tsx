import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import {
  TransactionBanner,
  describeRun,
  outsideRunText,
  upgradeWaitingText,
  useTransactionAnnouncements,
  type UpgradeWaiting,
} from "./TransactionBanner";
import {
  runUpgrade,
  removeOrphans,
  installPackage,
  cleanCache,
  getActiveTransaction,
  getTransactionOutcome,
  dismissTransactionOutcome,
  refreshExternalLockHolder,
  checkOutsideRun,
  dismissOutsideRun,
  getOutsideRun,
  type OutsideRun,
  type StreamingHandle,
} from "../api";
import { mockPermission, mockSpawn } from "../test/setup";
import { createMockSpawnPromise, createMockStreamingProcess } from "../test/mocks";
import type { RouteOptions } from "../hooks/useRoute";
import { sweepA11y } from "../test/a11ySweep";

const announce = vi.hoisted(() => vi.fn());
vi.mock("../contexts/AnnouncerContext", () => ({ useAnnounce: () => announce }));

const noop = { onComplete: vi.fn(), onError: vi.fn() };

const end = (proc: ReturnType<typeof createMockStreamingProcess>, success: boolean) =>
  act(() => { proc._emit(JSON.stringify({ type: "complete", success, message: success ? undefined : "failed" }) + "\n"); proc._complete(); });

const lockStatus = (process?: string) =>
  createMockSpawnPromise(JSON.stringify({
    locked: process !== undefined, stale: false, lock_path: "/var/lib/pacman/db.lck", holder_unknown: false,
    ...(process ? { blocking_process: process } : {}),
  }));

function start(run: () => void) {
  const proc = createMockStreamingProcess();
  mockSpawn.mockReturnValueOnce(proc);
  act(run);
  return () => act(() => { proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n"); proc._complete(); });
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
    finish = start(() => { removeOrphans(noop, ["libfoo"]); });
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

describe("outside runs", () => {
  type WatchCallback = (content: string | null, tag: string | null, error?: unknown) => void;
  const cockpitGlobal = globalThis as unknown as { cockpit: Record<string, unknown> };
  type Run = { start_time: string; command: string | null; origin: string };
  let newest: Run | null;
  let older: Run[];

  const at = (hours: number, minutes: number) => {
    const d = new Date();
    d.setHours(hours, minutes, 0, 0);
    return d;
  };
  const logTime = (d: Date) => {
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
      + `${sign}${pad(Math.trunc(offset / 60))}${pad(offset % 60)}`;
  };
  const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const Harness = ({ slug, onNavigate = vi.fn() }: { slug: string; onNavigate?: (slug: string) => void }) => {
    useTransactionAnnouncements(slug, {});
    return <TransactionBanner activeSlug={slug} activeOptions={{}} onNavigate={onNavigate} />;
  };

  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const publish = async (start: Date, command: string | null, origin = "pacman") => {
    newest = { start_time: logTime(start), command, origin };
    await act(async () => { await checkOutsideRun(); });
  };

  beforeEach(() => {
    announce.mockReset();
    dismissOutsideRun();
    dismissTransactionOutcome();
    newest = { start_time: logTime(at(0, 0)), command: "pacman -Syu", origin: "pacman" };
    older = [];
    cockpitGlobal.cockpit.file = vi.fn(() => ({
      read: vi.fn(),
      watch: (_cb: WatchCallback) => ({ remove: vi.fn() }),
      close: vi.fn(),
    }));
    mockSpawn.mockReset();
    mockSpawn.mockImplementation((args: string[]) => {
      if (args[1] === "check-lock") return lockStatus();
      if (args[1] === "history-grouped") {
        const groups = newest ? [newest, ...older].map((run) => ({
          id: `transaction-${run.start_time}`, entries: [], end_time: run.start_time, ...run,
          upgraded_count: 12, installed_count: 1, removed_count: 0, downgraded_count: 0, reinstalled_count: 0,
        })) : [];
        return createMockSpawnPromise(JSON.stringify({
          groups, total_groups: groups.length, total_upgraded: 0, total_installed: 0, total_removed: 0, total_other: 0,
        }));
      }
      return createMockStreamingProcess();
    });
  });

  afterEach(() => {
    cleanup();
    delete cockpitGlobal.cockpit.file;
  });

  it("names the command, time and counts, routes to History and dismisses", async () => {
    const onNavigate = vi.fn();
    render(<Harness slug="cache" onNavigate={onNavigate} />);
    await settle();
    expect(screen.queryByText(/ran in a terminal or another session/)).not.toBeInTheDocument();

    await publish(at(14, 2), "pacman -S htop");
    const text = `pacman -S htop ran in a terminal or another session at ${clock(at(14, 2))}: 12 upgraded, 1 installed`;
    expect(screen.getByText(text)).toBeInTheDocument();
    sweepA11y();

    fireEvent.click(screen.getByRole("button", { name: "View in History" }));
    expect(onNavigate).toHaveBeenCalledWith("history", { at: logTime(at(14, 2)) });
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(getOutsideRun()).toBeNull();
  });

  it("counts several runs since the oldest, routes to the oldest and announces once per merge", async () => {
    const onNavigate = vi.fn();
    render(<Harness slug="cache" onNavigate={onNavigate} />);
    await settle();
    older = [{ start_time: logTime(at(13, 30)), command: "pacman -Syu", origin: "pacman" }];
    await publish(at(14, 2), "pacman -S htop");
    const two = `2 transactions were recorded since ${clock(at(13, 30))}: 24 upgraded, 2 installed`;
    expect(screen.getByText(two)).toBeInTheDocument();

    older = [];
    await act(async () => { await checkOutsideRun(); });
    await publish(at(14, 10), "pacman -S tree");
    const three = `3 transactions were recorded since ${clock(at(13, 30))}: 36 upgraded, 3 installed`;
    expect(screen.getByText(three)).toBeInTheDocument();
    expect(screen.queryByText(two)).not.toBeInTheDocument();
    expect(announce.mock.calls).toEqual([[two], [three]]);

    fireEvent.click(screen.getByRole("button", { name: "View in History" }));
    expect(onNavigate).toHaveBeenCalledWith("history", { at: logTime(at(13, 30)) });
  });

  it("uses scheduled wording for a timer run", async () => {
    render(<Harness slug="cache" />);
    await settle();
    await publish(at(3, 0), "cockpit-pacman upgrade a", "scheduled");
    expect(screen.getByText(`Scheduled upgrade ran at ${clock(at(3, 0))}: 12 upgraded, 1 installed`)).toBeInTheDocument();
  });

  it("describes a Cockpit session's recorded action", async () => {
    render(<Harness slug="cache" />);
    await settle();
    await publish(at(14, 2), "cockpit-pacman install vim", "cockpit");
    expect(screen.getByText(`A Cockpit session installed vim at ${clock(at(14, 2))}: 12 upgraded, 1 installed`))
      .toBeInTheDocument();
    expect(screen.queryByText(/cockpit-pacman/)).not.toBeInTheDocument();
  });

  it("is announced once, politely", async () => {
    const { rerender } = render(<Harness slug="cache" />);
    await settle();
    await publish(at(14, 2), "pacman -S htop");
    rerender(<Harness slug="updates" />);
    await act(async () => { await checkOutsideRun(); });
    expect(announce.mock.calls).toEqual([
      [`pacman -S htop ran in a terminal or another session at ${clock(at(14, 2))}: 12 upgraded, 1 installed`],
    ]);
  });

  it("waits while this page's own run is shown and appears when it ends", async () => {
    render(<Harness slug="cache" />);
    await settle();
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    act(() => { runUpgrade(noop); });
    await publish(at(14, 2), "pacman -S htop");
    const text = `pacman -S htop ran in a terminal or another session at ${clock(at(14, 2))}: 12 upgraded, 1 installed`;
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(announce).not.toHaveBeenCalledWith(text);

    end(proc, true);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(announce.mock.calls.filter(([message]) => message === text)).toHaveLength(1);
  });

  it("is dismissed on History, which marks new groups itself", async () => {
    const { rerender } = render(<Harness slug="cache" />);
    await settle();
    await publish(at(14, 2), "pacman -S htop");
    rerender(<Harness slug="history" />);
    expect(getOutsideRun()).toBeNull();
    expect(screen.queryByText(/ran in a terminal or another session/)).not.toBeInTheDocument();
  });
});

describe("waiting upgrade line", () => {
  const MIB = 1024 ** 2;
  const text = "An upgrade is waiting for 200.0 MiB on /";
  const Harness = ({ slug, waiting, onBack = vi.fn(), onDismiss = vi.fn() }: {
    slug: string;
    waiting: UpgradeWaiting | null;
    onBack?: () => void;
    onDismiss?: () => void;
  }) => {
    useTransactionAnnouncements(slug, {}, waiting);
    return (
      <TransactionBanner
        activeSlug={slug}
        activeOptions={{}}
        onNavigate={vi.fn()}
        upgradeWaiting={waiting}
        onBackToUpgrade={onBack}
        onDismissUpgradeWaiting={onDismiss}
      />
    );
  };

  beforeEach(() => {
    mockSpawn.mockReset();
    announce.mockReset();
    dismissTransactionOutcome();
  });

  afterEach(() => cleanup());

  it("shows off Cache and Updates with Back to upgrade and Dismiss, announced once", () => {
    const waiting = { deficit: 200 * MIB, mount: "/" };
    const onBack = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(<Harness slug="cache" waiting={waiting} onBack={onBack} onDismiss={onDismiss} />);
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    rerender(<Harness slug="updates" waiting={waiting} onBack={onBack} onDismiss={onDismiss} />);
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(announce).not.toHaveBeenCalled();

    rerender(<Harness slug="installed" waiting={waiting} onBack={onBack} onDismiss={onDismiss} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    rerender(<Harness slug="history" waiting={waiting} onBack={onBack} onDismiss={onDismiss} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(announce.mock.calls).toEqual([[text]]);
    sweepA11y();

    fireEvent.click(screen.getByRole("button", { name: "Back to upgrade" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the waiting upgrade" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("waits while this page's own run is in progress and appears when it ends", () => {
    const waiting = { deficit: 200 * MIB, mount: "/" };
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    act(() => { removeOrphans(noop, ["libfoo"]); });
    render(<Harness slug="history" waiting={waiting} />);
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(announce).not.toHaveBeenCalledWith(text);

    end(proc, true);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(announce.mock.calls.filter(([message]) => message === text)).toHaveLength(1);
  });

  it("gates Back to upgrade on administrative access, with a reason", () => {
    mockPermission.mockImplementationOnce(() => ({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    }));
    const onBack = vi.fn();
    render(<Harness slug="installed" waiting={{ deficit: 200 * MIB, mount: "/" }} onBack={onBack} />);
    const back = screen.getByRole("button", { name: "Back to upgrade" });
    expect(back).toHaveAttribute("aria-disabled", "true");
    expect(back).toHaveAccessibleDescription(/administrative access/i);
    fireEvent.click(back);
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe("describeRun", () => {
  it.each([
    ["cockpit-pacman install vim", "Installed vim"],
    ["cockpit-pacman remove vim", "Removed vim"],
    ["cockpit-pacman upgrade a b", "Upgraded a and b"],
    ["cockpit-pacman upgrade a b c", "Upgraded a, b and c"],
    ["cockpit-pacman upgrade p0 p1 p2 p3 p4 and 3 more", "Upgraded p0, p1, p2, p3, p4 and 3 more"],
    ["cockpit-pacman upgrade", "Upgraded"],
    ["cockpit-pacman downgrade vim 1:9.0-1", "Downgraded vim to 1:9.0-1"],
    ["cockpit-pacman remove-orphans a b", "Removed orphan packages a and b"],
    ["cockpit-pacman frobnicate x", "Changed packages"],
    ["pacman -S vim", "Changed packages"],
    [null, "Changed packages"],
  ])("%s reads as %s", (command, text) => {
    expect(describeRun(command)).toBe(text);
  });
});

describe("upgradeWaitingText", () => {
  it.each([
    [{ deficit: 200 * 1024 * 1024, mount: "/" }, "An upgrade is waiting for 200.0 MiB on /"],
    [{ deficit: 1.5 * 1024 ** 3 + 1, mount: "/usr" }, "An upgrade is waiting for 1.51 GiB on /usr"],
    [{ deficit: 10, mount: "/var/cache" }, "An upgrade is waiting for 10 B on /var/cache"],
  ] as [UpgradeWaiting, string][])("%j reads %s", (waiting, text) => {
    expect(upgradeWaitingText(waiting)).toBe(text);
  });
});

describe("outsideRunText", () => {
  const today = (hours: number, minutes: number) => {
    const d = new Date();
    d.setHours(hours, minutes, 0, 0);
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    const offset = -d.getTimezoneOffset();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hours)}:${pad(minutes)}:00`
      + `${offset >= 0 ? "+" : "-"}${pad(Math.trunc(offset / 60))}${pad(offset % 60)}`;
    return { stamp, clock: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
  };
  const late = today(14, 2);
  const early = today(9, 30);
  const zero = { upgraded: 0, installed: 0, removed: 0, downgraded: 0, reinstalled: 0 };
  const run = (over: Partial<OutsideRun>): OutsideRun => ({
    startTime: late.stamp,
    firstStartTime: late.stamp,
    command: "pacman -S htop",
    origin: "pacman",
    counts: { ...zero, installed: 1 },
    runs: 1,
    ...over,
  });

  it.each([
    ["a terminal run", run({}), `pacman -S htop ran in a terminal or another session at ${late.clock}: 1 installed`],
    ["a run with no command", run({ command: null, origin: null }),
      `A transaction ran in a terminal or another session at ${late.clock}: 1 installed`],
    ["a scheduled run", run({ origin: "scheduled", command: null, counts: { ...zero, upgraded: 12 } }),
      `Scheduled upgrade ran at ${late.clock}: 12 upgraded`],
    ["another Cockpit session", run({ origin: "cockpit", command: "cockpit-pacman install vim" }),
      `A Cockpit session installed vim at ${late.clock}: 1 installed`],
    ["another Cockpit session with an unknown verb", run({ origin: "cockpit", command: null }),
      `A Cockpit session changed packages at ${late.clock}: 1 installed`],
    ["several runs, from the oldest", run({ runs: 3, firstStartTime: early.stamp, counts: { ...zero, upgraded: 12, installed: 2 } }),
      `3 transactions were recorded since ${early.clock}: 12 upgraded, 2 installed`],
    ["no counts", run({ counts: zero }), `pacman -S htop ran in a terminal or another session at ${late.clock}`],
    ["every count, in a fixed order", run({ counts: { reinstalled: 5, downgraded: 4, removed: 3, installed: 2, upgraded: 1 } }),
      `pacman -S htop ran in a terminal or another session at ${late.clock}: `
      + "1 upgraded, 2 installed, 3 removed, 4 downgraded, 5 reinstalled"],
  ] as [string, OutsideRun, string][])("%s", (_, value, text) => {
    expect(outsideRunText(value)).toBe(text);
  });
});

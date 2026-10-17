import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { PackageJump, DEBOUNCE_MS, parseQuery, type JumpTab } from "./PackageJump";
import { mockSpawn, mockPermission } from "../test/setup";
import * as api from "../api";
import type { ActiveTransaction, Package, SearchResult } from "../api";
import { sweepA11y } from "../test/a11ySweep";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getActiveTransaction: vi.fn(() => null),
    onActiveTransactionChanged: vi.fn(() => () => {}),
  };
});

const mockGetActiveTransaction = vi.mocked(api.getActiveTransaction);

function setPermission(allowed: boolean | null) {
  mockPermission.mockImplementation(() => ({
    allowed,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  }));
}

const TABS: JumpTab[] = [
  { slug: "updates", title: "Updates" },
  { slug: "installed", title: "Installed packages" },
  { slug: "keyring", title: "Keyring" },
];

function pkg(name: string, repository: string | null = "core", reason = "explicit"): Package {
  return { name, version: "1.0-1", description: null, installed_size: 1, install_date: 1, reason, repository };
}

function sync(name: string, repository = "core"): SearchResult {
  return { name, version: "1.0-1", description: null, repository, installed: false, installed_version: null };
}

interface Deferred {
  command: string;
  args: string[];
  resolve: (body: unknown) => void;
  close: ReturnType<typeof vi.fn>;
}

let calls: Deferred[];

function spawnPromise(): { promise: Promise<string> & Record<string, unknown>; resolve: (s: string) => void } {
  let resolve!: (s: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; }) as Promise<string> & Record<string, unknown>;
  promise.stream = () => promise;
  promise.close = () => {};
  promise.input = () => {};
  return { promise, resolve };
}

function installedResponse(packages: Package[]) {
  return { packages, total: packages.length, total_explicit: 0, total_dependency: 0, repositories: [], warnings: [] };
}

function searchResponse(results: SearchResult[]) {
  return { results, total: results.length, total_installed: 0, total_not_installed: results.length, repositories: [] };
}

async function settle(ms = DEBOUNCE_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function respond(query: string, installed: Package[], results: SearchResult[]) {
  for (const call of calls.filter((c) => c.args.includes(query))) {
    call.resolve(call.command === "list-installed" ? installedResponse(installed) : searchResponse(results));
  }
}

function type(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Go to package or tab" }), { target: { value } });
}

describe("PackageJump", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    setPermission(true);
    mockGetActiveTransaction.mockReturnValue(null);
    calls = [];
    mockSpawn.mockReset();
    mockSpawn.mockImplementation((argv: string[]) => {
      const { promise, resolve } = spawnPromise();
      const close = vi.fn();
      promise.close = close;
      calls.push({ close, command: argv[1], args: argv.slice(2), resolve: (body) => resolve(JSON.stringify(body)) });
      return promise;
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("has the documented name and example placeholder", () => {
    render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Go to package or tab" });
    expect(input).toHaveAttribute("placeholder", expect.stringContaining("e.g."));
  });

  it("closes superseded and unmounted package searches", async () => {
    const { unmount } = render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} />);
    type("vim");
    await settle();
    expect(calls).toHaveLength(2);
    const first = [...calls];
    type("linux");
    await settle();
    for (const call of first) expect(call.close).toHaveBeenCalledWith("cancelled");
    expect(calls).toHaveLength(4);
    unmount();
    for (const call of calls.slice(2)) expect(call.close).toHaveBeenCalledWith("cancelled");
    for (const call of calls) call.resolve(call.command === "list-installed" ? installedResponse([]) : searchResponse([]));
    await flush();
  });

  it("does not search below two characters", async () => {
    render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} />);
    type("l");
    await settle();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("renders Tabs, Installed and Repositories in order with no name in both package groups", async () => {
    const tabs = [...TABS, { slug: "linting", title: "Linting" }];
    render(<PackageJump tabs={tabs} onNavigate={vi.fn()} onInspect={vi.fn()} />);
    type("lin");
    await settle();
    respond("lin", [pkg("util-linux"), pkg("linux")], [sync("linux"), sync("linux-lts"), sync("archlinux-keyring")]);
    await flush();

    const groups = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(groups).toEqual(["Tabs", "Installed", "Repositories"]);

    const installed = within(screen.getByRole("menu", { name: "Installed" })).getAllByRole("menuitem");
    expect(installed.map((i) => i.textContent)).toEqual([
      expect.stringContaining("linux"),
      expect.stringContaining("util-linux"),
    ]);
    expect(installed[0].textContent?.startsWith("linux")).toBe(true);

    const repo = within(screen.getByRole("menu", { name: "Repositories" })).getAllByRole("menuitem");
    const repoNames = repo.map((i) => i.textContent ?? "");
    expect(repoNames[0].startsWith("linux-lts")).toBe(true);
    expect(repoNames[1].startsWith("archlinux-keyring")).toBe(true);
    expect(repoNames).toHaveLength(2);
  });

  it.each([
    [["zsh"], "1 match for zsh"],
    [["zsh", "zsh-completions"], "2 matches for zsh"],
  ])("announces the match count", async (names, announcement) => {
    render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} />);
    type("zsh");
    await settle();
    respond("zsh", names.map((n) => pkg(n)), []);
    await flush();
    expect(screen.getByText(announcement)).toBeInTheDocument();
  });

  it("ignores a response that resolves after a newer query", async () => {
    render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} />);
    type("li");
    await settle();
    type("lin");
    await settle();
    respond("lin", [pkg("linux")], []);
    await flush();
    respond("li", [pkg("libfoo")], []);
    await flush();

    const menu = screen.getByRole("menu", { name: "Installed" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([expect.stringContaining("linux")]);
    expect(screen.queryByText("libfoo")).not.toBeInTheDocument();
  });

  it("Enter inspects the top match and spawns only read commands", async () => {
    const onInspect = vi.fn();
    render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={onInspect} />);
    type("linux");
    await settle();
    respond("linux", [pkg("linux-firmware"), pkg("linux")], []);
    await flush();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Go to package or tab" }), { key: "Enter" });
    expect(onInspect).toHaveBeenCalledWith("linux", expect.objectContaining({ repo: undefined }));
    expect(screen.getByRole("textbox", { name: "Go to package or tab" })).toHaveValue("");

    const commands = new Set(mockSpawn.mock.calls.map(([argv]) => argv[1]));
    expect([...commands].sort()).toEqual(["list-installed", "search"]);
  });

  it("ArrowDown moves into the menu and Enter on a repository item passes its repo", async () => {
    const onInspect = vi.fn();
    render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={onInspect} />);
    type("linux-lts");
    await settle();
    respond("linux-lts", [], [sync("linux-lts", "core")]);
    await flush();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Go to package or tab" }), { key: "ArrowDown" });
    await act(async () => { vi.advanceTimersByTime(20); });
    const item = screen.getByRole("menuitem", { name: /linux-lts/ });
    expect(item).toHaveFocus();
    fireEvent.click(item);
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(onInspect).toHaveBeenCalledWith("linux-lts", expect.objectContaining({ repo: "core" }));
  });

  it("a tab item navigates to that tab's slug", async () => {
    const onNavigate = vi.fn();
    const onInspect = vi.fn();
    render(<PackageJump tabs={TABS} onNavigate={onNavigate} onInspect={onInspect} />);
    type("keyr");
    await settle();
    respond("keyr", [], []);
    await flush();

    fireEvent.click(screen.getByRole("menuitem", { name: /Keyring/ }));
    expect(onNavigate).toHaveBeenCalledWith("keyring");
    expect(onInspect).not.toHaveBeenCalled();
  });

  it.each(["list-installed", "search"])("keeps tab keyboard navigation available while %s is pending", async (pendingCommand) => {
    const onNavigate = vi.fn();
    const onInspect = vi.fn();
    render(<PackageJump tabs={TABS} onNavigate={onNavigate} onInspect={onInspect} />);
    type("keyr");
    await settle();

    expect(calls.map((call) => call.command)).toEqual(["list-installed", "search"]);
    const ready = calls.find((call) => call.command !== pendingCommand)!;
    ready.resolve(ready.command === "list-installed" ? installedResponse([]) : searchResponse([]));
    await flush();

    const input = screen.getByRole("textbox", { name: "Go to package or tab" });
    const tab = screen.getByRole("menuitem", { name: /Keyring/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await settle(20);
    expect(tab).toHaveFocus();

    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("keyring");
    expect(onInspect).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("Escape closes the menu, then a second Escape clears the field", async () => {
    render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Go to package or tab" });
    type("keyr");
    await settle();
    respond("keyr", [], []);
    await flush();
    expect(screen.getByRole("menuitem", { name: /Keyring/ })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    await settle(50);
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(input).toHaveValue("keyr");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
  });

  it("shows a group error when one backend search fails and keeps the other", async () => {
    render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} />);
    mockSpawn.mockImplementation((argv: string[]) => {
      const { promise, resolve } = spawnPromise();
      if (argv[1] === "search") {
        const failing = Promise.reject(new Error("boom")) as Promise<string> & Record<string, unknown>;
        failing.stream = () => failing;
        failing.close = () => {};
        failing.input = () => {};
        return failing;
      }
      resolve(JSON.stringify(installedResponse([pkg("linux")])));
      return promise;
    });
    type("linux");
    await settle();
    await flush();

    expect(screen.getByRole("menuitem", { name: /linux/ })).toBeInTheDocument();
    expect(within(screen.getByRole("menu", { name: "Repositories" })).getByRole("menuitem")).toBeDisabled();
  });

  describe("commands", () => {
    const input = () => screen.getByRole("textbox", { name: "Go to package or tab" });

    it("parses a verb only when a package term follows it", () => {
      expect(parseQuery("reinstall linux")).toEqual({ verb: "reinstall", term: "linux" });
      expect(parseQuery("Mark  vim")).toEqual({ verb: "mark", term: "vim" });
      expect(parseQuery("mark")).toEqual({ term: "mark" });
      expect(parseQuery("linux")).toEqual({ term: "linux" });
    });

    it("offers no command whose handler is absent", async () => {
      render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} />);
      type("check");
      await settle();
      respond("check", [], []);
      await flush();
      expect(screen.queryByRole("menu", { name: "Commands" })).not.toBeInTheDocument();
    });

    it("Enter runs Check for updates and nothing else", async () => {
      const onCheckUpdates = vi.fn();
      const onInspect = vi.fn();
      render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={onInspect} commands={{ onCheckUpdates }} />);
      type("check");
      await settle();
      respond("check", [pkg("checkpolicy")], []);
      await flush();

      const groups = screen.getAllByRole("heading").map((h) => h.textContent);
      expect(groups).toEqual(["Commands", "Installed"]);
      sweepA11y();
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(onCheckUpdates).toHaveBeenCalledTimes(1);
      expect(onInspect).not.toHaveBeenCalled();
      expect(input()).toHaveValue("");
    });

    it("a gated command shows its reason, stays focusable and does nothing", async () => {
      setPermission(false);
      const onCheckUpdates = vi.fn();
      render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} commands={{ onCheckUpdates }} />);
      type("check");
      await settle();
      respond("check", [], []);
      await flush();

      const item = screen.getByRole("menuitem", { name: /Check for updates/ });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveTextContent("Turn on administrative access to sync the package databases");
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      await settle(20);
      expect(item).toHaveFocus();
      fireEvent.click(item);
      input().focus();
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(onCheckUpdates).not.toHaveBeenCalled();
      expect(input()).toHaveValue("check");
    });

    it("Rank mirrors runs its handler", async () => {
      const onRankMirrors = vi.fn();
      render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} commands={{ onRankMirrors }} />);
      type("rank");
      await settle();
      respond("rank", [], []);
      await flush();
      fireEvent.click(screen.getByRole("menuitem", { name: /Rank mirrors/ }));
      expect(onRankMirrors).toHaveBeenCalledTimes(1);
    });

    it("View progress appears only while a transaction runs and goes to its view", async () => {
      const onNavigate = vi.fn();
      const { unmount } = render(<PackageJump tabs={TABS} onNavigate={onNavigate} onInspect={vi.fn()} />);
      type("progress");
      await settle();
      respond("progress", [], []);
      await flush();
      expect(screen.queryByRole("menuitem", { name: /View progress/ })).not.toBeInTheDocument();
      unmount();

      const running: ActiveTransaction = { command: "remove-orphans", startedAt: 0 };
      mockGetActiveTransaction.mockReturnValue(running);
      calls = [];
      render(<PackageJump tabs={TABS} onNavigate={onNavigate} onInspect={vi.fn()} />);
      type("progress");
      await settle();
      respond("progress", [], []);
      await flush();
      fireEvent.click(screen.getByRole("menuitem", { name: /View progress/ }));
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("installed", { filter: "orphan" });
    });

    it("reinstall <package> searches the package and offers Reinstall for repository packages only", async () => {
      const onReinstall = vi.fn();
      render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} commands={{ onReinstall }} />);
      type("reinstall linux");
      await settle();
      expect(calls.every((c) => c.args.includes("linux"))).toBe(true);
      respond("linux", [pkg("linux-foreign", null), pkg("linux")], []);
      await flush();

      const commands = within(screen.getByRole("menu", { name: "Commands" })).getAllByRole("menuitem");
      expect(commands.map((c) => c.textContent)).toEqual([expect.stringContaining("Reinstall linux")]);
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(onReinstall).toHaveBeenCalledExactlyOnceWith("linux", expect.objectContaining({ trigger: input() }));
    });

    it.each([
      ["dependency", "Mark vim as explicitly installed", "Installed as a dependency", "explicit"],
      ["explicit", "Mark vim as a dependency", "Installed explicitly", "dependency"],
    ] as const)("mark <package> on a %s package offers the menu's label", async (reason, title, description, next) => {
      const onSetInstallReason = vi.fn();
      render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} commands={{ onSetInstallReason }} />);
      type("mark vim");
      await settle();
      respond("vim", [pkg("vim", "extra", reason)], []);
      await flush();

      const commands = within(screen.getByRole("menu", { name: "Commands" })).getAllByRole("menuitem");
      expect(commands.map((c) => c.textContent)).toEqual([title + description]);
      fireEvent.click(commands[0]);
      expect(onSetInstallReason).toHaveBeenCalledExactlyOnceWith("vim", next, expect.anything());
    });

    it("package commands are blocked while another transaction runs", async () => {
      mockGetActiveTransaction.mockReturnValue({ command: "upgrade", startedAt: 0 });
      const onReinstall = vi.fn();
      render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} commands={{ onReinstall }} />);
      type("reinstall linux");
      await settle();
      respond("linux", [pkg("linux")], []);
      await flush();

      const item = screen.getByRole("menuitem", { name: /Reinstall linux/ });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveTextContent("An upgrade is running");
      fireEvent.click(item);
      expect(onReinstall).not.toHaveBeenCalled();
    });

    it("a verb prefix offers the verb and fills the field with it", async () => {
      render(<PackageJump tabs={TABS} onNavigate={vi.fn()} onInspect={vi.fn()} commands={{ onReinstall: vi.fn() }} />);
      type("rei");
      await settle();
      respond("rei", [], []);
      await flush();

      fireEvent.click(screen.getByRole("menuitem", { name: /Reinstall a package/ }));
      expect(input()).toHaveValue("reinstall ");
      expect(input()).toHaveFocus();
    });
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { LoadErrorState, RefreshFailedAlert, toLoadFailure } from "./LoadErrorState";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import * as api from "../api";
import { BackendError } from "../api";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  checkLock: vi.fn(),
}));

const mockCheckLock = vi.mocked(api.checkLock);

function announcements(ui: ReactElement) {
  const result = render(<AnnouncerProvider><div /></AnnouncerProvider>);
  const seen: string[] = [];
  const status = screen.getByRole("status");
  new MutationObserver(() => {
    if (status.textContent) seen.push(status.textContent);
  }).observe(status, { childList: true, characterData: true, subtree: true });
  result.rerender(<AnnouncerProvider>{ui}</AnnouncerProvider>);
  return { ...result, seen };
}

const flush = () => act(async () => { await Promise.resolve(); });

describe("LoadErrorState", () => {
  afterEach(() => cleanup());

  it("names what failed to load as a danger h2 with the cause, details and Try again", async () => {
    const onRetry = vi.fn();
    const { container, seen } = announcements(
      <LoadErrorState what="history" error="pacman.log unreadable" details="caused by: EACCES" onRetry={onRetry} />,
    );
    await flush();

    expect(screen.getByRole("heading", { level: 2, name: /Could not load history/ })).toBeInTheDocument();
    expect(screen.getByText("pacman.log unreadable")).toBeInTheDocument();
    expect(screen.getByText("caused by: EACCES")).toBeInTheDocument();
    expect(container.querySelector(".pf-v6-c-empty-state.pf-m-danger")).not.toBeNull();
    expect(seen).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("takes a lower heading level inside a card", () => {
    render(<LoadErrorState what="history" error="x" onRetry={() => {}} headingLevel="h3" />);
    expect(screen.getByRole("heading", { level: 3, name: /Could not load history/ })).toBeInTheDocument();
  });

  it("renders an action beside Try again", () => {
    render(
      <LoadErrorState
        what="mirrors"
        error="no mirrorlist"
        onRetry={() => {}}
        action={<button type="button">Rank mirrors</button>}
      />,
    );
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Try again", "Rank mirrors"]);
  });

  it("puts the action first and demotes Try again with retryVariant secondary", () => {
    render(
      <LoadErrorState
        what="mirrors"
        error="no mirrorlist"
        onRetry={() => {}}
        retryVariant="secondary"
        action={<button type="button">Rank mirrors</button>}
      />,
    );
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Rank mirrors", "Try again"]);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveClass("pf-m-secondary");
  });

  it("waits for a lock holder in place of the plain cause and hides Try again while waiting", async () => {
    mockCheckLock.mockResolvedValue({ locked: true, stale: false, blocking_process: "pacman", holder_unknown: false } as api.LockStatus);
    const onRetry = vi.fn();
    const { container, seen } = announcements(
      <LoadErrorState what="orphan packages" error="unable to lock database" code="database_locked" onRetry={onRetry} />,
    );

    expect(await screen.findByText(/Waiting for/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /Could not load orphan packages/ })).toBeInTheDocument();
    expect(screen.queryByText("unable to lock database")).not.toBeInTheDocument();
    expect(container.querySelector(".pf-v6-c-empty-state.pf-m-warning")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(seen).toEqual(["Could not load orphan packages. The package database is locked."]);

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("retries on its own when the lock is already free", async () => {
    mockCheckLock.mockResolvedValue({ locked: false, stale: false, holder_unknown: false } as api.LockStatus);
    const onRetry = vi.fn();
    render(<LoadErrorState what="free-lock check" error="unable to lock database" code="database_locked" onRetry={onRetry} />);
    expect(await screen.findByText("The database is no longer locked.")).toBeInTheDocument();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("falls back to a generic cause when the error is empty", () => {
    render(<LoadErrorState what="cache information" error={null} onRetry={() => {}} />);
    expect(screen.getByText("An unknown error occurred")).toBeInTheDocument();
  });
});

describe("RefreshFailedAlert", () => {
  afterEach(() => cleanup());

  it("names the refresh, keeps a Try again and a close, and announces once", async () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();
    const { rerender, seen } = announcements(
      <RefreshFailedAlert what="history" error="db busy" onRetry={onRetry} onClose={onClose} />,
    );
    await flush();

    expect(screen.getByRole("heading", { name: /Could not refresh history/ })).toBeInTheDocument();
    expect(screen.getByText("db busy")).toBeInTheDocument();
    expect(seen).toHaveLength(1);

    rerender(<AnnouncerProvider><RefreshFailedAlert what="history" error="db busy" onRetry={onRetry} onClose={onClose} /></AnnouncerProvider>);
    await flush();
    expect(seen).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("toLoadFailure", () => {
  it("keeps a backend error's code and details", () => {
    expect(toLoadFailure(new BackendError("boom", "not_found", "ctx"))).toEqual({ message: "boom", code: "not_found", details: "ctx" });
  });

  it("stringifies anything else", () => {
    expect(toLoadFailure("plain")).toEqual({ message: "plain", code: undefined, details: undefined });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { LockErrorBody, LOCK_POLL_MS, LOCK_WAIT_LIMIT_MS } from "./LockErrorBody";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return { ...actual, checkLock: vi.fn(), removeStaleLock: vi.fn() };
});

const mockCheckLock = vi.mocked(api.checkLock);

const held = { locked: true, stale: false, blocking_process: "pacman", holder_unknown: false } as api.LockStatus;
const free = { locked: false, stale: false, holder_unknown: false } as api.LockStatus;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function tick(ms = LOCK_POLL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderBody(props: Partial<ComponentProps<typeof LockErrorBody>> = {}) {
  const callbacks = { onRetry: vi.fn(), onAutoRetry: vi.fn(), onCleared: vi.fn(), ...props };
  render(
    <AnnouncerProvider>
      <LockErrorBody {...callbacks} />
    </AnnouncerProvider>
  );
  return callbacks;
}

describe("LockErrorBody", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCheckLock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls every 3 s while a live process holds the lock", async () => {
    mockCheckLock.mockResolvedValue(held);
    renderBody();
    await flush();
    expect(mockCheckLock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Waiting for/)).toBeInTheDocument();
    expect(screen.getByText("pacman")).toBeInTheDocument();

    await tick(LOCK_POLL_MS - 1);
    expect(mockCheckLock).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(mockCheckLock).toHaveBeenCalledTimes(2);
    await tick();
    expect(mockCheckLock).toHaveBeenCalledTimes(3);
  });

  it("retries once and announces when the lock is released", async () => {
    mockCheckLock.mockResolvedValueOnce(held).mockResolvedValueOnce(held).mockResolvedValue(free);
    const callbacks = renderBody();
    await flush();
    await tick();
    expect(callbacks.onAutoRetry).not.toHaveBeenCalled();
    await tick();
    expect(callbacks.onAutoRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Database lock released");

    await tick(LOCK_POLL_MS * 5);
    expect(mockCheckLock).toHaveBeenCalledTimes(3);
    expect(callbacks.onAutoRetry).toHaveBeenCalledTimes(1);
  });

  it("calls onReleased instead of onAutoRetry when given", async () => {
    mockCheckLock.mockResolvedValueOnce(held).mockResolvedValue(free);
    const onReleased = vi.fn();
    const callbacks = renderBody({ onReleased });
    await flush();
    await tick();
    expect(onReleased).toHaveBeenCalledTimes(1);
    expect(callbacks.onAutoRetry).not.toHaveBeenCalled();
  });

  it("stops polling on Stop waiting and keeps focus in the body", async () => {
    mockCheckLock.mockResolvedValue(held);
    const callbacks = renderBody();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    await flush();
    expect(screen.queryByRole("button", { name: "Stop waiting" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByText(/Wait for it to finish, then select Try again\./).closest("div"));

    await tick(LOCK_POLL_MS * 4);
    expect(mockCheckLock).toHaveBeenCalledTimes(1);
    expect(callbacks.onAutoRetry).not.toHaveBeenCalled();
  });

  it("gives up after 10 minutes", async () => {
    mockCheckLock.mockResolvedValue(held);
    const callbacks = renderBody();
    await flush();
    await tick(LOCK_WAIT_LIMIT_MS);
    expect(screen.getByText(/Still locked after 10 min\. .*select Try again once it finishes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop waiting" })).not.toBeInTheDocument();
    const calls = mockCheckLock.mock.calls.length;
    expect(calls).toBe(1 + LOCK_WAIT_LIMIT_MS / LOCK_POLL_MS);

    await tick(LOCK_POLL_MS * 4);
    expect(mockCheckLock).toHaveBeenCalledTimes(calls);
    expect(callbacks.onAutoRetry).not.toHaveBeenCalled();
  });

  it("retries at once without polling when no lock is found", async () => {
    mockCheckLock.mockResolvedValue(free);
    const callbacks = renderBody();
    await flush();
    expect(callbacks.onAutoRetry).toHaveBeenCalledTimes(1);
    await tick(LOCK_POLL_MS * 3);
    expect(mockCheckLock).toHaveBeenCalledTimes(1);
  });

  it("does not poll a stale lock", async () => {
    mockCheckLock.mockResolvedValue({ locked: true, stale: true, holder_unknown: false } as api.LockStatus);
    renderBody();
    await flush();
    expect(screen.getByRole("button", { name: "Remove stale lock and retry" })).toHaveClass("pf-m-secondary");
    await tick(LOCK_POLL_MS * 3);
    expect(mockCheckLock).toHaveBeenCalledTimes(1);
  });

  it("ticks the elapsed time every second", async () => {
    mockCheckLock.mockResolvedValue(held);
    renderBody();
    await flush();
    await tick(1000);
    expect(screen.getByText(/\(1 s\)/)).toBeInTheDocument();
    await tick(1000);
    expect(screen.getByText(/\(2 s\)/)).toBeInTheDocument();
    await tick(63_000);
    expect(screen.getByText(/\(1 min 5 s\)/)).toBeInTheDocument();
  });

  it("restarts polling on Keep waiting after a stop and moves focus to Stop waiting", async () => {
    mockCheckLock.mockResolvedValue(held);
    const callbacks = renderBody();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    await tick(LOCK_POLL_MS * 2);
    expect(mockCheckLock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop waiting" }));
    mockCheckLock.mockResolvedValue(free);
    await tick();
    expect(mockCheckLock).toHaveBeenCalledTimes(2);
    expect(callbacks.onAutoRetry).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh 10 minute round on Keep waiting after the time limit", async () => {
    mockCheckLock.mockResolvedValue(held);
    renderBody();
    await flush();
    await tick(LOCK_WAIT_LIMIT_MS);
    fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
    await flush();
    const calls = mockCheckLock.mock.calls.length;
    await tick(LOCK_WAIT_LIMIT_MS - LOCK_POLL_MS);
    expect(screen.getByRole("button", { name: "Stop waiting" })).toBeInTheDocument();
    await tick();
    expect(mockCheckLock).toHaveBeenCalledTimes(calls + LOCK_WAIT_LIMIT_MS / LOCK_POLL_MS);
    expect(screen.getByText(/Still locked after 20 min\./)).toBeInTheDocument();
  });

  it("names the host's retry control and reports each state", async () => {
    mockCheckLock.mockResolvedValue(held);
    const states: string[] = [];
    renderBody({ retryLabel: "Resume", onStateChange: (state) => states.push(state) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    await flush();
    expect(screen.getByText(/then select Resume\./)).toBeInTheDocument();
    expect(states).toEqual(["checking", "waiting", "stopped"]);
  });

  it("retries on its own once per key across remounts", async () => {
    mockCheckLock.mockResolvedValue(free);
    const first = renderBody({ retryKey: "guard-test" });
    await flush();
    expect(first.onAutoRetry).toHaveBeenCalledTimes(1);
    cleanup();

    const states: string[] = [];
    const second = renderBody({ retryKey: "guard-test", onStateChange: (state) => states.push(state) });
    await flush();
    expect(second.onAutoRetry).not.toHaveBeenCalled();
    expect(states[states.length - 1]).toBe("free");

    await tick(30_000);
    cleanup();
    const third = renderBody({ retryKey: "guard-test" });
    await flush();
    expect(third.onAutoRetry).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseTimestamp, formatRelativeTime, formatFullTimestamp, formatFullDate, subscribeToTick } from "./timeFormat";

describe("parseTimestamp", () => {
  it("returns null for null/undefined/empty", () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("  ")).toBeNull();
  });

  it("parses unix timestamp in seconds", () => {
    const date = parseTimestamp(1704067200);
    expect(date).toBeInstanceOf(Date);
    expect(date!.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("parses ISO 8601 string", () => {
    const date = parseTimestamp("2024-06-15T10:30:00Z");
    expect(date).toBeInstanceOf(Date);
    expect(date!.getUTCHours()).toBe(10);
  });

  it("parses ISO 8601 with compact offset", () => {
    const date = parseTimestamp("2025-01-21T14:23:45+0100");
    expect(date).toBeInstanceOf(Date);
    expect(date!.getUTCHours()).toBe(13);
  });

  it("parses systemd format", () => {
    const date = parseTimestamp("Wed 2026-01-21 22:03:15 CET");
    expect(date).toBeInstanceOf(Date);
    expect(date!.getFullYear()).toBe(2026);
    expect(date!.getMonth()).toBe(0);
    expect(date!.getDate()).toBe(21);
    expect(date!.getHours()).toBe(22);
  });

  it("parses date-only string", () => {
    const date = parseTimestamp("2020-01-15");
    expect(date).toBeInstanceOf(Date);
    expect(date!.getFullYear()).toBe(2020);
  });

  it("returns null for garbage input", () => {
    expect(parseTimestamp("not a date")).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows seconds ago for very recent times", () => {
    const date = new Date("2026-04-12T11:59:55Z");
    expect(formatRelativeTime(date)).toBe("5 seconds ago");
  });

  it("shows minutes ago", () => {
    const date = new Date("2026-04-12T11:45:00Z");
    expect(formatRelativeTime(date)).toBe("15 minutes ago");
  });

  it("shows hours ago", () => {
    const date = new Date("2026-04-12T09:00:00Z");
    expect(formatRelativeTime(date)).toBe("3 hours ago");
  });

  it("shows days ago", () => {
    const date = new Date("2026-04-10T12:00:00Z");
    expect(formatRelativeTime(date)).toBe("2 days ago");
  });

  it("shows months ago", () => {
    const date = new Date("2026-01-12T12:00:00Z");
    expect(formatRelativeTime(date)).toBe("3 months ago");
  });

  it("shows years ago", () => {
    const date = new Date("2024-04-12T12:00:00Z");
    expect(formatRelativeTime(date)).toBe("2 years ago");
  });

  it("shows future times with 'in'", () => {
    const date = new Date("2026-04-15T12:00:00Z");
    expect(formatRelativeTime(date)).toBe("in 3 days");
  });
});

describe("formatFullTimestamp", () => {
  it("returns toLocaleString output", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    expect(formatFullTimestamp(date)).toBe(date.toLocaleString());
  });
});

describe("formatFullDate", () => {
  it("returns toLocaleDateString output", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    expect(formatFullDate(date)).toBe(date.toLocaleDateString());
  });
});

describe("subscribeToTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls subscriber every 60 seconds", () => {
    const cb = vi.fn();
    const unsub = subscribeToTick(cb);

    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(2);

    unsub();
  });

  it("cleans up interval when last subscriber unsubscribes", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = subscribeToTick(cb1);
    const unsub2 = subscribeToTick(cb2);

    unsub1();
    vi.advanceTimersByTime(60_000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);

    unsub2();
    vi.advanceTimersByTime(60_000);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});

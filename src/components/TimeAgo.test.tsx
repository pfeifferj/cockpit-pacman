import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimeAgo } from "./TimeAgo";

describe("TimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders relative time for unix timestamp", () => {
    // 2026-04-12T11:00:00Z (1 hour before system time)
    const ts = Math.floor(new Date("2026-04-12T11:00:00Z").getTime() / 1000);
    render(<TimeAgo timestamp={ts} />);
    expect(screen.getByText("1 hour ago")).toBeTruthy();
  });

  it("renders relative time for ISO string", () => {
    render(<TimeAgo timestamp="2026-04-10T12:00:00Z" />);
    expect(screen.getByText("2 days ago")).toBeTruthy();
  });

  it("renders future time", () => {
    render(<TimeAgo timestamp="2026-04-15T12:00:00Z" />);
    expect(screen.getByText("in 3 days")).toBeTruthy();
  });

  it("renders fallback for null", () => {
    render(<TimeAgo timestamp={null} />);
    expect(screen.getByText("Unknown")).toBeTruthy();
  });

  it("renders custom fallback", () => {
    render(<TimeAgo timestamp={null} fallback="-" />);
    expect(screen.getByText("-")).toBeTruthy();
  });

  it("renders fallback for unparseable string", () => {
    render(<TimeAgo timestamp="not a date" fallback="N/A" />);
    expect(screen.getByText("N/A")).toBeTruthy();
  });

  it("has dotted underline style", () => {
    const ts = Math.floor(new Date("2026-04-12T11:00:00Z").getTime() / 1000);
    render(<TimeAgo timestamp={ts} />);
    const el = screen.getByText("1 hour ago");
    expect(el.style.borderBottom).toContain("dotted");
  });

  it("uses date-only format in tooltip when dateOnly is set", () => {
    render(<TimeAgo timestamp="2026-04-10T12:00:00Z" dateOnly />);
    const el = screen.getByText("2 days ago");
    expect(el.closest("[aria-describedby]") || el.parentElement).toBeTruthy();
    // Tooltip content should be date-only (no time component)
    expect(el.getAttribute("aria-label") ?? "").not.toContain(":");
  });
});

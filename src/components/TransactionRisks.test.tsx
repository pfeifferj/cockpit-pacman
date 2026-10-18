import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TransactionRisks, formatAtLeast, useRiskAcknowledgement, type Risks, type RiskAcknowledgement } from "./TransactionRisks";
import { NavigationProvider } from "../contexts/NavigationContext";
import type { PreflightWarning } from "../api";

afterEach(cleanup);

const GIB = 1024 * 1024 * 1024;

const fullDisk: PreflightWarning = {
  id: "disk_space",
  severity: "danger",
  title: "Not enough free space on /",
  message: "Needs about 1.4 GiB, 0.9 GiB free.",
  packages: [],
  blocking: true,
  disk: { mount: "/", deficit: GIB / 2, holds_cache: true },
};

const fullUsr: PreflightWarning = {
  ...fullDisk,
  title: "Not enough free space on /usr",
  disk: { mount: "/usr", deficit: GIB / 2, holds_cache: false },
};

const BLOCK = "Not enough free space on /. Free at least 512.0 MiB on /. Cleaning the package cache frees space on /.";
const BLOCK_USR =
  "Not enough free space on /usr. Free at least 512.0 MiB on /usr. " +
  "The package cache is on another filesystem, so cleaning it does not free space on /usr.";

function risks(over: Partial<Risks> = {}): Risks {
  return { conflicts: [], replacements: [], providers: [], importKeys: [], warnings: [], removals: [], ...over };
}

function renderRisks(value: Risks, beforeNavigate = vi.fn(), onViewCache = vi.fn()) {
  const latest: { ack?: RiskAcknowledgement } = {};
  const Host = () => {
    const ack = useRiskAcknowledgement(value);
    latest.ack = ack;
    return <TransactionRisks risks={value} acknowledgement={ack} beforeNavigate={beforeNavigate} />;
  };
  render(
    <NavigationProvider value={{ onViewCache }}>
      <Host />
    </NavigationProvider>
  );
  return { latest, beforeNavigate, onViewCache };
}

describe("TransactionRisks disk space", () => {
  it("blocks a danger disk_space warning without a checkbox", () => {
    const { latest } = renderRisks(risks({ warnings: [fullDisk] }));
    expect(screen.getByText("Not enough free space on /")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(latest.ack?.complete).toBe(false);
    expect(latest.ack?.blocked).toEqual([BLOCK]);
    expect(latest.ack?.reason).toBe(BLOCK);
  });

  it("puts the block before unset ticks in the reason, and ticks never clear it", () => {
    const { latest } = renderRisks(risks({ warnings: [fullDisk], removals: ["foo"] }));
    expect(latest.ack?.reason).toBe(`${BLOCK} Confirm first: Remove foo`);

    fireEvent.click(screen.getByRole("checkbox", { name: "Remove foo" }));
    expect(latest.ack?.complete).toBe(false);
    expect(latest.ack?.reason).toBe(BLOCK);
  });

  it("Open Cache closes the host before switching tabs", () => {
    const order: string[] = [];
    const beforeNavigate = vi.fn(() => order.push("close"));
    const onViewCache = vi.fn(() => order.push("cache"));
    renderRisks(risks({ warnings: [fullDisk] }), beforeNavigate, onViewCache);

    fireEvent.click(screen.getByRole("button", { name: "Open Cache" }));
    expect(order).toEqual(["close", "cache"]);
  });

  it("names the other filesystem and offers no Open Cache when the cache is elsewhere", () => {
    const { latest } = renderRisks(risks({ warnings: [fullUsr] }));
    expect(screen.queryByRole("button", { name: "Open Cache" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(latest.ack?.blocked).toEqual([BLOCK_USR]);
    expect(screen.getByText(/^Free at least 512\.0 MiB on \/usr\. The package cache is on another filesystem/)).toBeInTheDocument();
  });

  it("keys the block on the blocking flag, not on severity", () => {
    const { latest } = renderRisks(risks({ warnings: [{ ...fullDisk, severity: "warning" }] }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(latest.ack?.blocked).toEqual([BLOCK]);
  });

  it("keeps a low-space warning an ordinary named tick and offers Open Cache when it holds the cache", () => {
    const low: PreflightWarning = {
      ...fullDisk,
      severity: "warning",
      blocking: false,
      title: "Little space left on / after this change",
    };
    const { latest, onViewCache } = renderRisks(risks({ warnings: [low] }));
    expect(screen.getByText("Cleaning the package cache frees space on /.")).toBeInTheDocument();
    expect(screen.queryByText(/^Free at least/)).not.toBeInTheDocument();
    expect(latest.ack?.blocked).toEqual([]);
    expect(latest.ack?.reason).toBe("Confirm first: Proceed despite: Little space left on / after this change");

    fireEvent.click(screen.getByRole("button", { name: "Open Cache" }));
    expect(onViewCache).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Proceed despite: Little space left on / after this change" }));
    expect(latest.ack?.complete).toBe(true);
    expect(latest.ack?.reason).toBeUndefined();
  });

  it("offers no Open Cache on a low-space warning for another filesystem", () => {
    const low: PreflightWarning = { ...fullUsr, severity: "warning", blocking: false, title: "Little space left on /usr" };
    renderRisks(risks({ warnings: [low] }));
    expect(screen.queryByRole("button", { name: "Open Cache" })).not.toBeInTheDocument();
    expect(screen.getByText(/cleaning it does not free space on \/usr/)).toBeInTheDocument();
  });

  it("treats a non-blocking danger warning as a tick", () => {
    const other: PreflightWarning = {
      id: "removal_declined", severity: "danger", title: "Unresolved", message: "", packages: ["foo"], blocking: false,
    };
    const { latest } = renderRisks(risks({ warnings: [other] }));
    expect(screen.getByRole("checkbox", { name: "Proceed despite: Unresolved" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Cache" })).not.toBeInTheDocument();
    expect(latest.ack?.blocked).toEqual([]);
  });
});

describe("formatAtLeast", () => {
  it("rounds up so the amount is never understated", () => {
    expect(formatAtLeast(GIB + 1)).toBe("1.01 GiB");
    expect(formatAtLeast(GIB)).toBe("1.00 GiB");
    expect(formatAtLeast(1024 * 1024 + 1)).toBe("1.1 MiB");
    expect(formatAtLeast(512)).toBe("512 B");
  });
});

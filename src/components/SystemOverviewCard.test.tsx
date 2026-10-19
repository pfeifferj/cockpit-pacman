import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SystemOverviewCard } from "./SystemOverviewCard";
import { NavigationProvider, type NavigationHandlers } from "../contexts/NavigationContext";
import { sweepA11y } from "../test/a11ySweep";
import { SIGNOFF_TILE_FILTER } from "./SignoffsView";

const baseProps: React.ComponentProps<typeof SystemOverviewCard> = {
  updates: [],
  securityCount: 0,
  securityLoading: false,
  securityUnavailable: false,
  orphanCount: 12,
  cacheSize: 1024,
  keyringStatus: { keys: [], total: 1, master_key_initialized: true, status: "ready", warnings: [] },
  summaryLoading: false,
  pendingSignoffs: 3,
  securityEnabled: false,
  onSetSecurityEnabled: () => {},
  securityToggleBusy: false,
};

function renderCard(nav: NavigationHandlers, props: Partial<typeof baseProps> = {}) {
  return render(
    <NavigationProvider value={nav}>
      <SystemOverviewCard {...baseProps} {...props} />
    </NavigationProvider>,
  );
}

describe("SystemOverviewCard", () => {
  it("labels the summary region without a heading", () => {
    renderCard({});
    expect(screen.getByRole("region", { name: "System overview" })).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("names drill-in boxes with their count and destination", () => {
    const onViewOrphans = vi.fn();
    renderCard({ onViewOrphans, onViewCache: vi.fn(), onViewKeyring: vi.fn(), onViewSignoffs: vi.fn() });

    const orphans = screen.getByRole("button", { name: "12 orphans, view orphaned packages" });
    fireEvent.click(orphans);
    expect(onViewOrphans).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "1 key in keyring, view keyring" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 packages to sign off, view package signoffs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /in package cache, view package cache$/ })).toBeInTheDocument();
    sweepA11y();
  });

  it.each([
    [1, "1 orphan", "1 package", "1 key"],
    [1000, "1,000 orphans", "1,000 packages", "1,000 keys"],
  ])("formats a count of %i in the drill-in names", (n, orphans, packages, keys) => {
    renderCard(
      { onViewOrphans: vi.fn(), onViewKeyring: vi.fn(), onViewSignoffs: vi.fn() },
      { orphanCount: n, pendingSignoffs: n, keyringStatus: { ...baseProps.keyringStatus!, total: n } },
    );
    expect(screen.getByRole("button", { name: `${orphans}, view orphaned packages` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${packages} to sign off, view package signoffs` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${keys} in keyring, view keyring` })).toHaveTextContent(new RegExp(`^${keys}(?!s)`));
  });

  it("describes Orphans and Signoffs on the button itself", () => {
    renderCard({ onViewOrphans: vi.fn(), onViewSignoffs: vi.fn() });
    expect(screen.getByRole("button", { name: /^12 orphans/ })).toHaveAccessibleDescription(/no longer required by any other package/);
    const tile = screen.getByRole("button", { name: /^3 packages to sign off/ });
    expect(tile).toHaveAccessibleDescription(/you have not signed off/);
    expect(tile).not.toHaveAccessibleDescription(/Trusted User/);
  });

  it("routes the signoff tile to the filter it counts", () => {
    const onViewSignoffs = vi.fn();
    renderCard({ onViewSignoffs });
    fireEvent.click(screen.getByRole("button", { name: /^3 packages to sign off/ }));
    expect(onViewSignoffs).toHaveBeenCalledWith(SIGNOFF_TILE_FILTER);
  });

  it("leaves the count out of the name while loading", () => {
    renderCard({ onViewOrphans: vi.fn() }, { summaryLoading: true });
    expect(screen.getByRole("button", { name: "Orphans, view orphaned packages" })).toBeInTheDocument();
  });

  it("renders the Updates box as inert", () => {
    renderCard({});
    expect(screen.queryByRole("button", { name: /Updates/ })).not.toBeInTheDocument();
  });

  it("reports a failed advisory toggle with the state it left and retries", () => {
    const onSetSecurityEnabled = vi.fn();
    renderCard({}, { securityEnabled: true, securityToggleError: "permission denied", onSetSecurityEnabled });

    expect(screen.getByText("Could not turn security advisory checks off. They are still on.")).toBeInTheDocument();
    expect(screen.getByText("permission denied")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onSetSecurityEnabled).toHaveBeenCalledWith(false);
  });

  it("shows no toggle failure without an error", () => {
    renderCard({});
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("keeps an unknown advisory setting disabled without displaying an unchecked checkbox", () => {
    const onSetSecurityEnabled = vi.fn();
    renderCard({}, { securityEnabled: null, securityUnavailable: true, onSetSecurityEnabled });
    fireEvent.click(screen.getByRole("button", { name: "Overview settings" }));
    const setting = screen.getByRole("menuitem", { name: /Check security advisories/ });
    expect(setting).toHaveAttribute("aria-disabled", "true");
    expect(setting).toHaveTextContent("Saved advisory setting is unavailable");
    expect(screen.queryByRole("checkbox", { name: /Check security advisories/ })).not.toBeInTheDocument();
    fireEvent.click(setting);
    expect(onSetSecurityEnabled).not.toHaveBeenCalled();
  });
});

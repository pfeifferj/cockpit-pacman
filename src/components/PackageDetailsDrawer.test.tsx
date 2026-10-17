import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { Table, Tbody, Tr, Td } from "@patternfly/react-table";
import { Button } from "@patternfly/react-core";
import { PackageDetailsDrawer, DETAILS_TRIGGER_ATTR } from "./PackageDetailsDrawer";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { DowngradeProvider } from "../contexts/DowngradeContext";
import * as api from "../api";
import { mockPackageDetails } from "../test/mocks";
import { sweepA11y } from "../test/a11ySweep";
import { useShortcuts } from "../hooks/useShortcuts";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listIgnoredPackages: vi.fn(async () => ({ packages: [], total: 0 })),
    getSyncPackageInfo: vi.fn(),
    getSecurityInfo: vi.fn(),
  };
});

const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);
const mockGetSecurityInfo = vi.mocked(api.getSecurityInfo);

function List({ names, active, onClose }: { names: string[]; active: string | null; onClose: () => void }) {
  return (
    <AnnouncerProvider>
      <DowngradeProvider>
        <PackageDetailsDrawer
          activeKey={active}
          packageDetails={active ? { ...mockPackageDetails, name: active } : null}
          isLoading={false}
          onClose={onClose}
        >
          <Table aria-label="Packages">
            <Tbody>
              {names.map((name) => (
                <Tr key={name}>
                  <Td>
                    <Button variant="link" isInline {...{ [DETAILS_TRIGGER_ATTR]: name }}>{name}</Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </PackageDetailsDrawer>
      </DowngradeProvider>
    </AnnouncerProvider>
  );
}

const politeRegion = () => screen.getAllByRole("status").find((el) => el.getAttribute("aria-live") === "polite")!;

describe("PackageDetailsDrawer focus return", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSyncPackageInfo.mockRejectedValue(new api.BackendError("not found", "not_found"));
    mockGetSecurityInfo.mockResolvedValue({ advisories: [] } as unknown as Awaited<ReturnType<typeof api.getSecurityInfo>>);
  });

  afterEach(() => cleanup());

  const closeButton = () => screen.getByRole("button", { name: "Close package details" });

  it("returns focus to the active row's trigger on Close", async () => {
    const onClose = vi.fn();
    render(<List names={["vim", "nano", "emacs"]} active="nano" onClose={onClose} />);
    const close = closeButton();
    close.focus();
    fireEvent.click(close);
    expect(screen.getByRole("button", { name: "nano" })).toHaveFocus();
    expect(onClose).toHaveBeenCalled();
  });

  it("focuses the next row's trigger on Close after the active row left, and announces once", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<List names={["vim", "nano", "emacs"]} active="nano" onClose={onClose} />);
    await screen.findByRole("region", { name: /^nano/ });
    rerender(<List names={["vim", "emacs"]} active="nano" onClose={onClose} />);

    const close = closeButton();
    close.focus();
    fireEvent.click(close);
    rerender(<List names={["vim", "emacs"]} active={null} onClose={onClose} />);

    await waitFor(() => expect(within(screen.getByRole("grid", { name: "Packages" })).getByRole("button", { name: "emacs" })).toHaveFocus());
    await waitFor(() => expect(politeRegion()).toHaveTextContent("nano is no longer in the list"));
    const announced = politeRegion().firstElementChild;
    await new Promise((r) => setTimeout(r, 50));
    expect(politeRegion().firstElementChild).toBe(announced);
  });

  it("focuses the last row when the last row left", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<List names={["vim", "nano", "emacs"]} active="emacs" onClose={onClose} />);
    await screen.findByRole("region", { name: /^emacs/ });
    rerender(<List names={["vim", "nano"]} active="emacs" onClose={onClose} />);
    const close = closeButton();
    close.focus();
    fireEvent.click(close);
    rerender(<List names={["vim", "nano"]} active={null} onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "nano" })).toHaveFocus());
  });

  it("passes the a11y sweep inline", async () => {
    render(<List names={["vim", "nano"]} active="nano" onClose={vi.fn()} />);
    await screen.findByRole("region", { name: /^nano/ });
    sweepA11y();
  });

  it("passes the a11y sweep as an overlay", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      render(<List names={["vim", "nano"]} active="nano" onClose={vi.fn()} />);
      await screen.findByRole("dialog", { name: /^nano/ });
      sweepA11y({ dialogs: [/^nano/] });
    } finally {
      window.matchMedia = original;
    }
  });

  it("blocks shortcuts only while the overlay drawer is open", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    const onFocusJump = vi.fn();
    const onToggleHelp = vi.fn();
    function WithShortcuts({ active }: { active: string | null }) {
      useShortcuts({ onFocusJump, onToggleHelp });
      return <List names={["nano"]} active={active} onClose={vi.fn()} />;
    }
    try {
      const view = render(<WithShortcuts active={null} />);
      expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
      fireEvent.keyDown(document.body, { key: "/" });
      fireEvent.keyDown(document.body, { key: "?" });
      expect(onFocusJump).toHaveBeenCalledTimes(1);
      expect(onToggleHelp).toHaveBeenCalledTimes(1);

      view.rerender(<WithShortcuts active="nano" />);
      const dialog = await screen.findByRole("dialog", { name: /^nano/ });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      fireEvent.transitionEnd(dialog, { propertyName: "transform" });
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      fireEvent.keyDown(document.body, { key: "/" });
      fireEvent.keyDown(document.body, { key: "?" });
      expect(onFocusJump).toHaveBeenCalledTimes(1);
      expect(onToggleHelp).toHaveBeenCalledTimes(1);

      view.rerender(<WithShortcuts active={null} />);
      expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
      fireEvent.keyDown(document.body, { key: "/" });
      fireEvent.keyDown(document.body, { key: "?" });
      expect(onFocusJump).toHaveBeenCalledTimes(2);
      expect(onToggleHelp).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
      window.matchMedia = original;
    }
  });

  it("puts the panel's headings one level under the drawer title", async () => {
    render(
      <AnnouncerProvider>
        <DowngradeProvider>
          <PackageDetailsDrawer activeKey="vim" packageDetails={null} isLoading={false} error="not found" errorCode="not_found" onClose={vi.fn()}>
            <div />
          </PackageDetailsDrawer>
        </DowngradeProvider>
      </AnnouncerProvider>,
    );
    const heading = await screen.findByRole("heading", { name: "Package not found" });
    expect(heading.tagName).toBe("H3");
    sweepA11y();
  });
});

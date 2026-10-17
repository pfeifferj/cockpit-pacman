import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { Table, Tbody, Tr, Td } from "@patternfly/react-table";
import { PackageRowActions, PackageRowActionsProvider, fromRowActions, type PackageRowActionsProps } from "./PackageRowActions";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { NavigationProvider } from "../contexts/NavigationContext";
import { DowngradeProvider } from "../contexts/DowngradeContext";
import * as api from "../api";
import { createMockStreamingProcess } from "../test/mocks";
import { mockPermission, mockSpawn } from "../test/setup";
import { sweepA11y } from "../test/a11ySweep";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
    listIgnoredPackages: vi.fn(),
    addIgnoredPackage: vi.fn(),
    removeIgnoredPackage: vi.fn(),
    previewInstall: vi.fn(),
    previewRemove: vi.fn(),
    listDowngrades: vi.fn(),
    listArchiveVersions: vi.fn(),
    previewDowngrade: vi.fn(),
    setInstallReason: vi.fn(),
  };
});

const mockGetPackageInfo = vi.mocked(api.getPackageInfo);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);
const mockListIgnored = vi.mocked(api.listIgnoredPackages);
const mockAddIgnored = vi.mocked(api.addIgnoredPackage);
const mockRemoveIgnored = vi.mocked(api.removeIgnoredPackage);
const mockPreviewInstall = vi.mocked(api.previewInstall);
const mockPreviewRemove = vi.mocked(api.previewRemove);
const mockListDowngrades = vi.mocked(api.listDowngrades);
const mockPreviewDowngrade = vi.mocked(api.previewDowngrade);
const mockSetInstallReason = vi.mocked(api.setInstallReason);

const nav = { onViewDependencies: vi.fn(), onViewHistory: vi.fn() };
const onViewDetails = vi.fn();
const onRowClick = vi.fn();

function renderActions(props: Partial<PackageRowActionsProps> = {}) {
  return render(
    <NavigationProvider value={nav}>
      <DowngradeProvider>
        <Table aria-label="Packages">
          <Tbody>
            <Tr isClickable onRowClick={(event) => !fromRowActions(event) && onRowClick()}>
              <Td>vim</Td>
              <Td isActionCell>
                <PackageRowActions name="vim" onViewDetails={onViewDetails} {...props} />
              </Td>
            </Tr>
          </Tbody>
        </Table>
      </DowngradeProvider>
    </NavigationProvider>,
  );
}

async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Actions for vim" }));
  return screen.findByRole("menu");
}

const itemNames = (menu: HTMLElement) =>
  within(menu).getAllByRole("menuitem").map((item) => item.textContent);

const item = (menu: HTMLElement, name: string) => within(menu).getByRole("menuitem", { name });

const installed = { installedVersion: "9.1-1", repository: "extra", syncVersion: "9.1-1", ignored: false };
const localVim = { name: "vim", version: "9.1-1", repository: "extra", reason: "explicit", required_by: [], optional_for: [] } as unknown as api.PackageDetails;

const INSTALLED_VERBS = [
  "View vim details",
  "View vim dependencies",
  "View vim history",
  "Ignore vim",
  "Mark vim as a dependency",
  "Reinstall vim",
  "Downgrade vim…",
  "Remove vim",
];

describe("PackageRowActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListIgnored.mockResolvedValue({ packages: [], total: 0 });
    mockGetPackageInfo.mockResolvedValue(localVim);
    mockGetSyncPackageInfo.mockResolvedValue({ name: "vim", version: "9.1-1", repository: "extra" } as api.SyncPackageDetails);
    mockAddIgnored.mockResolvedValue({ success: true, package: "vim", message: "" });
    mockRemoveIgnored.mockResolvedValue({ success: true, package: "vim", message: "" });
    mockPreviewInstall.mockReturnValue(new Promise(() => {}));
    mockPreviewRemove.mockReturnValue(new Promise(() => {}));
    mockPreviewDowngrade.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    cleanup();
    mockPermission.mockImplementation(() => ({
      allowed: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    }));
  });

  it("offers the installed repository package's verbs: views, mutating verbs, then Remove after dividers", async () => {
    renderActions(installed);
    const menu = await openMenu();
    expect(itemNames(menu)).toEqual(INSTALLED_VERBS);
    await vi.waitFor(() => expect(item(menu, "Mark vim as a dependency")).not.toHaveAttribute("aria-disabled", "true"));
    expect(item(menu, "Reinstall vim")).not.toHaveAttribute("aria-disabled", "true");
    const remove = item(menu, "Remove vim");
    expect(remove.closest("li")).toHaveClass("pf-m-danger");
    expect(remove.closest("li")?.previousElementSibling).toHaveAttribute("role", "separator");
    expect(item(menu, "Ignore vim").closest("li")?.previousElementSibling).toHaveAttribute("role", "separator");
  });

  it("keeps Reinstall, disabled with the reason, for a package in no configured repository", async () => {
    renderActions({ ...installed, repository: null });
    const menu = await openMenu();
    expect(itemNames(menu)).toEqual(INSTALLED_VERBS);
    const reinstall = item(menu, "Reinstall vim");
    expect(reinstall).toHaveAttribute("aria-disabled", "true");
    expect(reinstall).toHaveAccessibleDescription("vim is in no configured repository, so there is no build to reinstall");
  });

  it("gives an outdated package no runnable Reinstall and points to Updates", async () => {
    renderActions({ ...installed, syncVersion: "9.1-2" });
    const menu = await openMenu();
    expect(itemNames(menu)).toEqual(INSTALLED_VERBS);
    const reinstall = item(menu, "Reinstall vim");
    expect(reinstall).toHaveAttribute("aria-disabled", "true");
    expect(reinstall).toHaveAccessibleDescription("extra has 9.1-2; reinstalling would upgrade vim alone. Upgrade it from Updates");
    fireEvent.click(reinstall);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockPreviewInstall).not.toHaveBeenCalled();
    expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
  });

  it("reads the repository version when the host does not know it, without moving Remove", async () => {
    let resolveSync!: (details: api.SyncPackageDetails) => void;
    mockGetSyncPackageInfo.mockReturnValue(new Promise((resolve) => { resolveSync = resolve; }));
    renderActions({ installedVersion: "9.1-1", repository: "extra", onViewDetails: undefined });
    const menu = await openMenu();
    const names = itemNames(menu);
    const removeIndex = names.indexOf("Remove vim");
    const reinstall = item(menu, "Reinstall vim");
    expect(reinstall).toHaveAttribute("aria-disabled", "true");
    expect(reinstall).toHaveAccessibleDescription("Checking the repository version…");
    expect(reinstall.closest("li")).toHaveAttribute("data-pending", "true");
    sweepA11y();
    await act(async () => resolveSync({ name: "vim", version: "9.1-1", repository: "extra" } as api.SyncPackageDetails));
    expect(item(menu, "Reinstall vim")).not.toHaveAttribute("aria-disabled", "true");
    expect(item(menu, "Reinstall vim").closest("li")).not.toHaveAttribute("data-pending");
    expect(itemNames(menu)).toEqual(names);
    expect(itemNames(menu).indexOf("Remove vim")).toBe(removeIndex);
    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("vim", "extra");
  });

  it("checks reinstall against the selected repository", async () => {
    mockGetSyncPackageInfo.mockImplementation(async (_name, repository) => ({
      name: "vim", version: repository === "extra-testing" ? "9.1-2" : "9.1-1", repository: repository ?? "extra",
    } as api.SyncPackageDetails));
    renderActions({ ...installed, repository: "extra-testing", syncVersion: undefined, reason: "explicit" });
    const menu = await openMenu();

    await vi.waitFor(() => expect(item(menu, "Reinstall vim")).toHaveAccessibleDescription("extra-testing has 9.1-2; reinstalling would upgrade vim alone. Upgrade it from Updates"));
    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("vim", "extra-testing");
    fireEvent.click(item(menu, "Reinstall vim"));
    expect(mockPreviewInstall).not.toHaveBeenCalled();
  });

  it("disables Reinstall when the read repository version is newer or unreadable", async () => {
    mockGetSyncPackageInfo.mockResolvedValue({ name: "vim", version: "9.1-2", repository: "extra" } as api.SyncPackageDetails);
    renderActions({ ...installed, syncVersion: undefined });
    let menu = await openMenu();
    await vi.waitFor(() =>
      expect(item(menu, "Reinstall vim")).toHaveAccessibleDescription("extra has 9.1-2; reinstalling would upgrade vim alone. Upgrade it from Updates"));
    cleanup();

    mockGetSyncPackageInfo.mockRejectedValue(new Error("not found"));
    renderActions({ ...installed, syncVersion: undefined });
    menu = await openMenu();
    await vi.waitFor(() => expect(item(menu, "Reinstall vim")).toHaveAccessibleDescription("Could not read the extra version of vim"));
    expect(item(menu, "Reinstall vim")).toHaveAttribute("aria-disabled", "true");
    expect(item(menu, "Remove vim")).toBeInTheDocument();
  });

  it("names a repository build older than the installed one", async () => {
    renderActions({ ...installed, syncVersion: "9.0-1" });
    const menu = await openMenu();
    expect(item(menu, "Reinstall vim")).toHaveAccessibleDescription("extra has 9.0-1; reinstalling would replace vim 9.1-1 with that older build");
  });

  it("marks the install reason with Undo, gated while the reason is read", async () => {
    let resolveLocal!: (details: api.PackageDetails) => void;
    mockGetPackageInfo.mockReturnValueOnce(new Promise((resolve) => { resolveLocal = resolve; }));
    mockSetInstallReason
      .mockResolvedValueOnce({ success: true, name: "vim", reason: "dependency", previous: "explicit" })
      .mockResolvedValueOnce({ success: true, name: "vim", reason: "explicit", previous: "dependency" });
    mockGetPackageInfo.mockResolvedValue({ ...localVim, reason: "dependency", required_by: ["gvim"] } as api.PackageDetails);
    renderActions(installed);
    const menu = await openMenu();
    const pending = item(menu, "Change the install reason of vim");
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveAccessibleDescription("Checking the install reason of vim…");
    fireEvent.click(pending);
    expect(mockSetInstallReason).not.toHaveBeenCalled();
    sweepA11y();

    await act(async () => resolveLocal(localVim));
    await act(async () => {
      fireEvent.click(item(menu, "Mark vim as a dependency"));
    });
    expect(mockSetInstallReason).toHaveBeenCalledWith("vim", "dependency");
    expect(await screen.findByText("vim is now marked as a dependency")).toBeInTheDocument();
    expect(screen.queryByText(/now an orphan/)).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mockSetInstallReason).toHaveBeenLastCalledWith("vim", "explicit");
    expect(await screen.findByText("vim is now marked as explicitly installed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("tells the host after a reason change and after its Undo, and not after a failure", async () => {
    const onReasonChange = vi.fn();
    mockSetInstallReason
      .mockResolvedValueOnce({ success: true, name: "vim", reason: "dependency", previous: "explicit" })
      .mockResolvedValueOnce({ success: true, name: "vim", reason: "explicit", previous: "dependency" })
      .mockRejectedValueOnce(new Error("unable to lock database"));
    renderActions({ ...installed, reason: "explicit", onReasonChange });
    let menu = await openMenu();
    await act(async () => {
      fireEvent.click(item(menu, "Mark vim as a dependency"));
    });
    expect(onReasonChange).toHaveBeenCalledWith("vim", "dependency");
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    });
    expect(onReasonChange).toHaveBeenLastCalledWith("vim", "explicit");
    expect(onReasonChange).toHaveBeenCalledTimes(2);
    menu = await openMenu();
    await act(async () => {
      fireEvent.click(item(menu, "Mark vim as a dependency"));
    });
    expect(await screen.findByText("Could not change the install reason of vim")).toBeInTheDocument();
    expect(onReasonChange).toHaveBeenCalledTimes(2);
  });

  it("takes the install reason from the host without reading the local db", async () => {
    renderActions({ ...installed, reason: "dependency" });
    const menu = await openMenu();
    expect(item(menu, "Mark vim as explicitly installed")).not.toHaveAttribute("aria-disabled", "true");
    expect(mockGetPackageInfo).not.toHaveBeenCalled();
  });

  it("says a package marked as a dependency that nothing requires is now an orphan", async () => {
    mockSetInstallReason.mockResolvedValueOnce({ success: true, name: "vim", reason: "dependency", previous: "explicit" });
    renderActions(installed);
    const menu = await openMenu();
    await vi.waitFor(() => expect(item(menu, "Mark vim as a dependency")).not.toHaveAttribute("aria-disabled", "true"));
    mockGetPackageInfo.mockResolvedValue({ ...localVim, reason: "dependency" } as api.PackageDetails);
    await act(async () => {
      fireEvent.click(item(menu, "Mark vim as a dependency"));
    });
    expect(await screen.findByText("Nothing requires it, so it is now an orphan.")).toBeInTheDocument();
  });

  it("reports a failed install reason change", async () => {
    mockSetInstallReason.mockRejectedValueOnce(new api.BackendError("unable to lock database", "database_locked", "Another package manager owns /var/lib/pacman/db.lck"));
    renderActions(installed);
    const menu = await openMenu();
    await vi.waitFor(() => expect(item(menu, "Mark vim as a dependency")).not.toHaveAttribute("aria-disabled", "true"));
    await act(async () => {
      fireEvent.click(item(menu, "Mark vim as a dependency"));
    });
    expect(await screen.findByText("Could not change the install reason of vim")).toBeInTheDocument();
    expect(screen.getByText("unable to lock database").closest(".pf-v6-c-alert")).toHaveClass("pf-m-warning");
    expect(screen.getByText("Another package manager owns /var/lib/pacman/db.lck")).toBeInTheDocument();
  });

  it("offers Install, and nothing that needs an installed package, for a repository-only package", async () => {
    renderActions({ installedVersion: null, repository: "extra", syncVersion: "9.1-2" });
    const menu = await openMenu();
    expect(itemNames(menu)).toEqual([
      "View vim details",
      "View vim dependencies",
      "View vim history",
      "Install vim",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Install vim" }));
    expect(await screen.findByRole("dialog", { name: "Install vim" })).toBeInTheDocument();
    expect(mockPreviewInstall).toHaveBeenCalledWith("vim", { repo: "extra", version: "9.1-2", reinstall: undefined });
  });

  it("passes the a11y sweep with the menu open", async () => {
    renderActions(installed);
    await openMenu();
    sweepA11y();
  });

  it("times out an Undo toast after at least 8 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderActions({ installedVersion: "9.1-1", repository: "extra", syncVersion: "9.1-1" });
      const menu = await openMenu();
      await vi.waitFor(() => expect(item(menu, "Ignore vim")).not.toHaveAttribute("aria-disabled", "true"));
      await act(async () => {
        fireEvent.click(item(menu, "Ignore vim"));
      });
      expect(await screen.findByText("vim is now ignored during upgrades")).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(7900);
      });
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.queryByText("vim is now ignored during upgrades")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds Undo until a running transaction exits", async () => {
    renderActions(installed);
    const menu = await openMenu();
    await act(async () => fireEvent.click(item(menu, "Ignore vim")));
    const undo = await screen.findByRole("button", { name: "Undo" });
    const proc = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(proc);
    act(() => { api.runUpgrade({ onComplete: () => {}, onError: () => {} }); });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(undo);
    expect(mockRemoveIgnored).not.toHaveBeenCalled();
    act(() => proc._emit(JSON.stringify({ type: "complete", success: true }) + "\n"));
    expect(undo).toHaveAttribute("aria-disabled", "true");
    act(() => proc._complete());
    expect(undo).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => fireEvent.click(undo));
    expect(mockRemoveIgnored).toHaveBeenCalledWith("vim");
  });

  it("offers Unignore for an ignored package", async () => {
    renderActions({ ...installed, ignored: true });
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Unignore vim" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Ignore vim" })).not.toBeInTheDocument();
  });

  it("hands Remove to the host's own flow for an orphan", async () => {
    const onRemove = vi.fn();
    renderActions({ installedVersion: "1.0-1", repository: "extra", onRemove });
    const menu = await openMenu();
    expect(itemNames(menu).pop()).toBe("Remove vim");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove vim" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(mockPreviewRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the remove dialog by default", async () => {
    renderActions(installed);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove vim" }));
    expect(await screen.findByRole("dialog", { name: "Remove vim" })).toBeInTheDocument();
    expect(mockPreviewRemove).toHaveBeenCalledWith("vim");
  });

  describe("focus after the row leaves the list", () => {
    function RowList({ names }: { names: string[] }) {
      return (
        <AnnouncerProvider>
          <PackageRowActionsProvider>
            <Table aria-label="Packages">
              <Tbody>
                {names.map((name) => (
                  <Tr key={name}>
                    <Td>{name}</Td>
                    <Td isActionCell>
                      <PackageRowActions name={name} installedVersion="1.0-1" repository="extra" syncVersion="1.0-1" ignored={false} reason="explicit" />
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </PackageRowActionsProvider>
        </AnnouncerProvider>
      );
    }

    const openRemove = async (name: string) => {
      const toggle = screen.getByRole("button", { name: `Actions for ${name}` });
      toggle.focus();
      fireEvent.click(toggle);
      fireEvent.click(await screen.findByRole("menuitem", { name: `Remove ${name}` }));
      return screen.findByRole("dialog", { name: `Remove ${name}` });
    };

    const politeRegion = () => screen.getAllByRole("status").find((el) => el.getAttribute("aria-live") === "polite")!;

    it("focuses the next row's kebab when the dialog closes after its row unmounted, and says why once", async () => {
      const { rerender } = render(<RowList names={["vim", "nano", "emacs"]} />);
      const dialog = await openRemove("nano");
      rerender(<RowList names={["vim", "emacs"]} />);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await vi.waitFor(() => expect(screen.getByRole("button", { name: "Actions for emacs" })).toHaveFocus());
      await vi.waitFor(() => expect(politeRegion()).toHaveTextContent("nano is no longer in the list"));
      const announced = politeRegion().firstElementChild;
      await new Promise((r) => setTimeout(r, 50));
      expect(politeRegion().firstElementChild).toBe(announced);
    });

    it("focuses the next row's kebab when the row unmounts after the dialog closed", async () => {
      const { rerender } = render(<RowList names={["vim", "nano", "emacs"]} />);
      const dialog = await openRemove("nano");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "Actions for nano" })).toHaveFocus());
      await new Promise((r) => setTimeout(r, 50));

      rerender(<RowList names={["vim", "emacs"]} />);
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "Actions for emacs" })).toHaveFocus());
      await vi.waitFor(() => expect(politeRegion()).toHaveTextContent("nano is no longer in the list"));
    });

    it("returns focus to the row's own kebab and says nothing when the row stays", async () => {
      render(<RowList names={["vim", "nano", "emacs"]} />);
      const dialog = await openRemove("nano");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "Actions for nano" })).toHaveFocus());
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByRole("button", { name: "Actions for nano" })).toHaveFocus();
      expect(politeRegion()).toHaveTextContent("");
    });
  });

  it("delegates the view items to the host and the navigation context", async () => {
    renderActions(installed);
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "View vim dependencies" }));
    expect(nav.onViewDependencies).toHaveBeenCalledWith("vim");
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "View vim history" }));
    expect(nav.onViewHistory).toHaveBeenCalledWith("vim");
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "View vim details" }));
    expect(onViewDetails).toHaveBeenCalledTimes(1);
  });

  it("keeps gated items focusable with their reason", async () => {
    mockPermission.mockImplementation(() => ({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    }));
    renderActions(installed);
    const menu = await openMenu();
    const remove = within(menu).getByRole("menuitem", { name: "Remove vim" });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).not.toBeDisabled();
    fireEvent.click(remove);
    expect(mockPreviewRemove).not.toHaveBeenCalled();
    await act(async () => {
      remove.focus();
    });
    expect(remove).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Turn on administrative access to remove vim");
    expect(within(menu).getByRole("menuitem", { name: "View vim details" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("ignores with Undo when the host has no ignore flow of its own", async () => {
    renderActions({ installedVersion: "9.1-1", repository: "extra" });
    const menu = await openMenu();
    const ignore = await within(menu).findByRole("menuitem", { name: "Ignore vim" });
    await act(async () => {
      fireEvent.click(ignore);
    });
    expect(mockAddIgnored).toHaveBeenCalledWith("vim");
    expect(await screen.findByText("vim is now ignored during upgrades")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mockRemoveIgnored).toHaveBeenCalledWith("vim");
    expect(await screen.findByText("vim is no longer ignored during upgrades")).toBeInTheDocument();
  });

  it("keeps diagnostics in failed ignore notifications", async () => {
    mockAddIgnored.mockRejectedValueOnce(new api.BackendError("Cannot save ignored packages", "permission_denied", "The configuration directory is read-only"));
    renderActions({ ...installed, reason: "explicit" });
    const menu = await openMenu();
    await act(async () => { fireEvent.click(item(menu, "Ignore vim")); });

    expect(await screen.findByText("Could not ignore vim")).toBeInTheDocument();
    expect(screen.getByText("Cannot save ignored packages")).toBeInTheDocument();
    expect(screen.getByText("The configuration directory is read-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("reads the ignore list when the host does not know it", async () => {
    mockListIgnored.mockResolvedValue({ packages: ["vim"], total: 1 });
    renderActions({ installedVersion: "9.1-1", repository: "extra" });
    const menu = await openMenu();
    expect(await within(menu).findByRole("menuitem", { name: "Unignore vim" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("renders every slot of an unknown package on first paint and offers the downgrade to a given version", async () => {
    let resolveInfo!: (details: api.PackageDetails) => void;
    mockGetPackageInfo.mockReturnValue(new Promise((resolve) => { resolveInfo = resolve; }));
    mockListDowngrades.mockResolvedValue({
      packages: [{ name: "vim", version: "9.0-1", filename: "vim-9.0-1-x86_64.pkg.tar.zst", size: 1, installed_version: "9.1-1", is_older: true }],
      total: 1,
    });
    renderActions({ downgradeTo: "9.0-1" });
    const menu = await openMenu();
    const firstPaint = [
      "View vim details",
      "View vim dependencies",
      "View vim history",
      "Ignore vim",
      "Change the install reason of vim",
      "Reinstall vim",
      "Downgrade vim to 9.0-1",
      "Downgrade vim…",
      "Remove vim",
    ];
    expect(itemNames(menu)).toEqual(firstPaint);
    for (const name of firstPaint.slice(3)) {
      expect(item(menu, name)).toHaveAttribute("aria-disabled", "true");
      expect(item(menu, name)).toHaveAccessibleDescription("Checking whether vim is installed…");
    }
    sweepA11y();
    await act(async () => resolveInfo(localVim));
    expect(itemNames(menu)).toEqual([...firstPaint.slice(0, 4), "Mark vim as a dependency", ...firstPaint.slice(5)]);
    const downgradeTo = item(menu, "Downgrade vim to 9.0-1");
    expect(downgradeTo).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(downgradeTo);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await vi.waitFor(() => expect(mockPreviewDowngrade).toHaveBeenCalledWith("vim", "9.0-1"));
  });

  it("disables a downgrade to a version that is not older than the installed one", async () => {
    mockGetPackageInfo.mockResolvedValue({ ...localVim, version: "9.0-1" } as api.PackageDetails);
    renderActions({ downgradeTo: "9.1-1" });
    const menu = await openMenu();
    await vi.waitFor(() =>
      expect(item(menu, "Downgrade vim to 9.1-1")).toHaveAccessibleDescription("9.1-1 is not older than the installed 9.0-1"));
    expect(item(menu, "Downgrade vim to 9.1-1")).toHaveAttribute("aria-disabled", "true");
    expect(item(menu, "Downgrade vim…")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("keeps the downgrade-to slot for a row with no replaced version, so Remove stays in place", async () => {
    renderActions({ ...installed, downgradeTo: "9.0-1" });
    const upgradeRow = itemNames(await openMenu());
    cleanup();
    renderActions({ ...installed, downgradeTo: null });
    const menu = await openMenu();
    expect(itemNames(menu).indexOf("Remove vim")).toBe(upgradeRow.indexOf("Remove vim"));
    const slot = item(menu, "Downgrade vim to the replaced version");
    expect(slot).toHaveAttribute("aria-disabled", "true");
    expect(slot).toHaveAccessibleDescription("This entry did not replace an earlier version of vim");
  });

  it("offers Install for an unknown package that is only in the repositories", async () => {
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("not found", "not_found"));
    mockGetSyncPackageInfo.mockResolvedValue({ name: "vim", version: "9.1-2", repository: "extra" } as api.SyncPackageDetails);
    renderActions({ downgradeTo: "9.0-1" });
    const menu = await openMenu();
    expect(await within(menu).findByRole("menuitem", { name: "Install vim" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Downgrade/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Remove vim" })).not.toBeInTheDocument();
  });

  it("preserves the selected repository when resolving an uninstalled package", async () => {
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("Not installed", "not_found"));
    mockGetSyncPackageInfo.mockImplementation(async (_name, repository) => ({
      name: "vim", version: repository === "extra-testing" ? "9.1-2" : "9.1-1", repository: repository ?? "extra",
    } as api.SyncPackageDetails));
    renderActions({ repository: "extra-testing" });
    const menu = await openMenu();

    fireEvent.click(await within(menu).findByRole("menuitem", { name: "Install vim" }));
    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("vim", "extra-testing");
    await screen.findByRole("dialog", { name: "Install vim" });
    expect(mockPreviewInstall).toHaveBeenCalledWith("vim", { repo: "extra-testing", version: "9.1-2", reinstall: undefined });
  });

  it.each([
    [undefined, new api.BackendError("Cannot read local package", "permission_denied", "The local database cannot be opened")],
    ["9.1-1", new api.BackendError("Cannot read local package", "permission_denied", "The local database cannot be opened")],
    [undefined, new Error("not found")],
  ] as const)("blocks mutations when the local lookup fails with installed version %s: %s", async (installedVersion, error) => {
    mockGetPackageInfo.mockRejectedValue(error);
    renderActions({ installedVersion });
    const menu = await openMenu();

    expect(await screen.findByText("Could not read vim")).toBeInTheDocument();
    expect(screen.getByText(error.message)).toBeInTheDocument();
    if (error instanceof api.BackendError) expect(screen.getByText(error.details!)).toBeInTheDocument();
    expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
    expect(within(menu).queryByRole("menuitem", { name: "Install vim" })).not.toBeInTheDocument();
    const remove = item(menu, "Remove vim");
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove.closest("li")).not.toHaveAttribute("data-pending");
    expect(remove).toHaveAccessibleDescription(`Could not read vim: ${error.message}`);
    fireEvent.click(remove);
    expect(mockPreviewRemove).not.toHaveBeenCalled();
    expect(item(menu, "View vim details")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("reports sync failures after a missing local package", async () => {
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("Not installed", "not_found"));
    mockGetSyncPackageInfo.mockRejectedValue(new api.BackendError("Cannot read sync package", "permission_denied", "The sync directory cannot be opened"));
    renderActions();
    const menu = await openMenu();

    expect(await screen.findByText("Cannot read sync package")).toBeInTheDocument();
    expect(screen.getByText("The sync directory cannot be opened")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Install vim" })).not.toBeInTheDocument();
    expect(item(menu, "Remove vim")).toHaveAttribute("aria-disabled", "true");
  });

  it("does not activate the row when the kebab or its items are used", async () => {
    renderActions(installed);
    const toggle = screen.getByRole("button", { name: "Actions for vim" });
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.keyDown(toggle, { key: " " });
    const menu = await openMenu();
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Ignore vim" }), { key: "Enter" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "View vim dependencies" }));
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("vim"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});

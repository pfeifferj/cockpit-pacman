import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState, type ReactElement } from "react";
import { render as renderBare, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { PackageDetailsModal, optdepName } from "./PackageDetailsModal";
import * as api from "../api";
import { mockPackageDetails, mockSyncPackageDetails, createMockStreamingProcess } from "../test/mocks";
import { mockPermission, mockSpawn } from "../test/setup";
import { NavigationProvider } from "../contexts/NavigationContext";
import { DowngradeProvider } from "../contexts/DowngradeContext";
import { TabActiveContext } from "../hooks/useRefreshOnActivate";
import { sweepA11y } from "../test/a11ySweep";

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DowngradeProvider });

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    addIgnoredPackage: vi.fn(),
    removeIgnoredPackage: vi.fn(),
    listIgnoredPackages: vi.fn(),
    setInstallReason: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
    previewInstall: vi.fn(),
    getSecurityInfo: vi.fn(),
    listDowngrades: vi.fn(),
    downgradePackage: vi.fn(),
    previewDowngrade: vi.fn(),
    previewRemove: vi.fn(),
    installPackage: vi.fn(),
  };
});

const mockAddIgnoredPackage = vi.mocked(api.addIgnoredPackage);
const mockGetSecurityInfo = vi.mocked(api.getSecurityInfo);
const mockListDowngrades = vi.mocked(api.listDowngrades);
const mockDowngradePackage = vi.mocked(api.downgradePackage);
const mockPreviewRemove = vi.mocked(api.previewRemove);
const mockPreviewDowngrade = vi.mocked(api.previewDowngrade);
const mockRemoveIgnoredPackage = vi.mocked(api.removeIgnoredPackage);
const mockListIgnoredPackages = vi.mocked(api.listIgnoredPackages);
const mockSetInstallReason = vi.mocked(api.setInstallReason);
const mockGetPackageInfo = vi.mocked(api.getPackageInfo);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);
const mockPreviewInstall = vi.mocked(api.previewInstall);
const mockInstallPackage = vi.mocked(api.installPackage);

const openActions = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  });
  await screen.findAllByRole("menuitem");
};
const action = (name: string) => screen.getByRole("menuitem", { name });
const chooseAction = async (name: string) => {
  await openActions();
  await act(async () => {
    fireEvent.click(action(name));
  });
};

const emptyPreview = {
  success: true,
  add: [],
  remove: [],
  conflicts: [],
  replacements: [],
  providers: [],
  import_keys: [],
  warnings: [],
  blocked_by: [],
  total_download_size: 0,
  net_installed_size: 0,
};

const linuxInRepo = { ...mockSyncPackageDetails, version: mockPackageDetails.version, repository: "core" };

describe("PackageDetailsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSyncPackageInfo.mockResolvedValue(linuxInRepo);
    mockAddIgnoredPackage.mockResolvedValue({ success: true, package: "linux", message: "Package ignored" });
    mockRemoveIgnoredPackage.mockResolvedValue({ success: true, package: "linux", message: "Package unignored" });
    mockListIgnoredPackages.mockResolvedValue({ packages: [], total: 0 });
    mockGetSecurityInfo.mockResolvedValue({
      name: "linux",
      advisories: [{ name: "AVG-2024-1", date: "2024-01-01", severity: "High", advisory_type: "specific" }],
      groups: [],
      issues: [],
    });
    mockListDowngrades.mockResolvedValue({
      packages: [{
        name: "linux",
        version: "6.6.0-arch1-1",
        filename: "linux-6.6.0-arch1-1-x86_64.pkg.tar.zst",
        size: 1024,
        installed_version: "6.7.0-arch1-1",
        is_older: true,
      }],
      total: 1,
    });
    mockPreviewDowngrade.mockResolvedValue({
      success: true,
      add: [{ name: "linux", version: "6.6.0-arch1-1", repo: null, download_size: 0, installed_size: 1, old_version: "6.7.0-arch1-1", reason: "target" }],
      remove: [],
      conflicts: [],
      replacements: [],
      providers: [],
      import_keys: [],
      warnings: [],
      blocked_by: [],
      total_download_size: 0,
      net_installed_size: 0,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("puts the panel's headings directly under the dialog title", async () => {
    render(<PackageDetailsModal packageDetails={null} isLoading={false} error="not found" errorCode="not_found" onClose={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: "Package not found" });
    expect(heading.tagName).toBe("H2");
    sweepA11y();
  });

  it("keeps shown details and diagnostics after a refresh fails", async () => {
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        error="Cannot read local package"
        errorCode="permission_denied"
        errorDetails="The local database cannot be opened"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: /Could not refresh package details/ })).toBeInTheDocument();
    expect(screen.getByText("Cannot read local package")).toBeInTheDocument();
    expect(screen.getByText("The local database cannot be opened")).toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Package not found" })).not.toBeInTheDocument();
  });

  it("renders package name and version for an installed package", async () => {
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("linux")).toBeInTheDocument();
    expect(screen.getByText("6.7.0-arch1-1")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("linux 6.7.0-arch1-1 core");
  });

  it("gives every help trigger a focusable, named button that opens on Enter", async () => {
    render(
      <PackageDetailsModal
        packageDetails={{
          ...mockPackageDetails,
          repository: "",
          groups: ["base-devel"],
          conflicts: ["linux-old"],
          replaces: ["linux-older"],
          packager: "Unknown Packager",
        }}
        isLoading={false}
        onClose={vi.fn()}
      />
    );

    const triggers = screen.getAllByRole("button", { name: /^More information about/ });
    expect(triggers).toHaveLength(9);
    const arch = screen.getByRole("button", { name: "More information about package architecture" });
    arch.focus();
    expect(arch).toHaveFocus();
    fireEvent.click(arch);
    expect(await screen.findByText(/CPU architecture this package was built for/)).toBeInTheDocument();
  });

  it("renders install button for a non-installed sync package", async () => {
    render(
      <PackageDetailsModal
        packageDetails={mockSyncPackageDetails}
        isLoading={false}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Install/i })).toBeInTheDocument();
    });
  });

  it("Ignore keeps the dialog open, flips the label and offers Undo", async () => {
    const onClose = vi.fn();
    const onIgnored = vi.fn();

    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={onClose}
        onIgnored={onIgnored}
        isIgnored={false}
      />
    );
    expect(screen.getByText("Included")).toBeInTheDocument();

    await chooseAction("Ignore linux");

    expect(mockAddIgnoredPackage).toHaveBeenCalledWith("linux");
    expect(onIgnored).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Ignored").closest("[data-highlighted]")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /linux is now ignored during upgrades/ })).toBeInTheDocument();
    await openActions();
    expect(action("Unignore linux")).toBeInTheDocument();
    fireEvent.keyDown(action("Unignore linux"), { key: "Escape" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mockRemoveIgnoredPackage).toHaveBeenCalledWith("linux");
    expect(onIgnored).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Included")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("keeps Undo focusable and gives the reason while the Undo runs", async () => {
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} isIgnored={false} />);
    await chooseAction("Ignore linux");
    let finish: () => void = () => {};
    mockRemoveIgnoredPackage.mockImplementationOnce(() => new Promise((r) => { finish = () => r(undefined as never); }));

    const undo = screen.getByRole("button", { name: "Undo" });
    undo.focus();
    await act(async () => {
      fireEvent.click(undo);
    });
    expect(mockRemoveIgnoredPackage).toHaveBeenCalledTimes(1);
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(undo).not.toBeDisabled();
    expect(undo).toHaveAccessibleDescription("Wait for unignoring linux to finish");
    expect(undo).toHaveFocus();
    sweepA11y({ dialogs: [/^linux /] });

    fireEvent.click(undo);
    expect(mockRemoveIgnoredPackage).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("keeps the Ignore Undo after switching to another package, and the Undo still reverts the first", async () => {
    const { rerender } = render(
      <PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />,
    );
    await screen.findByText("Included");
    await chooseAction("Ignore linux");
    expect(screen.getByRole("heading", { name: /linux is now ignored during upgrades/ })).toBeInTheDocument();

    rerender(<PackageDetailsModal packageDetails={{ ...mockPackageDetails, name: "glibc" }} isLoading={false} onClose={vi.fn()} />);
    expect(await screen.findByRole("dialog", { name: /^glibc / })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /linux is now ignored during upgrades/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mockRemoveIgnoredPackage).toHaveBeenCalledWith("linux");
  });

  it("names the shown package in data-details-for and keeps it while the next one loads", async () => {
    const { rerender } = render(
      <PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("data-details-for", "linux");

    rerender(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-details-for", "linux");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
  });

  it("shows the spinner at once when there is nothing to keep", () => {
    render(<PackageDetailsModal packageDetails={null} isLoading onClose={vi.fn()} />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-details-for");
  });

  it("reads the ignore state itself when the host does not pass it", async () => {
    mockListIgnoredPackages.mockResolvedValue({ packages: ["linux"], total: 1 });
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />);

    await screen.findByText("Ignored");
    await openActions();
    expect(action("Unignore linux")).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(action("Unignore linux"));
    });
    expect(mockRemoveIgnoredPackage).toHaveBeenCalledWith("linux");
    expect(mockAddIgnoredPackage).not.toHaveBeenCalled();
  });

  it("Mark as dependency changes the label only after the backend answers, and Undo restores previous", async () => {
    let resolveReason: (v: api.InstallReasonResponse) => void = () => {};
    mockSetInstallReason.mockImplementationOnce(() => new Promise((r) => { resolveReason = r; }));
    mockGetPackageInfo.mockResolvedValueOnce({ ...mockPackageDetails, reason: "dependency", required_by: ["linux-headers"] });
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />);

    await chooseAction("Mark linux as a dependency");
    expect(mockSetInstallReason).toHaveBeenCalledWith("linux", "dependency");
    expect(screen.getByText("explicit")).toBeInTheDocument();
    expect(screen.queryByText("dependency")).not.toBeInTheDocument();

    await act(async () => {
      resolveReason({ success: true, name: "linux", reason: "dependency", previous: "explicit" });
    });
    expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    expect(screen.getByText("dependency").closest("[data-highlighted]")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /linux is now marked as a dependency/ })).toBeInTheDocument();
    expect(screen.queryByText(/now an orphan/)).not.toBeInTheDocument();
    await openActions();
    expect(action("Mark linux as explicitly installed")).toBeInTheDocument();
    fireEvent.keyDown(action("Mark linux as explicitly installed"), { key: "Escape" });

    mockSetInstallReason.mockResolvedValueOnce({ success: true, name: "linux", reason: "explicit", previous: "dependency" });
    mockGetPackageInfo.mockResolvedValueOnce({ ...mockPackageDetails, reason: "explicit" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mockSetInstallReason).toHaveBeenLastCalledWith("linux", "explicit");
    expect(screen.getByText("explicit")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("says a package nothing requires became an orphan and links to the orphan filter", async () => {
    mockSetInstallReason.mockResolvedValueOnce({ success: true, name: "linux", reason: "dependency", previous: "explicit" });
    mockGetPackageInfo.mockResolvedValueOnce({ ...mockPackageDetails, reason: "dependency" });
    const onViewOrphans = vi.fn();
    const onClose = vi.fn();
    render(
      <NavigationProvider value={{ onViewOrphans }}>
        <PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={onClose} />
      </NavigationProvider>
    );

    await chooseAction("Mark linux as a dependency");
    expect(screen.getByText("Nothing requires it, so it is now an orphan.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View orphans" }));
    expect(onViewOrphans).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drops the highlight transition when reduced motion is requested", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    try {
      render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} isIgnored={false} />);
      await chooseAction("Ignore linux");
      const marked = screen.getByText("Ignored").closest<HTMLElement>("[data-highlighted]")!;
      expect(marked.style.transition).toBe("");
      expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    } finally {
      window.matchMedia = original;
    }
  });

  it("shows an inline error when the install reason cannot be changed", async () => {
    mockSetInstallReason.mockRejectedValueOnce(new api.BackendError("Cannot change install reason", "permission_denied", "Cannot write the local database entry"));
    const onClose = vi.fn();
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={onClose} />);

    await chooseAction("Mark linux as a dependency");
    expect(screen.getByRole("heading", { name: /Could not change the install reason of linux/ })).toBeInTheDocument();
    expect(screen.getByText("Cannot change install reason")).toBeInTheDocument();
    expect(screen.getByText("Cannot write the local database entry")).toBeInTheDocument();
    expect(screen.getByText("explicit")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("puts links in the body, verbs in one Actions menu and Remove apart, with at most one primary", async () => {
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={vi.fn()}
        onViewDependencies={vi.fn()}
        onViewHistory={vi.fn()}
      />
    );
    const dialog = screen.getByRole("dialog");
    const footer = dialog.querySelector("footer")!;
    expect(within(footer).queryByRole("button", { name: "View linux dependencies" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "View linux dependencies" })).toHaveClass("pf-m-link");
    expect(within(dialog).getByRole("button", { name: "View linux history" })).toHaveClass("pf-m-link");
    expect(within(footer).getByRole("button", { name: "Remove linux" }).closest(".pf-v6-u-ml-auto")).toBeInTheDocument();
    expect(footer.querySelectorAll(".pf-v6-c-button.pf-m-primary")).toHaveLength(0);

    await openActions();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Ignore linux", "Mark linux as a dependency", "Reinstall linux", "Downgrade linux…",
    ]);
  });

  it("opens downgrade with the refreshed installed version", async () => {
    mockSetInstallReason.mockResolvedValueOnce({ success: true, name: "linux", reason: "dependency", previous: "explicit" });
    mockGetPackageInfo.mockResolvedValueOnce({ ...mockPackageDetails, reason: "dependency", version: "6.8.0-arch1-1" });
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />);
    await chooseAction("Mark linux as a dependency");
    await chooseAction("Downgrade linux…");

    const dialog = screen.getByRole("dialog", { name: "Downgrade linux" });
    expect(await within(dialog).findByText("6.8.0-arch1-1")).toBeInTheDocument();
  });

  it("Reinstall opens a previewed reinstall dialog, then returns to re-read details with a notice", async () => {
    mockPreviewInstall.mockResolvedValue({
      ...emptyPreview,
      add: [{ name: "linux", version: mockPackageDetails.version, repo: "core", download_size: 1, installed_size: 1, old_version: mockPackageDetails.version, reason: "target" }],
    });
    let callbacks: api.UpgradeCallbacks | undefined;
    mockInstallPackage.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    mockGetPackageInfo.mockResolvedValue({ ...mockPackageDetails, install_date: 1800000000 });
    const onClose = vi.fn();
    const onPackageInstalled = vi.fn();
    render(
      <PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={onClose} onPackageInstalled={onPackageInstalled} />
    );

    await chooseAction("Reinstall linux");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(await screen.findByRole("dialog", { name: "Reinstall linux" })).toBeInTheDocument();
    expect(mockPreviewInstall).toHaveBeenCalledWith("linux", { repo: "core", version: mockPackageDetails.version, reinstall: true });
    fireEvent.click(await screen.findByRole("button", { name: /^Reinstall linux/ }));
    expect(mockInstallPackage).toHaveBeenCalledWith(expect.any(Object), "linux", [], { repo: "core", version: mockPackageDetails.version, reinstall: true });
    await act(async () => callbacks!.onComplete());
    expect(onPackageInstalled).toHaveBeenCalledTimes(1);
    expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");

    fireEvent.click(within(screen.getByRole("dialog", { name: "Reinstall linux" })).getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!);
    expect(onClose).not.toHaveBeenCalled();
    const details = screen.getByRole("dialog", { name: /^linux/ });
    expect(within(details).getByRole("heading", { name: /linux reinstalled/ })).toBeInTheDocument();
  });

  it("disables Reinstall for a package that is in no sync database", async () => {
    render(<PackageDetailsModal packageDetails={{ ...mockPackageDetails, repository: "" }} isLoading={false} onClose={vi.fn()} />);
    await openActions();
    expect(action("Reinstall linux")).toHaveAttribute("aria-disabled", "true");
    expect(action("Reinstall linux")).toHaveAccessibleDescription("linux is in no configured repository, so there is no build to reinstall");
    expect(action("Mark linux as a dependency")).toBeInTheDocument();
    expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
  });

  it("gives an outdated package no runnable Reinstall, reading the repository version itself", async () => {
    let resolveSync!: (details: api.SyncPackageDetails) => void;
    mockGetSyncPackageInfo.mockReturnValue(new Promise((resolve) => { resolveSync = resolve; }));
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />);
    await openActions();
    const names = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(action("Reinstall linux")).toHaveAttribute("aria-disabled", "true");
    expect(action("Reinstall linux")).toHaveAccessibleDescription("Checking the repository version…");
    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("linux", "core");
    sweepA11y({ dialogs: [/^linux/] });

    await act(async () => resolveSync({ ...linuxInRepo, version: "6.8.0-arch1-1" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(names);
    const reinstall = action("Reinstall linux");
    expect(reinstall).toHaveAttribute("aria-disabled", "true");
    expect(reinstall).toHaveAccessibleDescription("core has 6.8.0-arch1-1; reinstalling would upgrade linux alone. Upgrade it from Updates");
    await act(async () => {
      fireEvent.click(reinstall);
    });
    expect(screen.queryByRole("dialog", { name: "Reinstall linux" })).not.toBeInTheDocument();
    expect(mockPreviewInstall).not.toHaveBeenCalled();
  });

  it("uses the host's repository version instead of reading it", async () => {
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} syncVersion="6.8.0-arch1-1" />);
    await openActions();
    expect(action("Reinstall linux")).toHaveAccessibleDescription("core has 6.8.0-arch1-1; reinstalling would upgrade linux alone. Upgrade it from Updates");
    expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
  });

  it("offers a package that is not installed only Install, with no Actions menu or Remove", async () => {
    render(<PackageDetailsModal packageDetails={mockSyncPackageDetails} isLoading={false} onClose={vi.fn()} onViewHistory={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Install linux" })).toHaveClass("pf-m-primary");
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove linux" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View linux history" })).toBeInTheDocument();
  });

  it("parses optional dependency names", () => {
    expect(optdepName("wireless-regdb: to set the correct wireless channels")).toBe("wireless-regdb");
    expect(optdepName("python-foo>=1.2: for bar")).toBe("python-foo");
    expect(optdepName("bash")).toBe("bash");
  });

  it("labels installed optional dependencies", () => {
    render(
      <PackageDetailsModal
        packageDetails={{ ...mockPackageDetails, optdepends: ["wireless-regdb", "crda"], installed_optdepends: ["wireless-regdb"] }}
        isLoading={false}
        onClose={vi.fn()}
      />
    );
    const items = screen.getAllByRole("listitem").filter((li) => li.querySelector("[data-optdep]"));
    expect(items.map((li) => li.textContent)).toEqual(["wireless-regdb installed", "crda"]);
  });

  it("an optional dependency opens in the same dialog with a back link, and Escape returns to the original", async () => {
    mockGetPackageInfo.mockRejectedValueOnce(new api.BackendError("Package 'wireless-regdb' not found", "not_found"));
    const regdb = { ...mockSyncPackageDetails, name: "wireless-regdb", version: "2024.01.23-1", repository: "extra", optdepends: [] };
    mockGetSyncPackageInfo.mockImplementation(async (name) => (name === "wireless-regdb" ? regdb : linuxInRepo));
    const onClose = vi.fn();
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "wireless-regdb" }));
    });
    expect(mockGetPackageInfo).toHaveBeenCalledWith("wireless-regdb");
    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("wireless-regdb", undefined);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/^wireless-regdb/);
    const back = screen.getByRole("button", { name: "Back to linux" });
    expect(back).toHaveTextContent("linux");
    expect(back).toHaveFocus();

    await act(async () => {
      fireEvent.keyDown(back, { key: "Escape" });
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/^linux/);
    expect(screen.getByRole("button", { name: "wireless-regdb" })).toHaveFocus();
  });

  it("shows local database failures for optional dependencies without falling back to sync", async () => {
    mockGetPackageInfo.mockRejectedValueOnce(new api.BackendError("Cannot read wireless-regdb", "permission_denied", "Cannot open the local database"));
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "wireless-regdb" })); });

    expect(mockGetSyncPackageInfo).not.toHaveBeenCalledWith("wireless-regdb", undefined);
    expect(screen.getByRole("heading", { name: "Could not load package details" })).toBeInTheDocument();
    expect(screen.getByText("Cannot read wireless-regdb")).toBeInTheDocument();
    expect(screen.getByText("Cannot open the local database")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install wireless-regdb" })).not.toBeInTheDocument();
  });

  it("lazily fetches per-package advisories when the section is expanded", async () => {
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={vi.fn()}
      />
    );

    expect(mockGetSecurityInfo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Security advisories"));

    await waitFor(() => {
      expect(mockGetSecurityInfo).toHaveBeenCalledWith("linux");
    });
    await waitFor(() => {
      expect(screen.getByText(/AVG-2024-1/)).toBeInTheDocument();
    });
  });

  it("shows an empty state when a package has no advisories", async () => {
    mockGetSecurityInfo.mockResolvedValue({ name: "linux", advisories: [], groups: [], issues: [] });
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Security advisories"));

    await waitFor(() => {
      expect(screen.getByText(/No advisories for this package/i)).toBeInTheDocument();
    });
  });

  it("says so when advisories are turned off, rather than showing none", async () => {
    mockGetSecurityInfo.mockResolvedValue({
      name: "linux",
      advisories: [],
      groups: [],
      issues: [],
      disabled: true,
    });
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Security advisories"));

    await waitFor(() => {
      expect(screen.getByText(/turned off for this system/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/No advisories for this package/i)).not.toBeInTheDocument();
  });

  it("Remove closes details and names the removal confirm button after the package", async () => {
    const onClose = vi.fn();
    const Harness = () => {
      const [details, setDetails] = useState<typeof mockPackageDetails | null>(mockPackageDetails);
      return <PackageDetailsModal packageDetails={details} isLoading={false} onClose={() => { onClose(); setDetails(null); }} />;
    };
    mockPreviewRemove.mockResolvedValue({
      success: true,
      add: [],
      remove: [{ name: "linux", version: mockPackageDetails.version, installed_size: 1024, reason: "target" }],
      conflicts: [],
      replacements: [],
      providers: [],
      import_keys: [],
      warnings: [],
      blocked_by: [],
      total_download_size: 0,
      net_installed_size: -1024,
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Remove linux" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Remove linux" })).toBeInTheDocument();
    expect(mockPreviewRemove).toHaveBeenCalledWith("linux");
  });

  it("keeps a running downgrade open on Escape and backdrop", async () => {
    const cancel = vi.fn();
    mockDowngradePackage.mockReturnValue({ cancel, forceStop: vi.fn() });
    const onClose = vi.fn();
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={onClose}
      />
    );

    await chooseAction("Downgrade linux…");
    await screen.findByText("6.6.0-arch1-1");
    fireEvent.click(screen.getByRole("button", { name: "Select 6.6.0-arch1-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade linux to 6.6.0-arch1-1" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    document.querySelectorAll(".pf-v6-c-backdrop").forEach((b) => fireEvent.mouseDown(b));
    expect(onClose).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it.each(["Escape", "backdrop"])("%s on an idle downgrade returns to details", async (trigger) => {
    const onClose = vi.fn();
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={onClose} />);

    await chooseAction("Downgrade linux…");
    await screen.findByText("6.6.0-arch1-1");
    const downgradeDialog = screen.getByRole("dialog");
    expect(downgradeDialog).toHaveAccessibleName("Downgrade linux");
    await act(async () => {
      if (trigger === "Escape") {
        fireEvent.keyDown(within(downgradeDialog).getByRole("button", { name: "Cancel" }), { key: "Escape" });
      } else {
        fireEvent.mouseDown(document.querySelector(".pf-v6-c-backdrop")!);
      }
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/^linux/);
  });

  it("Open Keyring closes the downgrade and hides the inactive details", async () => {
    let callbacks: api.UpgradeCallbacks | undefined;
    mockDowngradePackage.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    const calls: string[] = [];
    const Harness = () => {
      const [details, setDetails] = useState<typeof mockPackageDetails | null>(mockPackageDetails);
      const [tab, setTab] = useState("installed");
      return (
        <NavigationProvider value={{ onViewKeyring: () => { calls.push("keyring"); setTab("keyring"); } }}>
          <DowngradeProvider>
            <div role="tabpanel" id="installed" hidden={tab !== "installed"} />
            <div role="tabpanel" id="keyring" hidden={tab !== "keyring"} />
            <TabActiveContext.Provider value={tab === "installed"}>
              <PackageDetailsModal
                packageDetails={details}
                isLoading={false}
                onClose={() => {
                  calls.push("close");
                  setDetails(null);
                }}
              />
            </TabActiveContext.Provider>
          </DowngradeProvider>
        </NavigationProvider>
      );
    };
    renderBare(<Harness />);

    await chooseAction("Downgrade linux…");
    await screen.findByText("6.6.0-arch1-1");
    fireEvent.click(screen.getByRole("button", { name: "Select 6.6.0-arch1-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade linux to 6.6.0-arch1-1" }));
    act(() => callbacks!.onError("linux: signature from \"Packager\" is unknown trust", "signature_error"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
    });
    expect(calls).toEqual(["keyring"]);
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });

  it("a finished downgrade returns to re-read details with a notice", async () => {
    let callbacks: api.UpgradeCallbacks | undefined;
    mockDowngradePackage.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    mockGetPackageInfo.mockResolvedValue({ ...mockPackageDetails, version: "6.6.0-arch1-1" });
    const onClose = vi.fn();
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={onClose}
      />
    );

    await chooseAction("Downgrade linux…");
    await screen.findByText("6.6.0-arch1-1");
    fireEvent.click(screen.getByRole("button", { name: "Select 6.6.0-arch1-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade linux to 6.6.0-arch1-1" }));
    await act(async () => callbacks!.onComplete());

    const downgradeDialog = screen.getByRole("dialog", { name: "Downgrade linux" });
    await act(async () => {
      fireEvent.click(within(downgradeDialog).getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!);
    });
    expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");
    expect(onClose).not.toHaveBeenCalled();
    const details = screen.getByRole("dialog");
    expect(details).toHaveAccessibleName("linux 6.6.0-arch1-1 core");
    expect(within(details).getByRole("heading", { name: /linux downgraded to 6.6.0-arch1-1/ })).toBeInTheDocument();
  });

  it("ignoring from the downgrade result updates the details label", async () => {
    let callbacks: api.UpgradeCallbacks | undefined;
    mockDowngradePackage.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    mockGetPackageInfo.mockResolvedValue({ ...mockPackageDetails, version: "6.6.0-arch1-1" });
    mockAddIgnoredPackage.mockImplementation(async () => {
      mockListIgnoredPackages.mockResolvedValue({ packages: ["linux"], total: 1 });
      return { success: true, package: "linux", message: "Package ignored" };
    });
    const onIgnored = vi.fn();
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} isIgnored={false} onIgnored={onIgnored} />);

    await chooseAction("Downgrade linux…");
    fireEvent.click(await screen.findByRole("button", { name: "Select 6.6.0-arch1-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade linux to 6.6.0-arch1-1" }));
    await act(async () => callbacks!.onComplete());
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Ignore linux in upgrades" }));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!);
    });
    expect(onIgnored).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Ignored").closest("[data-highlighted]")).toBeInTheDocument();
  });

  it("keeps the running downgrade when its details host is removed", async () => {
    let callbacks!: api.UpgradeCallbacks;
    const cancel = vi.fn();
    mockDowngradePackage.mockImplementation((next) => {
      callbacks = next;
      return { cancel, forceStop: vi.fn() };
    });
    const page = (source: boolean) => (
      <DowngradeProvider>
        {source && <PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />}
      </DowngradeProvider>
    );
    const { rerender } = renderBare(page(true));
    await chooseAction("Downgrade linux…");
    fireEvent.click(await screen.findByRole("button", { name: "Select 6.6.0-arch1-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade linux to 6.6.0-arch1-1" }));
    const dialog = screen.getByRole("dialog", { name: "Downgrade linux" });
    const log = within(dialog).getByRole("log");

    rerender(page(false));
    expect(screen.getByRole("dialog", { name: "Downgrade linux" })).toBe(dialog);
    expect(within(dialog).getByRole("log")).toBe(log);
    expect(cancel).not.toHaveBeenCalled();
    act(() => callbacks.onComplete());
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).find((button) => button.textContent === "Close")!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(["replacement", "unmount"])("ignores an old details readback after %s", async (change) => {
    let resolveDetails!: (details: api.PackageDetails) => void;
    mockGetPackageInfo.mockReturnValue(new Promise((resolve) => { resolveDetails = resolve; }));
    mockListIgnoredPackages.mockResolvedValue({ packages: ["linux"], total: 1 });
    const onIgnored = vi.fn();
    const details = (name: string) => (
      <PackageDetailsModal packageDetails={{ ...mockPackageDetails, name }} isLoading={false} onClose={vi.fn()} isIgnored={false} onIgnored={onIgnored} />
    );
    const { rerender, unmount } = render(details("linux"));
    await chooseAction("Downgrade linux…");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(mockGetPackageInfo).toHaveBeenCalledWith("linux");

    if (change === "replacement") rerender(details("bash"));
    else unmount();
    await act(async () => resolveDetails({ ...mockPackageDetails, version: "6.6.0-arch1-1" }));
    expect(onIgnored).not.toHaveBeenCalled();
    if (change === "replacement") {
      expect(screen.getByRole("dialog")).toHaveAccessibleName(/^bash 6.7.0-arch1-1/);
    } else {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }
  });

  it("Install from an optional dependency opens the install dialog in place of details", async () => {
    mockGetPackageInfo.mockRejectedValueOnce(new api.BackendError("Package 'wireless-regdb' not found", "not_found"));
    const regdb = { ...mockSyncPackageDetails, name: "wireless-regdb", version: "2024.01.23-1", repository: "extra", optdepends: [] };
    mockGetSyncPackageInfo.mockImplementation(async (name) => (name === "wireless-regdb" ? regdb : linuxInRepo));
    mockPreviewInstall.mockResolvedValue({
      ...emptyPreview,
      add: [{ name: "wireless-regdb", version: "2024.01.23-1", repo: "extra", download_size: 1, installed_size: 1, reason: "target" }],
    });
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "wireless-regdb" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install wireless-regdb" }));
    });

    expect(await screen.findByRole("button", { name: "Install wireless-regdb" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Install wireless-regdb");
    expect(mockPreviewInstall).toHaveBeenCalledWith("wireless-regdb", { repo: "extra", version: "2024.01.23-1" });
  });

  it("disables mutations without administrative access", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={vi.fn()}
        onViewHistory={vi.fn()}
      />
    );

    const remove = screen.getByRole("button", { name: "Remove linux" });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "View linux history" })).not.toHaveAttribute("aria-disabled");
    await openActions();
    expect(action("Downgrade linux…")).toHaveAttribute("aria-disabled", "true");
    expect(action("Ignore linux")).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(remove);
    expect(screen.queryByRole("button", { name: "Uninstall linux" })).not.toBeInTheDocument();
  });

  it("disables mutations while an upgrade runs and names it", async () => {
    const upgrade = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(upgrade);
    act(() => {
      api.runUpgrade({ onComplete: vi.fn(), onError: vi.fn() });
    });
    const { rerender } = render(
      <PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} onViewHistory={vi.fn()} />
    );

    await openActions();
    for (const name of ["Downgrade linux…", "Ignore linux", "Mark linux as a dependency", "Reinstall linux"]) {
      expect(action(name)).toHaveAttribute("aria-disabled", "true");
    }
    const reason = screen.getByRole("button", { name: "Remove linux" });
    expect(reason).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(reason);
    });
    expect(screen.queryByRole("button", { name: "Uninstall linux" })).not.toBeInTheDocument();
    expect(reason).toHaveAccessibleDescription(/An upgrade is running/);

    rerender(
      <PackageDetailsModal packageDetails={mockSyncPackageDetails} isLoading={false} onClose={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Install linux" })).toHaveAttribute("aria-disabled", "true");

    act(() => {
      upgrade._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
    });
    expect(screen.getByRole("button", { name: "Install linux" })).toHaveAttribute("aria-disabled", "true");
    act(() => { upgrade._complete(); });
    expect(screen.getByRole("button", { name: "Install linux" })).not.toHaveAttribute("aria-disabled");
  });

  it("disables mutations while administrative access is still being checked", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });
    render(
      <PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} onViewHistory={vi.fn()} />
    );

    expect(screen.getByRole("button", { name: "Remove linux" })).toHaveAttribute("aria-disabled", "true");
    await openActions();
    expect(action("Ignore linux")).toHaveAttribute("aria-disabled", "true");
    expect(action("Ignore linux")).toHaveAccessibleDescription("Checking administrative access…");
  });

  it("keeps focus on the Actions toggle while the registry and permission flip", async () => {
    const permission = {
      allowed: true as boolean | null,
      listener: null as (() => void) | null,
      addEventListener: vi.fn((_event: string, fn: () => void) => { permission.listener = fn; }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
    mockPermission.mockReturnValueOnce(permission);
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: "Actions" });
    act(() => toggle.focus());

    const upgrade = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(upgrade);
    act(() => {
      api.runUpgrade({ onComplete: vi.fn(), onError: vi.fn() });
    });
    expect(screen.getByRole("button", { name: "Remove linux" })).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(toggle);
    act(() => {
      upgrade._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
    });
    expect(document.activeElement).toBe(toggle);

    act(() => {
      permission.allowed = null;
      permission.listener?.();
    });
    expect(document.activeElement).toBe(toggle);
    act(() => {
      permission.allowed = true;
      permission.listener?.();
    });
    expect(screen.getByRole("button", { name: "Actions" })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  it("shows the Actions toggle busy and names the wait on the other verbs", async () => {
    let finish: () => void = () => {};
    mockAddIgnoredPackage.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ success: true, package: "linux", message: "Package ignored" });
    }));
    render(<PackageDetailsModal packageDetails={mockPackageDetails} isLoading={false} onClose={vi.fn()} />);
    await screen.findByText("Included");
    const toggle = screen.getByRole("button", { name: "Actions" });
    await chooseAction("Ignore linux");

    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(document.activeElement).toBe(toggle);
    await openActions();
    expect(action("Mark linux as a dependency")).toHaveAccessibleDescription("Ignoring linux…");
    fireEvent.keyDown(action("Mark linux as a dependency"), { key: "Escape" });

    await act(async () => finish());
    expect(toggle).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("Ignored")).toBeInTheDocument();
  });

  it("shows an inline error and stays open when ignoring fails", async () => {
    mockAddIgnoredPackage.mockRejectedValue(new api.BackendError("cannot write pacman.conf", "permission_denied", "The configuration directory is read-only"));
    const onClose = vi.fn();
    const onIgnored = vi.fn();
    render(
      <PackageDetailsModal
        packageDetails={mockPackageDetails}
        isLoading={false}
        onClose={onClose}
        onIgnored={onIgnored}
      />
    );

    await screen.findByText("Included");
    await chooseAction("Ignore linux");

    expect(await screen.findByRole("heading", { name: /Could not ignore linux/ })).toBeInTheDocument();
    expect(screen.getByText("cannot write pacman.conf")).toBeInTheDocument();
    expect(screen.getByText("The configuration directory is read-only")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onIgnored).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { PackageActionModal, installConfig, uninstallConfig } from "./PackageActionModal";
import { NavigationProvider } from "../contexts/NavigationContext";
import { mockUpdatesResponse } from "../test/mocks";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    checkUpdates: vi.fn(),
    installPackage: vi.fn(),
    removePackage: vi.fn(),
  };
});

const mockCheckUpdates = vi.mocked(api.checkUpdates);

function renderModal(config: typeof installConfig, onViewUpdates?: () => void, onClose = vi.fn()) {
  render(
    <NavigationProvider value={{ onViewUpdates }}>
      <PackageActionModal
        packageName="htop"
        packageVersion="3.3.0-1"
        isOpen
        onClose={onClose}
        config={config}
      />
    </NavigationProvider>
  );
  return onClose;
}

describe("PackageActionModal pending-updates warning", () => {
  beforeEach(() => {
    mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [] });
    vi.mocked(api.installPackage).mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("warns before an install, including ignored updates", async () => {
    mockCheckUpdates.mockResolvedValue({
      updates: [
        mockUpdatesResponse.updates[0],
        { ...mockUpdatesResponse.updates[0], name: "glibc", ignored: true },
      ],
      warnings: [],
    });

    renderModal(installConfig, vi.fn());

    const warning = await screen.findByText("2 system updates pending");
    expect(warning.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
  });

  it("shows no warning when the system is up to date", async () => {
    renderModal(installConfig, vi.fn());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Confirm Install" })).toBeEnabled();
    });
    expect(screen.queryByText(/system updates? pending/)).not.toBeInTheDocument();
  });

  it("does not check updates for an uninstall", async () => {
    renderModal(uninstallConfig, vi.fn());

    await screen.findByRole("button", { name: "Confirm Uninstall" });
    expect(mockCheckUpdates).not.toHaveBeenCalled();
  });

  it("waits for the update check before allowing installation", async () => {
    let resolveUpdates!: (response: api.UpdatesResponse) => void;
    mockCheckUpdates.mockReturnValue(new Promise((resolve) => { resolveUpdates = resolve; }));
    renderModal(installConfig);

    const confirm = screen.getByRole("button", { name: /Confirm Install/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(api.installPackage).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpdates(mockUpdatesResponse);
    });

    expect(screen.getByText("1 system update pending")).toBeInTheDocument();
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(api.installPackage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.installPackage).mock.calls[0][1]).toBe("htop");
    expect(screen.queryByText("1 system update pending")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm Install" })).not.toBeInTheDocument();

    act(() => vi.mocked(api.installPackage).mock.calls[0][0].onComplete());
    expect(screen.getByText("Package installed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm Install" })).not.toBeInTheDocument();
  });

  it("reports a failed check and allows installation", async () => {
    mockCheckUpdates.mockRejectedValue(new Error("backend unavailable"));
    renderModal(installConfig);

    const warning = await screen.findByText("Could not check for pending updates");
    expect(warning.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("backend unavailable")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm Install" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(api.installPackage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.installPackage).mock.calls[0][1]).toBe("htop");
  });

  it("ignores an old update check after the modal is reopened", async () => {
    let resolveOldCheck!: (response: api.UpdatesResponse) => void;
    let resolveNewCheck!: (response: api.UpdatesResponse) => void;
    mockCheckUpdates.mockReturnValueOnce(new Promise((resolve) => { resolveOldCheck = resolve; }));
    mockCheckUpdates.mockReturnValueOnce(new Promise((resolve) => { resolveNewCheck = resolve; }));
    const props = {
      packageName: "htop",
      packageVersion: "3.3.0-1",
      onClose: vi.fn(),
      config: installConfig,
    };
    const { rerender } = render(<PackageActionModal {...props} isOpen />);
    rerender(<PackageActionModal {...props} isOpen={false} />);
    rerender(<PackageActionModal {...props} isOpen />);

    await act(async () => {
      resolveOldCheck(mockUpdatesResponse);
    });

    expect(mockCheckUpdates).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/system updates? pending/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm Install/ })).toBeDisabled();

    await act(async () => {
      resolveNewCheck({ updates: [], warnings: [] });
    });
    expect(screen.getByRole("button", { name: "Confirm Install" })).toBeEnabled();
    expect(screen.queryByText(/system updates? pending/)).not.toBeInTheDocument();
  });

  it("navigates to the Updates tab and closes from the warning action", async () => {
    mockCheckUpdates.mockResolvedValue(mockUpdatesResponse);
    const onViewUpdates = vi.fn();
    const onClose = renderModal(installConfig, onViewUpdates);

    fireEvent.click(await screen.findByRole("button", { name: "Review updates" }));

    expect(onViewUpdates).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.installPackage).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { UpdatesView } from "./UpdatesView";
import * as api from "../api";
import {
  mockUpdatesResponse,
  mockPreflightResponse,
  mockPreflightWithConflicts,
  mockPreflightWithKeys,
  mockSyncPackageDetails,
} from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    checkUpdates: vi.fn(),
    preflightUpgrade: vi.fn(),
    runUpgrade: vi.fn(),
    syncDatabase: vi.fn(),
    getSyncPackageInfo: vi.fn(),
  };
});

const mockCheckUpdates = vi.mocked(api.checkUpdates);
const mockPreflightUpgrade = vi.mocked(api.preflightUpgrade);
const mockRunUpgrade = vi.mocked(api.runUpgrade);
const mockSyncDatabase = vi.mocked(api.syncDatabase);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);

describe("UpdatesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckUpdates.mockResolvedValue(mockUpdatesResponse);
    mockPreflightUpgrade.mockResolvedValue(mockPreflightResponse);
    mockGetSyncPackageInfo.mockResolvedValue(mockSyncPackageDetails);
    mockRunUpgrade.mockReturnValue({ cancel: vi.fn() });
    mockSyncDatabase.mockImplementation((callbacks) => {
      setTimeout(() => callbacks.onComplete(), 0);
      return { cancel: vi.fn() };
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe("Initial Load", () => {
    it("shows loading spinner while checking for updates", async () => {
      mockCheckUpdates.mockImplementation(() => new Promise(() => {}));
      render(<UpdatesView />);
      expect(screen.getByText("Querying package databases...")).toBeInTheDocument();
    });

    it("calls checkUpdates on initial load", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(mockCheckUpdates).toHaveBeenCalled();
      });
    });

    it("displays available updates after loading", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      expect(screen.getByText(/6\.7\.0-arch1-1.*6\.7\.1-arch1-1/)).toBeInTheDocument();
    });

    it("shows up to date message when no updates available", async () => {
      mockCheckUpdates.mockResolvedValue({ updates: [], warnings: [] });
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("System is up to date")).toBeInTheDocument();
      });
    });
  });

  describe("Refresh Button", () => {
    it("triggers database sync when clicking refresh", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const refreshButton = screen.getByRole("button", { name: /Refresh/i });
      await act(async () => {
        fireEvent.click(refreshButton);
      });

      expect(mockSyncDatabase).toHaveBeenCalled();
    });
  });

  describe("Package Selection", () => {
    it("all packages are selected by default", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
      expect(screen.getByText(/1 of 1 update/)).toBeInTheDocument();
    });

    it("deselecting a package shows partial upgrade warning", async () => {
      const multiUpdateResponse = {
        updates: [
          ...mockUpdatesResponse.updates,
          {
            name: "glibc",
            current_version: "2.38-1",
            new_version: "2.39-1",
            download_size: 50000000,
            current_size: 45000000,
            new_size: 48000000,
            repository: "core",
          },
        ],
        warnings: [],
      };
      mockCheckUpdates.mockResolvedValue(multiUpdateResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole("checkbox");
      await act(async () => {
        fireEvent.click(checkboxes[1]);
      });

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /Partial upgrade/ })).toBeInTheDocument();
      });
    });

    it("select all checkbox toggles all packages", async () => {
      const multiUpdateResponse = {
        updates: [
          ...mockUpdatesResponse.updates,
          {
            name: "glibc",
            current_version: "2.38-1",
            new_version: "2.39-1",
            download_size: 50000000,
            current_size: 45000000,
            new_size: 48000000,
            repository: "core",
          },
        ],
        warnings: [],
      };
      mockCheckUpdates.mockResolvedValue(multiUpdateResponse);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText(/2 of 2 update/)).toBeInTheDocument();
      });

      const selectAllCheckbox = screen.getByLabelText("Select all updates");
      await act(async () => {
        fireEvent.click(selectAllCheckbox);
      });

      await waitFor(() => {
        expect(screen.getByText(/0 of 2 update/)).toBeInTheDocument();
      });
    });
  });

  describe("Apply Updates Flow", () => {
    it("runs preflight check before applying updates", async () => {
      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      expect(mockPreflightUpgrade).toHaveBeenCalled();
    });

    it("starts upgrade directly when no conflicts", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({ type: "complete", success: true });
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(mockRunUpgrade).toHaveBeenCalled();
      });
    });

    it("shows confirmation modal when conflicts exist", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithConflicts);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Confirm Upgrade")).toBeInTheDocument();
      });
      expect(screen.getByText(/mesa conflicts with mesa-amber/)).toBeInTheDocument();
    });

    it("shows key import warning in confirmation modal", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithKeys);

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Confirm Upgrade")).toBeInTheDocument();
      });
      expect(screen.getByText(/ABCD1234/)).toBeInTheDocument();
      expect(screen.getByText(/Test Packager/)).toBeInTheDocument();
    });

    it("proceeds with upgrade after confirming modal", async () => {
      mockPreflightUpgrade.mockResolvedValue(mockPreflightWithConflicts);
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Confirm Upgrade")).toBeInTheDocument();
      });

      const proceedButton = screen.getByRole("button", { name: /Proceed with Upgrade/i });
      await act(async () => {
        fireEvent.click(proceedButton);
      });

      expect(mockRunUpgrade).toHaveBeenCalled();
    });
  });

  describe("Upgrade Progress", () => {
    it("shows progress during download phase", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({
            type: "download",
            filename: "linux-6.7.1-arch1-1.pkg.tar.zst",
            event: "progress",
            downloaded: 50000000,
            total: 150000000,
          });
        }, 0);
        return { cancel: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Applying Updates")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText("Downloading packages")).toBeInTheDocument();
      });
    });

    it("shows progress during install phase", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({
            type: "progress",
            operation: "upgrading",
            package: "linux",
            percent: 50,
            current: 1,
            total: 1,
          });
        }, 0);
        return { cancel: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Applying Updates")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText("Upgrading packages")).toBeInTheDocument();
      });
    });
  });

  describe("Cancel Upgrade", () => {
    it("shows cancel confirmation modal", async () => {
      mockRunUpgrade.mockReturnValue({ cancel: vi.fn() });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Applying Updates")).toBeInTheDocument();
      });

      const cancelButton = screen.getByRole("button", { name: "Cancel" });
      await act(async () => {
        fireEvent.click(cancelButton);
      });

      expect(screen.getByText("Cancel upgrade?")).toBeInTheDocument();
    });

    it("calls cancel function when confirmed", async () => {
      const cancelFn = vi.fn();
      mockRunUpgrade.mockReturnValue({ cancel: cancelFn });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("Applying Updates")).toBeInTheDocument();
      });

      const cancelButton = screen.getByRole("button", { name: "Cancel" });
      await act(async () => {
        fireEvent.click(cancelButton);
      });

      const confirmCancelButton = screen.getByRole("button", { name: /Cancel Upgrade/i });
      await act(async () => {
        fireEvent.click(confirmCancelButton);
      });

      expect(cancelFn).toHaveBeenCalled();
    });
  });

  describe("Error States", () => {
    it("displays general error message", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Network error"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText(/Network error/)).toBeInTheDocument();
      });
    });

    it("displays lock error with special message", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Unable to lock database"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText("Database is locked")).toBeInTheDocument();
      });
      expect(screen.getByText(/Another package manager operation/)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      mockCheckUpdates.mockRejectedValue(new Error("Network error"));
      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      });
    });

    it("retries loading when clicking retry button", async () => {
      mockCheckUpdates.mockRejectedValueOnce(new Error("Network error"));
      mockCheckUpdates.mockResolvedValueOnce(mockUpdatesResponse);

      render(<UpdatesView />);

      await waitFor(() => {
        expect(screen.getByText(/Network error/)).toBeInTheDocument();
      });

      const retryButton = screen.getByRole("button", { name: "Retry" });
      await act(async () => {
        fireEvent.click(retryButton);
      });

      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });
    });

    it("displays preflight error", async () => {
      mockPreflightUpgrade.mockResolvedValue({
        success: false,
        error: "Failed to calculate dependencies",
        packages_to_upgrade: 0,
        total_download_size: 0,
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to calculate dependencies/)).toBeInTheDocument();
      });
    });
  });

  describe("Success State", () => {
    it("shows success message after upgrade completes", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onEvent?.({ type: "complete", success: true });
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("System Updated")).toBeInTheDocument();
      });
      expect(screen.getByText("All packages have been updated successfully.")).toBeInTheDocument();
    });

    it("shows check again button after success", async () => {
      mockRunUpgrade.mockImplementation((callbacks) => {
        setTimeout(() => {
          callbacks.onComplete();
        }, 0);
        return { cancel: vi.fn() };
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      const applyButton = screen.getByRole("button", { name: /Apply 1 Update/i });
      await act(async () => {
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText("System Updated")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Check Again" })).toBeInTheDocument();
    });
  });

  describe("Warnings Display", () => {
    it("displays warnings from checkUpdates response", async () => {
      mockCheckUpdates.mockResolvedValue({
        updates: mockUpdatesResponse.updates,
        warnings: ["Package foo has been replaced by bar"],
      });

      render(<UpdatesView />);
      await waitFor(() => {
        expect(screen.getByText("linux")).toBeInTheDocument();
      });

      expect(screen.getByText(/Package foo has been replaced by bar/)).toBeInTheDocument();
    });
  });
});

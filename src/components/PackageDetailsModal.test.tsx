import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { PackageDetailsModal } from "./PackageDetailsModal";
import * as api from "../api";
import { mockPackageDetails, mockSyncPackageDetails } from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    addIgnoredPackage: vi.fn(),
  };
});

const mockAddIgnoredPackage = vi.mocked(api.addIgnoredPackage);

describe("PackageDetailsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddIgnoredPackage.mockResolvedValue({ success: true, package: "linux", message: "Package ignored" });
  });

  afterEach(() => {
    cleanup();
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

  it("clicking Ignore calls addIgnoredPackage then onIgnored and onClose", async () => {
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

    const ignoreButton = screen.getByRole("button", { name: /Ignore/i });
    await act(async () => {
      fireEvent.click(ignoreButton);
    });

    await waitFor(() => {
      expect(mockAddIgnoredPackage).toHaveBeenCalledWith("linux");
    });
    expect(onIgnored).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

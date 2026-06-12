import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { SignoffsView } from "./SignoffsView";
import * as api from "../api";
import { mockSyncPackageDetails } from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getSignoffList: vi.fn(),
    signoffPackage: vi.fn(),
    revokeSignoff: vi.fn(),
    getPackageInfo: vi.fn(),
    getSyncPackageInfo: vi.fn(),
  };
});

const mockGetSignoffList = vi.mocked(api.getSignoffList);
const mockGetPackageInfo = vi.mocked(api.getPackageInfo);
const mockGetSyncPackageInfo = vi.mocked(api.getSyncPackageInfo);

const credentials: api.KeyringCredentials = {
  username: "alice",
  password: "secret",
};

const signoffList: api.SignoffListResponse = {
  signoff_groups: [
    {
      pkgbase: "vlc",
      pkgnames: ["vlc-plugin-foo"],
      version: "3.0.21-2",
      arch: "x86_64",
      repo: "extra-testing",
      packager: "tester",
      known_bad: false,
      approved: false,
      required: 2,
      enabled: true,
      signoffs: [],
      local_version: "3.0.21-1",
      version_match: "mismatch",
    },
  ],
  total: 1,
};

describe("SignoffsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSignoffList.mockResolvedValue(signoffList);
  });

  afterEach(() => {
    cleanup();
  });

  it("falls back to sync package details when the local lookup fails", async () => {
    mockGetPackageInfo.mockRejectedValue(new Error("Package 'vlc' not found"));
    mockGetSyncPackageInfo.mockResolvedValue({
      ...mockSyncPackageDetails,
      name: "vlc",
      version: "3.0.21-2",
      description: "VLC media player",
      repository: "extra-testing",
    });

    render(<SignoffsView credentials={credentials} />);

    const packageButton = await screen.findByRole("button", { name: "vlc" });
    await act(async () => {
      fireEvent.click(packageButton);
    });

    await waitFor(() => {
      expect(mockGetPackageInfo).toHaveBeenCalledWith("vlc");
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("vlc", "extra-testing");
    });
    expect(await screen.findByText("VLC media player")).toBeInTheDocument();
  });

  it("skips the local lookup for packages that are not installed", async () => {
    mockGetSignoffList.mockResolvedValue({
      signoff_groups: [{
        ...signoffList.signoff_groups[0],
        local_version: null,
        version_match: "not_installed",
      }],
      total: 1,
    });
    mockGetSyncPackageInfo.mockResolvedValue({
      ...mockSyncPackageDetails,
      name: "vlc",
      version: "3.0.21-2",
      description: "VLC media player",
      repository: "extra-testing",
    });

    render(<SignoffsView credentials={credentials} />);

    const installedToggle = await screen.findByRole("button", { name: /^Installed/ });
    await act(async () => {
      fireEvent.click(installedToggle);
    });

    const packageButton = await screen.findByRole("button", { name: "vlc" });
    await act(async () => {
      fireEvent.click(packageButton);
    });

    await waitFor(() => {
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("vlc", "extra-testing");
    });
    expect(mockGetPackageInfo).not.toHaveBeenCalled();
    expect(await screen.findByText("VLC media player")).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { SignoffsView } from "./SignoffsView";
import * as api from "../api";
import { mockSyncPackageDetails } from "../test/mocks";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getSignoffList: vi.fn(),
    signoffPackage: vi.fn(),
    signoffPackages: vi.fn(),
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
      last_update: "2024-01-01T00:00:00Z",
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
    mockGetPackageInfo.mockRejectedValue(new api.BackendError("Package 'vlc' not found", "not_found"));
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


describe("bulk signoff", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("uses one batch call and retains failed targets after refreshing", async () => {
    const groups = [signoffList.signoff_groups[0], { ...signoffList.signoff_groups[0], pkgbase: "htop", pkgnames: ["htop"] }];
    mockGetSignoffList.mockResolvedValue({ signoff_groups: groups, total: 2 });
    const target = (pkgbase: string) => ({ pkgbase, repo: "extra-testing", arch: "x86_64" });
    vi.mocked(api.signoffPackages).mockResolvedValue({ results: [
      { target: target("vlc"), success: true },
      { target: target("htop"), success: false, error: "server rejected signoff" },
    ] });
    render(<SignoffsView credentials={credentials} />);
    await screen.findByRole("button", { name: "vlc" });
    fireEvent.click(screen.getByLabelText("Select all packages"));
    fireEvent.click(screen.getByRole("button", { name: "Sign off 2 packages" }));
    expect(await screen.findByText("htop: server rejected signoff")).toBeInTheDocument();
    expect(api.signoffPackages).toHaveBeenCalledExactlyOnceWith([target("vlc"), target("htop")], credentials);
    expect(api.signoffPackage).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "Sign off 1 package" });
    fireEvent.click(retry);
    await waitFor(() => expect(api.signoffPackages).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.signoffPackages).mock.lastCall?.[0]).toEqual([target("htop")]);
  });

  it("stops counting and resending targets the refresh shows as signed", async () => {
    const groups = [signoffList.signoff_groups[0], { ...signoffList.signoff_groups[0], pkgbase: "htop", pkgnames: ["htop"] }];
    const signed = { ...groups[1], signoffs: [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: false }] };
    mockGetSignoffList.mockResolvedValueOnce({ signoff_groups: groups, total: 2 });
    mockGetSignoffList.mockResolvedValue({ signoff_groups: [groups[0], signed], total: 2 });
    vi.mocked(api.signoffPackages).mockRejectedValueOnce(new Error("Connection reset"));
    vi.mocked(api.signoffPackages).mockResolvedValue({ results: [] });
    render(<SignoffsView credentials={credentials} />);
    await screen.findByRole("button", { name: "vlc" });
    fireEvent.click(screen.getByLabelText("Select all packages"));
    fireEvent.click(screen.getByRole("button", { name: "Sign off 2 packages" }));
    expect(await screen.findByText("Connection reset")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign off 1 package" }));
    await waitFor(() => expect(api.signoffPackages).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.signoffPackages).mock.lastCall?.[0]).toEqual([{ pkgbase: "vlc", repo: "extra-testing", arch: "x86_64" }]);
    expect(within(screen.getByRole("row", { name: /htop/ })).getByRole("checkbox")).not.toBeChecked();
  });

  it("retains every target when the batch request fails", async () => {
    mockGetSignoffList.mockResolvedValue(signoffList);
    vi.mocked(api.signoffPackages).mockRejectedValue(new Error("Session expired"));
    render(<SignoffsView credentials={credentials} />);
    await screen.findByRole("button", { name: "vlc" });
    fireEvent.click(screen.getByLabelText("Select all packages"));
    fireEvent.click(screen.getByRole("button", { name: "Sign off 1 package" }));
    expect(await screen.findByText("Session expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign off 1 package" })).toBeEnabled();
  });
});

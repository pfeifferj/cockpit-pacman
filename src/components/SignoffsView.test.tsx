import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { SignoffsView, SIGNOFF_STALE_MS, SIGNOFF_TILE_FILTER, countToSignOff } from "./SignoffsView";
import * as api from "../api";
import { mockSyncPackageDetails } from "../test/mocks";
import { sweepA11y } from "../test/a11ySweep";
import { TabActiveContext } from "../hooks/useRefreshOnActivate";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";

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
const mockSignoffPackages = vi.mocked(api.signoffPackages);
const mockSignoffPackage = vi.mocked(api.signoffPackage);
const mockRevokeSignoff = vi.mocked(api.revokeSignoff);
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

type Group = api.SignoffGroupWithLocal;

const group = (pkgbase: string, overrides: Partial<Group> = {}): Group => ({
  pkgbase,
  pkgnames: [pkgbase],
  version: "1.0-1",
  arch: "x86_64",
  repo: "core-testing",
  packager: "tester",
  last_update: "2024-01-01T00:00:00Z",
  known_bad: false,
  approved: false,
  required: 2,
  enabled: true,
  signoffs: [],
  local_version: "1.0-1",
  version_match: "match",
  ...overrides,
});

const listOf = (groups: Group[]): api.SignoffListResponse => ({ signoff_groups: groups, total: groups.length });

const ok = (pkgbase: string, action = "signoff"): api.SignoffActionResponse => ({ success: true, pkgbase, action, error: null });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const rowOf = (name: string) => screen.getByRole("button", { name }).closest("tr") as HTMLElement;

describe("SignoffsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSignoffList.mockResolvedValue(signoffList);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the build under signoff with the installed version beside it", async () => {
    mockGetSyncPackageInfo.mockResolvedValue({
      ...mockSyncPackageDetails,
      name: "vlc",
      version: "3.0.21-2",
      description: "VLC media player",
      repository: "extra-testing",
      installed_version: "3.0.21-1",
    });

    render(<SignoffsView credentials={credentials} />);

    const packageButton = await screen.findByRole("button", { name: "vlc" });
    await act(async () => {
      fireEvent.click(packageButton);
    });

    await waitFor(() => {
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("vlc", "extra-testing");
    });
    expect(mockGetPackageInfo).not.toHaveBeenCalled();
    expect(await screen.findByText("VLC media player")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /^vlc/ })).toHaveTextContent("Installed: 3.0.21-1");
  });

  it("replaces the details panel in place and returns focus to the row that opened it", async () => {
    mockGetSignoffList.mockResolvedValue(listOf([group("aaa"), group("bbb")]));
    mockGetSyncPackageInfo.mockImplementation(async (name: string) => ({ ...mockSyncPackageDetails, name }));
    render(<SignoffsView credentials={credentials} />);

    fireEvent.click(await screen.findByRole("button", { name: "aaa" }));
    await screen.findByRole("region", { name: /^aaa/ });
    const bbb = screen.getByRole("button", { name: "bbb" });
    bbb.focus();
    fireEvent.click(bbb);
    await screen.findByRole("region", { name: /^bbb/ });

    expect(screen.queryByRole("region", { name: /^aaa/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(rowOf("bbb")).toHaveAttribute("aria-current", "true");
    expect(rowOf("aaa")).not.toHaveAttribute("aria-current");
    expect(mockGetSyncPackageInfo).toHaveBeenLastCalledWith("bbb", "core-testing");
    sweepA11y();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: /^bbb/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "bbb" })).toHaveFocus();
  });

  it("names each row checkbox after its pkgbase and version", async () => {
    mockGetSignoffList.mockResolvedValue(listOf([group("aaa"), group("bbb", { version: "2.0-1" })]));
    render(<SignoffsView credentials={credentials} />);
    await screen.findByRole("button", { name: "aaa" });
    expect(screen.getAllByRole("checkbox", { name: "Select aaa 1.0-1" })).toHaveLength(1);
    expect(screen.getAllByRole("checkbox", { name: "Select bbb 2.0-1" })).toHaveLength(1);
    const rows = screen.getAllByRole("checkbox").filter((b) => b.closest("tbody"));
    expect(new Set(rows.map((b) => b.getAttribute("name"))).size).toBe(rows.length);
    expect(screen.queryAllByRole("checkbox", { name: /^Select row \d+$/ })).toHaveLength(0);
    expect(rowOf("aaa").querySelector('td[data-label="Select"]')).toContainElement(
      screen.getByRole("checkbox", { name: "Select aaa 1.0-1" }),
    );
    sweepA11y();
  });

  it("opens details on a row click but not from the select or action cells", async () => {
    mockGetSignoffList.mockResolvedValue(listOf([group("aaa"), group("bbb")]));
    mockGetSyncPackageInfo.mockImplementation(async (name: string) => ({ ...mockSyncPackageDetails, name }));
    render(<SignoffsView credentials={credentials} />);
    await screen.findByRole("button", { name: "aaa" });

    fireEvent.click(screen.getByRole("checkbox", { name: /^Select aaa / }));
    expect((screen.getByRole("checkbox", { name: /^Select aaa / }) as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(screen.getByRole("checkbox", { name: /^Select aaa / }), { key: " " });
    fireEvent.keyDown(screen.getByRole("button", { name: "Sign off aaa" }), { key: "Enter" });
    fireEvent.click(rowOf("aaa").querySelector('[data-label="Actions"]')!);
    expect(mockGetSyncPackageInfo).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: /^aaa/ })).not.toBeInTheDocument();

    fireEvent.click(within(rowOf("bbb")).getByText("core-testing"));
    await screen.findByRole("region", { name: /^bbb/ });
    expect(mockGetSyncPackageInfo).toHaveBeenCalledTimes(1);
    expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("bbb", "core-testing");
    expect(rowOf("bbb")).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(rowOf("aaa"), { key: "Enter" });
    await screen.findByRole("region", { name: /^aaa/ });
    expect(mockGetSyncPackageInfo).toHaveBeenLastCalledWith("aaa", "core-testing");
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

  it("sorts versions in pacman order", async () => {
    const base = { ...signoffList.signoff_groups[0], version_match: "not_installed" as const, local_version: null };
    mockGetSignoffList.mockResolvedValue({
      signoff_groups: [
        { ...base, pkgbase: "ten", version: "1.10-1" },
        { ...base, pkgbase: "nine", version: "1.9-1" },
      ],
      total: 2,
    });
    render(<SignoffsView credentials={credentials} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Installed/ }));
    await screen.findByRole("button", { name: "ten" });
    fireEvent.click(screen.getByRole("button", { name: "Version" }));

    const names = screen.getAllByRole("button", { name: /^(nine|ten)$/ }).map((b) => b.textContent);
    expect(names).toEqual(["nine", "ten"]);
  });

  it("offers status help as a named button that does not sort", async () => {
    render(<SignoffsView credentials={credentials} />);
    await screen.findByRole("button", { name: "vlc" });

    expect(screen.getAllByRole("button", { name: /^More information about/ })).toHaveLength(1);
    const statusHeader = screen.getByRole("columnheader", { name: /Status/ });
    const before = statusHeader.getAttribute("aria-sort");
    fireEvent.click(screen.getByRole("button", { name: "More information about signoff status" }));
    expect(await screen.findByText(/Flagged as broken by a package maintainer/)).toBeInTheDocument();
    expect(statusHeader.getAttribute("aria-sort")).toBe(before);
  });

  it("offers Clear filter when nothing matches and restores the rows", async () => {
    render(<SignoffsView credentials={credentials} />);
    await screen.findByRole("button", { name: "vlc" });

    const search = screen.getByRole("textbox");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(await screen.findByText("No matching packages")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(await screen.findByRole("button", { name: "vlc" })).toBeInTheDocument();
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
  });

  it.each([
    ["locked", /login keyring is locked/],
    ["malformed", /missing its username or password/],
  ] as const)("explains %s credentials and retries without loading the list", async (reason, text) => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(
      <SignoffsView credentials={null} unavailable={{ reason, message: "x" }} onRetryCredentials={onRetry} />,
    );

    expect(screen.getByText(text)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(mockGetSignoffList).not.toHaveBeenCalled();
  });

  it("shows the keyring message for other failures", () => {
    render(
      <SignoffsView credentials={null} unavailable={{ reason: "failed", message: "Access denied" }} onRetryCredentials={vi.fn()} />,
    );
    expect(screen.getByText("Access denied")).toBeInTheDocument();
  });

  describe("load failures", () => {
    it("shows a load failure with Try again instead of an empty list", async () => {
      mockGetSignoffList.mockRejectedValueOnce(new api.BackendError("ArchWeb returned 500", "internal_error"));
      render(<SignoffsView credentials={credentials} />);

      expect(await screen.findByText("Could not load signoffs")).toBeInTheDocument();
      expect(screen.getByText("ArchWeb returned 500")).toBeInTheDocument();
      expect(screen.queryByText("No matching packages")).toBeNull();
      expect(screen.queryByRole("heading", { name: /Error$/ })).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      expect(await screen.findByRole("button", { name: "vlc" })).toBeInTheDocument();
      expect(mockGetSignoffList).toHaveBeenCalledTimes(2);
    });

    it("keeps the rows when a refresh fails and offers Try again", async () => {
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "vlc" });

      mockGetSignoffList.mockRejectedValueOnce(new api.BackendError("ArchWeb returned 502", "internal_error"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      });

      expect(await screen.findByText("Could not refresh signoffs")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "vlc" })).toBeInTheDocument();
      expect(screen.queryByText("Could not load signoffs")).toBeNull();
    });

    it("explains rejected credentials and re-reads them on Try again", async () => {
      mockGetSignoffList.mockRejectedValueOnce(
        new api.BackendError("authentication failed: invalid credentials", "permission_denied"),
      );
      const onRetry = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(<SignoffsView credentials={credentials} onRetryCredentials={onRetry} />);

      expect(await screen.findByText("ArchWeb rejected the stored credentials")).toBeInTheDocument();
      expect(screen.getByText(/secret-tool store/)).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      expect(onRetry).toHaveBeenCalledTimes(1);

      rerender(<SignoffsView credentials={{ username: "alice", password: "rotated" }} onRetryCredentials={onRetry} />);
      expect(await screen.findByRole("button", { name: "vlc" })).toBeInTheDocument();
      expect(mockGetSignoffList).toHaveBeenLastCalledWith({ username: "alice", password: "rotated" });
      expect(screen.queryByText("ArchWeb rejected the stored credentials")).toBeNull();
    });

    it("keeps the table and offers the prefilled store command when a sign off is rejected at login", async () => {
      mockSignoffPackage.mockRejectedValueOnce(new api.BackendError("authentication failed", "permission_denied"));
      const onRetry = vi.fn().mockResolvedValue(undefined);
      render(<SignoffsView credentials={credentials} onRetryCredentials={onRetry} />);
      const target = await screen.findByRole("button", { name: "Sign off vlc" });
      await act(async () => {
        fireEvent.click(target);
      });

      const heading = await screen.findByRole("heading", { name: /ArchWeb rejected the stored credentials/ });
      const alert = heading.closest(".pf-v6-c-alert") as HTMLElement;
      expect(alert.closest("[aria-live]")).not.toBeNull();
      expect(within(alert).getByText(/username alice$/)).toBeInTheDocument();
      expect(within(alert).getByRole("button", { name: "Copy the store command" })).toBeInTheDocument();
      expect(screen.getByLabelText("Signoff packages")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign off vlc" })).toHaveAttribute("aria-disabled", "true");
      expect(mockGetSignoffList).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("announces a failed action and a failed refresh", async () => {
      mockSignoffPackage.mockResolvedValueOnce({ success: false, pkgbase: "vlc", action: "signoff", error: "POST returned 500" });
      render(<AnnouncerProvider><SignoffsView credentials={credentials} /></AnnouncerProvider>);
      const status = screen.getByRole("status");
      let announced = 0;
      new MutationObserver(() => {
        if (status.textContent) announced++;
      }).observe(status, { childList: true, characterData: true, subtree: true });
      const target = await screen.findByRole("button", { name: "Sign off vlc" });
      await act(async () => {
        fireEvent.click(target);
      });
      expect((await screen.findByText("Sign off failed for vlc")).closest("[aria-live]")).not.toBeNull();
      expect(within(rowOf("vlc")).getByText("Failed")).toBeInTheDocument();

      mockGetSignoffList.mockRejectedValueOnce(new api.BackendError("ArchWeb returned 502", "internal_error"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      });
      expect(await screen.findByRole("heading", { name: /Could not refresh signoffs/ })).toBeInTheDocument();
      await act(async () => { await Promise.resolve(); });
      expect(announced).toBe(1);
    });
  });

  describe("single sign off and revoke", () => {
    it("offers one verb per row by state and gates it with a reason", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([
        group("linux"),
        group("glibc", { signoffs: [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: false }] }),
        group("broken", { known_bad: true }),
      ]));
      render(<SignoffsView credentials={credentials} routeOptions={{ filter: "all" }} />);
      await screen.findByRole("button", { name: "Sign off linux" });

      expect(within(rowOf("linux")).queryByRole("button", { name: /^Revoke/ })).toBeNull();
      expect(within(rowOf("glibc")).getByRole("button", { name: "Revoke signoff for glibc" })).toBeInTheDocument();
      expect(within(rowOf("glibc")).queryByRole("button", { name: "Sign off glibc" })).toBeNull();
      const bad = screen.getByRole("button", { name: "Sign off broken" });
      expect(bad).toHaveAttribute("aria-disabled", "true");
      expect(bad).toHaveAccessibleDescription("Marked known bad; do not sign off");

      fireEvent.click(screen.getByRole("checkbox", { name: /^Select linux / }));
      expect(screen.getByRole("button", { name: "Sign off 1 package" })).toBeInTheDocument();
      sweepA11y();
    });

    it("patches the row at once, holds it until the reload settles and focuses the remaining verb", async () => {
      mockGetSignoffList.mockResolvedValueOnce(listOf([group("linux", { version: "6.11.3-1", local_version: "6.11.3-1" })]));
      const reload = deferred<api.SignoffListResponse>();
      mockGetSignoffList.mockReturnValueOnce(reload.promise);
      mockSignoffPackage.mockResolvedValue(ok("linux"));
      render(<SignoffsView credentials={credentials} />);

      const target = await screen.findByRole("button", { name: "Sign off linux" });
      target.focus();
      await act(async () => {
        fireEvent.click(target);
      });
      expect(mockSignoffPackage).toHaveBeenCalledWith("linux", "core-testing", "x86_64", credentials);
      expect(mockGetSignoffList).toHaveBeenCalledTimes(2);

      const revoke = screen.getByRole("button", { name: "Revoke signoff for linux" });
      expect(within(rowOf("linux")).getByText("1 / 2")).toBeInTheDocument();
      expect(within(rowOf("linux")).getByText("Signed off")).toBeInTheDocument();
      expect(revoke).toHaveFocus();
      expect(revoke).toHaveAttribute("aria-disabled", "true");
      expect(revoke).toHaveAccessibleDescription("Waiting for the signoff list to reload");
      fireEvent.click(revoke);
      expect(mockRevokeSignoff).not.toHaveBeenCalled();

      const settled = listOf([group("linux", {
        version: "6.11.3-1",
        local_version: "6.11.3-1",
        signoffs: [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: false }],
      })]);
      await act(async () => {
        reload.resolve(settled);
      });
      expect(screen.getByRole("button", { name: "Revoke signoff for linux" })).not.toHaveAttribute("aria-disabled");
      expect(within(rowOf("linux")).getByText("Signed off")).toBeInTheDocument();

      mockGetSignoffList.mockResolvedValueOnce(settled);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      });
      expect(screen.queryByRole("button", { name: "linux" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Nothing left to sign off" })).toBeInTheDocument();
    });

    it("signs off at once with an Undo named Revoke that revokes the same package", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([group("linux", { version: "6.11.3-1", local_version: "6.11.3-1" })]));
      mockSignoffPackage.mockResolvedValue(ok("linux"));
      mockRevokeSignoff.mockResolvedValue(ok("linux", "revoke"));
      render(<SignoffsView credentials={credentials} />);

      const target = await screen.findByRole("button", { name: "Sign off linux" });
      await act(async () => {
        fireEvent.click(target);
      });
      expect(await screen.findByText("Signed off linux 6.11.3-1")).toBeInTheDocument();
      expect(screen.getByText("Signed off linux 6.11.3-1").closest("[aria-live]")).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
      });
      expect(mockRevokeSignoff).toHaveBeenCalledWith("linux", "core-testing", "x86_64", credentials);
      expect(await screen.findByText("Signoff for linux revoked")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign off again" })).toBeInTheDocument();
    });

    it("revokes with an Undo named Sign off again", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([
        group("linux", { signoffs: [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: false }] }),
      ]));
      mockRevokeSignoff.mockResolvedValue(ok("linux", "revoke"));
      mockSignoffPackage.mockResolvedValue(ok("linux"));
      render(<SignoffsView credentials={credentials} routeOptions={{ filter: "all" }} />);

      const target = await screen.findByRole("button", { name: "Revoke signoff for linux" });
      await act(async () => {
        fireEvent.click(target);
      });
      expect(await screen.findByText("Signoff for linux revoked")).toBeInTheDocument();
      expect(within(rowOf("linux")).getByText("Revoked")).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Sign off again" }));
      });
      expect(mockSignoffPackage).toHaveBeenCalledWith("linux", "core-testing", "x86_64", credentials);
    });

    it("names an approval flip in the result", async () => {
      const signedByBob = [{ user: "bob", created: "2024-01-02T00:00:00Z", revoked: false }];
      mockGetSignoffList.mockResolvedValue(listOf([group("linux", { signoffs: signedByBob })]));
      mockSignoffPackage.mockResolvedValue(ok("linux"));
      render(<SignoffsView credentials={credentials} />);

      const target = await screen.findByRole("button", { name: "Sign off linux" });
      await act(async () => {
        fireEvent.click(target);
      });
      expect(await screen.findByText("Signed off linux 1.0-1; linux is now approved")).toBeInTheDocument();
    });

    it("titles a refused sign off with the package and retries it", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([group("linux")]));
      mockSignoffPackage.mockResolvedValueOnce({ success: false, pkgbase: "linux", action: "signoff", error: "POST returned 403" });
      mockSignoffPackage.mockResolvedValueOnce(ok("linux"));
      render(<SignoffsView credentials={credentials} />);

      const target = await screen.findByRole("button", { name: "Sign off linux" });
      await act(async () => {
        fireEvent.click(target);
      });
      expect(await screen.findByText("Sign off failed for linux")).toBeInTheDocument();
      expect(screen.getByText("POST returned 403")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      expect(mockSignoffPackage).toHaveBeenCalledTimes(2);
      expect(await screen.findByText("Signed off linux 1.0-1")).toBeInTheDocument();
    });
  });

  describe("bulk sign off", () => {
    beforeEach(() => {
      mockSignoffPackages.mockImplementation(async targets => ({
        results: targets.map(target => ({ target, success: true })),
      }));
    });
    it("selects the page from the header, all filtered rows on request, and counts rows not shown", async () => {
      const groups = Array.from({ length: 25 }, (_, i) => group(`pkg${String(i).padStart(2, "0")}`));
      mockGetSignoffList.mockResolvedValue(listOf(groups));
      mockSignoffPackage.mockImplementation(async (pkgbase) => ok(pkgbase));
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "pkg00" });

      fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages on this page" }));
      expect(screen.getByRole("button", { name: "Sign off 20 packages" })).toBeInTheDocument();
      expect(screen.queryByText(/not shown/)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Select all 25" }));
      expect(screen.getByText("25 selected, 5 not shown")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Select all \d/ })).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Sign off 25 packages" }));
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(mockSignoffPackages).toHaveBeenCalledOnce());
      expect(mockSignoffPackages.mock.lastCall?.[0]).toHaveLength(25);
      expect(mockSignoffPackage).not.toHaveBeenCalled();
      expect(await screen.findByText("Signed off 25 packages")).toBeInTheDocument();
    });

    it("patches bulk rows and holds them until the reload settles", async () => {
      mockGetSignoffList.mockResolvedValueOnce(listOf([group("a"), group("b")]));
      const reload = deferred<api.SignoffListResponse>();
      mockGetSignoffList.mockReturnValueOnce(reload.promise);
      mockSignoffPackage.mockImplementation(async (pkgbase) => ok(pkgbase));
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "a" });

      fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages on this page" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Sign off 2 packages" }));
      });
      expect(mockSignoffPackages).toHaveBeenCalledOnce();
      for (const name of ["a", "b"]) {
        expect(within(rowOf(name)).getByText("1 / 2")).toBeInTheDocument();
        expect(within(rowOf(name)).getByText("Signed off")).toBeInTheDocument();
        const verb = screen.getByRole("button", { name: `Revoke signoff for ${name}` });
        expect(verb).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(verb);
      }
      expect(mockRevokeSignoff).not.toHaveBeenCalled();
      await act(async () => {
        reload.resolve(listOf([group("a"), group("b")]));
      });
      expect(screen.getByRole("button", { name: "Sign off a" })).not.toHaveAttribute("aria-disabled");
    });

    it("confirms rows whose installed version differs", async () => {
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "vlc" });
      fireEvent.click(screen.getByRole("checkbox", { name: /^Select vlc / }));
      fireEvent.click(screen.getByRole("button", { name: "Sign off 1 package" }));

      const dialog = await screen.findByRole("dialog", { name: /Sign off 1 package\?$/ });
      expect(within(dialog).getByText(/installed 3.0.21-1, signoff is for 3.0.21-2/)).toBeInTheDocument();
    });

    it("waits for the active batch before stopping and leaves the next batch selected", async () => {
      const groups = Array.from({ length: api.SIGNOFF_BATCH_LIMIT + 1 }, (_, i) => group(`pkg${i}`));
      mockGetSignoffList.mockResolvedValue(listOf(groups));
      const first = deferred<api.SignoffBatchResponse>();
      mockSignoffPackages.mockReturnValueOnce(first.promise);
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "pkg0" });
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages on this page" }));
      fireEvent.click(screen.getByRole("button", { name: `Select all ${groups.length}` }));
      fireEvent.click(screen.getByRole("button", { name: `Sign off ${groups.length} packages` }));
      fireEvent.click(await screen.findByRole("button", { name: "Stop after current batch" }));
      expect(screen.getByRole("button", { name: "Waiting for current batch…" })).toHaveAttribute("aria-disabled", "true");
      expect(mockSignoffPackages).toHaveBeenCalledOnce();
      expect(screen.queryByText(/Stopped before/)).not.toBeInTheDocument();
      await act(async () => {
        first.resolve({ results: mockSignoffPackages.mock.calls[0][0].map(target => ({ target, success: true })) });
      });
      expect(await screen.findByText(`Signed off ${api.SIGNOFF_BATCH_LIMIT} of ${groups.length} packages`)).toBeInTheDocument();
      expect(mockSignoffPackages).toHaveBeenCalledOnce();
      expect(screen.getByText(`Stopped before: pkg${api.SIGNOFF_BATCH_LIMIT}`)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign off 1 package" })).toBeInTheDocument();
    });

    it("keeps typed batch failure details and prunes selection after a refresh", async () => {
      const a = group("a"), b = group("b");
      mockGetSignoffList.mockResolvedValueOnce(listOf([a, b]));
      mockGetSignoffList.mockResolvedValue(listOf([a, {
        ...b, signoffs: [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: false }],
      }]));
      mockSignoffPackages.mockRejectedValue(new api.BackendError("Local request timed out", "timeout", "ArchWeb response was not received"));
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "a" });
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages on this page" }));
      fireEvent.click(screen.getByRole("button", { name: "Sign off 2 packages" }));
      await screen.findByText("Signed off 0 of 2 packages");
      await waitFor(() => expect(screen.getByRole("button", { name: "Sign off 1 package" })).toBeInTheDocument());
      expect(screen.getAllByText("ArchWeb response was not received")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Sign off 1 package" }));
      await waitFor(() => expect(mockSignoffPackages).toHaveBeenCalledTimes(2));
      expect(mockSignoffPackages.mock.lastCall?.[0]).toEqual([{ pkgbase: "a", repo: "core-testing", arch: "x86_64" }]);
    });

    it("retains targets whose result is missing from a batch response", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([group("a"), group("b")]));
      mockSignoffPackages.mockResolvedValue({ results: [
        { target: { pkgbase: "a", repo: "core-testing", arch: "x86_64" }, success: true },
      ] });
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "a" });
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages on this page" }));
      fireEvent.click(screen.getByRole("button", { name: "Sign off 2 packages" }));
      expect(await screen.findByText("Signed off 1 of 2 packages")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /^Select b / })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /^Select a / })).not.toBeChecked();
    });

    it("keeps exactly the failed rows selected", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([group("a"), group("b"), group("c")]));
      mockSignoffPackages.mockImplementation(async targets => ({ results: targets.map(target => ({
        target, success: target.pkgbase !== "b", error: target.pkgbase === "b" ? "POST returned 500" : undefined,
      })) }));
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "a" });

      fireEvent.click(screen.getByRole("checkbox", { name: "Select all packages on this page" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Sign off 3 packages" }));
      });

      expect(await screen.findByText("Signed off 2 of 3 packages")).toBeInTheDocument();
      expect(screen.getByText(/b: POST returned 500/)).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Error$/ })).toBeNull();
      const checked = ["a", "b", "c"].filter((n) => (screen.getByRole("checkbox", { name: new RegExp(`^Select ${n} `) }) as HTMLInputElement).checked);
      expect(checked).toEqual(["b"]);
    });
  });

  describe("tile parity and routing", () => {
    const mixed = listOf([
      group("counted"),
      group("signed-by-me", { signoffs: [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: false }] }),
      group("revoked-mine", { signoffs: [{ user: "alice", created: "2024-01-02T00:00:00Z", revoked: true }] }),
      group("not-installed", { version_match: "not_installed", local_version: null }),
      group("approved", { approved: true }),
      group("bad", { known_bad: true }),
      group("mismatch", { version_match: "mismatch", local_version: "0.9-1" }),
    ]);

    it("shows exactly the rows the tile counts for the routed filter", async () => {
      mockGetSignoffList.mockResolvedValue(mixed);
      const onCount = vi.fn();
      render(
        <SignoffsView credentials={credentials} routeOptions={{ filter: SIGNOFF_TILE_FILTER }} onToSignOffCount={onCount} />,
      );
      await screen.findByRole("button", { name: "counted" });

      const rows = within(screen.getByLabelText("Signoff packages")).getAllByRole("row").slice(1);
      const expected = countToSignOff(mixed.signoff_groups, "alice");
      expect(expected).toBe(3);
      expect(rows).toHaveLength(expected);
      expect(onCount).toHaveBeenLastCalledWith(expected);
    });

    it("lands on the tile filter by default", async () => {
      mockGetSignoffList.mockResolvedValue(mixed);
      render(<SignoffsView credentials={credentials} />);
      await screen.findByRole("button", { name: "counted" });

      const rows = within(screen.getByLabelText("Signoff packages")).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(countToSignOff(mixed.signoff_groups, "alice"));
    });

    it("says nothing is left to sign off and offers every signoff", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([group("approved", { approved: true })]));
      render(<SignoffsView credentials={credentials} />);

      expect(await screen.findByRole("heading", { name: "Nothing left to sign off" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show all signoffs" }));
      expect(await screen.findByRole("button", { name: "approved" })).toBeInTheDocument();
    });

    it("opens a routed build in the drawer, writes a row open and closes when pkg is cleared", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([group("aaa"), group("bbb", { repo: "extra-testing" })]));
      mockGetSyncPackageInfo.mockImplementation(async (name: string) => ({ ...mockSyncPackageDetails, name }));
      const onRouteChange = vi.fn();
      const { rerender } = render(
        <SignoffsView credentials={credentials} routeOptions={{ pkg: "aaa", repo: "core-testing" }} onRouteChange={onRouteChange} />,
      );
      expect(await screen.findByRole("region", { name: /^aaa/ })).toBeInTheDocument();
      expect(screen.queryAllByRole("dialog")).toHaveLength(0);
      expect(mockGetSyncPackageInfo).toHaveBeenCalledWith("aaa", "core-testing");
      await waitFor(() => expect(rowOf("aaa")).toHaveAttribute("aria-current", "true"));

      const bbb = screen.getByRole("button", { name: "bbb" });
      bbb.focus();
      fireEvent.click(bbb);
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ pkg: "bbb", repo: "extra-testing" }));
      rerender(
        <SignoffsView credentials={credentials} routeOptions={{ pkg: "bbb", repo: "extra-testing" }} onRouteChange={onRouteChange} />,
      );
      const panel = await screen.findByRole("region", { name: /^bbb/ });
      expect(mockGetSyncPackageInfo).toHaveBeenLastCalledWith("bbb", "extra-testing");

      within(panel).getByRole("button", { name: "Close package details" }).focus();
      rerender(<SignoffsView credentials={credentials} routeOptions={{}} onRouteChange={onRouteChange} />);
      await waitFor(() => expect(screen.queryByRole("region", { name: /^bbb/ })).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "bbb" })).toHaveFocus();
    });

    it("drops pkg and repo from the route when the drawer is closed", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([group("aaa")]));
      mockGetSyncPackageInfo.mockImplementation(async (name: string) => ({ ...mockSyncPackageDetails, name }));
      const onRouteChange = vi.fn();
      render(<SignoffsView credentials={credentials} routeOptions={{ pkg: "aaa", repo: "core-testing" }} onRouteChange={onRouteChange} />);
      const panel = await screen.findByRole("region", { name: /^aaa/ });
      fireEvent.click(within(panel).getByRole("button", { name: "Close package details" }));
      await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({}));
    });

    it("writes filter changes back to the route", async () => {
      const onRouteChange = vi.fn();
      render(<SignoffsView credentials={credentials} routeOptions={{}} onRouteChange={onRouteChange} />);
      await screen.findByRole("button", { name: "vlc" });

      fireEvent.click(screen.getByRole("button", { name: /^Not signed by me/ }));
      expect(onRouteChange).toHaveBeenLastCalledWith({ filter: "installed,pending" });
    });

    it("keeps the repository filter in the route as in", async () => {
      mockGetSignoffList.mockResolvedValue(listOf([group("linux"), group("vlc", { repo: "extra-testing" })]));
      const onRouteChange = vi.fn();
      const { rerender } = render(
        <SignoffsView credentials={credentials} routeOptions={{ in: "extra-testing" }} onRouteChange={onRouteChange} />,
      );
      await screen.findByRole("button", { name: "vlc" });
      expect(screen.queryByRole("button", { name: "linux" })).toBeNull();

      rerender(<SignoffsView credentials={credentials} routeOptions={{}} onRouteChange={onRouteChange} />);
      expect(await screen.findByRole("button", { name: "linux" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Filter by repository" }));
      fireEvent.click(await screen.findByRole("option", { name: "core-testing" }));
      expect(onRouteChange).toHaveBeenLastCalledWith({ in: "core-testing" });
    });
  });

  it("refetches on activation only once the data is stale", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const view = (active: boolean) => (
      <TabActiveContext.Provider value={active}><SignoffsView credentials={credentials} /></TabActiveContext.Provider>
    );
    const { rerender } = render(view(true));
    await screen.findByRole("button", { name: "vlc" });
    expect(mockGetSignoffList).toHaveBeenCalledTimes(1);

    rerender(view(false));
    now += SIGNOFF_STALE_MS - 1;
    rerender(view(true));
    expect(mockGetSignoffList).toHaveBeenCalledTimes(1);

    rerender(view(false));
    now += 1;
    await act(async () => {
      rerender(view(true));
    });
    expect(mockGetSignoffList).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });
});

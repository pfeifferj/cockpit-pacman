import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { DowngradeModal } from "./DowngradeModal";
import { CANCEL_WAIT_NOTICE_MS } from "./CancellationNotice";
import * as api from "../api";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";

const systemChange = vi.hoisted(() => {
  const listeners = new Set<{ listener: (kind: "system" | "sync") => void; kinds: ("system" | "sync")[] }>();
  return {
    listeners,
    subscribe: (listener: (kind: "system" | "sync") => void, kinds: ("system" | "sync")[] = ["system", "sync"]) => {
      const entry = { listener, kinds };
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
  };
});

function emitSystemChange(kind: "system" | "sync" = "system") {
  for (const { listener, kinds } of [...systemChange.listeners]) {
    if (kinds.includes(kind)) listener(kind);
  }
}

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    onSystemChanged: systemChange.subscribe,
    listDowngrades: vi.fn(),
    listArchiveVersions: vi.fn(),
    downgradePackage: vi.fn(),
    downgradeFromArchive: vi.fn(),
    previewDowngrade: vi.fn(),
    previewDowngradeArchive: vi.fn(),
    checkLock: vi.fn(),
    addIgnoredPackage: vi.fn(),
    removeIgnoredPackage: vi.fn(),
    listIgnoredPackages: vi.fn(),
  };
});

const mockListDowngrades = vi.mocked(api.listDowngrades);
const mockListArchiveVersions = vi.mocked(api.listArchiveVersions);
const mockDowngradePackage = vi.mocked(api.downgradePackage);
const mockDowngradeFromArchive = vi.mocked(api.downgradeFromArchive);
const mockPreviewDowngrade = vi.mocked(api.previewDowngrade);
const mockPreviewDowngradeArchive = vi.mocked(api.previewDowngradeArchive);
const mockCheckLock = vi.mocked(api.checkLock);
const mockAddIgnoredPackage = vi.mocked(api.addIgnoredPackage);
const mockRemoveIgnoredPackage = vi.mocked(api.removeIgnoredPackage);
const mockListIgnoredPackages = vi.mocked(api.listIgnoredPackages);

function makePreview(version: string, overrides: Partial<api.TransactionPreview> = {}): api.TransactionPreview {
  return {
    success: true,
    add: [{ name: "bash", version, repo: null, download_size: 0, installed_size: 9_000_000, old_version: "5.2.015-1", reason: "target" }],
    remove: [],
    conflicts: [],
    replacements: [],
    providers: [],
    import_keys: [],
    warnings: [],
    blocked_by: [],
    total_download_size: 0,
    net_installed_size: -100_000,
    ...overrides,
  };
}

const cacheVersion: api.CachedVersion = {
  name: "bash",
  version: "5.1.016-1",
  filename: "bash-5.1.016-1-x86_64.pkg.tar.zst",
  size: 1024,
  installed_version: "5.2.015-1",
  is_older: true,
};

const archiveVersion: api.CachedVersion = {
  name: "bash",
  version: "5.0.018-1",
  filename: "bash-5.0.018-1-x86_64.pkg.tar.zst",
  size: 0,
  installed_version: "5.2.015-1",
  is_older: true,
};

describe("DowngradeModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDowngrades.mockResolvedValue({ packages: [cacheVersion], total: 1 });
    mockListArchiveVersions.mockResolvedValue({ packages: [archiveVersion], total: 1 });
    mockDowngradePackage.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    mockDowngradeFromArchive.mockReturnValue({ cancel: vi.fn(), forceStop: vi.fn() });
    mockPreviewDowngrade.mockImplementation((_name, version) => Promise.resolve(makePreview(version)));
    mockPreviewDowngradeArchive.mockResolvedValue(makePreview("5.0.018-1"));
    mockCheckLock.mockResolvedValue({ locked: false, stale: false, lock_path: "/var/lib/pacman/db.lck", holder_unknown: false });
    mockAddIgnoredPackage.mockResolvedValue({ success: true, package: "bash", message: "Package ignored" });
    mockRemoveIgnoredPackage.mockResolvedValue({ success: true, package: "bash", message: "Package unignored" });
    mockListIgnoredPackages.mockResolvedValue({ packages: [], total: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps transaction errors and details visible after a network failure", async () => {
    render(<DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Select / }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" }));
    act(() => mockDowngradePackage.mock.lastCall![0].onError(
      "Package download failed", "network_error", "Proxy authentication rejected (407)"));
    expect(screen.getByText("Package download failed")).toBeInTheDocument();
    expect(screen.getByText("Proxy authentication rejected (407)")).toBeInTheDocument();
    expect(screen.queryByText("Can't reach Arch Linux services")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("loads cached versions from the cache source by default", async () => {
    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mockListDowngrades).toHaveBeenCalledWith("bash");
    });
    expect(mockListArchiveVersions).not.toHaveBeenCalled();
    expect(screen.getByText("5.1.016-1")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Downgrade bash");
  });

  it("shows the offline network error state when the archive load fails with a network code", async () => {
    mockListArchiveVersions.mockRejectedValue(
      new api.BackendError("could not resolve host", "network_error")
    );

    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });

    await waitFor(() =>
      expect(screen.getByText("Can't reach Arch Linux services")).toBeInTheDocument()
    );
    expect(screen.getByRole("link", { name: "Arch Linux status page" })).toBeInTheDocument();
  });

  it("switching to the Archive tab fetches archive versions", async () => {
    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });

    await waitFor(() => {
      expect(mockListArchiveVersions).toHaveBeenCalledWith("bash");
    });
    expect(screen.getByText("5.0.018-1")).toBeInTheDocument();
  });

  it("confirming a cache downgrade routes to downgradePackage", async () => {
    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText("5.1.016-1")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Select / }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" }));
    });

    expect(mockDowngradePackage).toHaveBeenCalledWith(
      expect.any(Object),
      "bash",
      "5.1.016-1",
      []
    );
    expect(mockDowngradeFromArchive).not.toHaveBeenCalled();
  });

  it("confirming an archive downgrade routes to downgradeFromArchive with the filename", async () => {
    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    await waitFor(() => expect(screen.getByText("5.0.018-1")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Select / }));
    });
    expect(mockPreviewDowngradeArchive).toHaveBeenCalledWith(
      "bash",
      "bash-5.0.018-1-x86_64.pkg.tar.zst",
      expect.any(Object)
    );
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Downgrade bash to 5.0.018-1" }));
    });

    expect(mockDowngradeFromArchive).toHaveBeenCalledWith(
      expect.any(Object),
      "bash",
      "bash-5.0.018-1-x86_64.pkg.tar.zst",
      []
    );
    expect(mockDowngradePackage).not.toHaveBeenCalled();
  });

  it("filters the version list by the search query", async () => {
    mockListArchiveVersions.mockResolvedValue({
      packages: [
        { ...archiveVersion, version: "5.0.018-1", filename: "bash-5.0.018-1-x86_64.pkg.tar.zst" },
        { ...archiveVersion, version: "4.4.023-1", filename: "bash-4.4.023-1-x86_64.pkg.tar.zst" },
      ],
      total: 2,
    });

    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    await waitFor(() => expect(screen.getByText("4.4.023-1")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Filter versions"), {
        target: { value: "4.4" },
      });
    });

    expect(screen.queryByText("5.0.018-1")).not.toBeInTheDocument();
    expect(screen.getByText("4.4.023-1")).toBeInTheDocument();
  });

  it("escalates to a backend search when nothing in the loaded page matches", async () => {
    const serverOnly: api.CachedVersion = {
      name: "bash",
      version: "3.2.57-1",
      filename: "bash-3.2.57-1-x86_64.pkg.tar.zst",
      size: 0,
      installed_version: "5.2.015-1",
      is_older: true,
    };
    mockListArchiveVersions.mockImplementation((_name, query) =>
      Promise.resolve(
        query
          ? { packages: [serverOnly], total: 1 }
          : { packages: [archiveVersion], total: 1 }
      )
    );

    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    await waitFor(() => expect(screen.getByText("5.0.018-1")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Filter versions"), {
        target: { value: "3.2.57" },
      });
    });

    await waitFor(() =>
      expect(mockListArchiveVersions).toHaveBeenLastCalledWith("bash", "3.2.57")
    );
    await waitFor(() => expect(screen.getByText("3.2.57-1")).toBeInTheDocument());
  });

  it("shows a failure message when the escalated archive search errors", async () => {
    mockListArchiveVersions.mockImplementation((_name, query) =>
      query
        ? Promise.reject(new Error("network_error"))
        : Promise.resolve({ packages: [archiveVersion], total: 1 })
    );

    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    await waitFor(() => expect(screen.getByText("5.0.018-1")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Filter versions"), {
        target: { value: "3.2.57" },
      });
    });

    await waitFor(() =>
      expect(screen.getByText("Archive search failed")).toBeInTheDocument()
    );
    expect(screen.queryByText("No matching versions")).not.toBeInTheDocument();
  });

  it("renders archive version sizes from the listing", async () => {
    mockListArchiveVersions.mockResolvedValue({
      packages: [{ ...archiveVersion, size: 2 * 1024 * 1024 }],
      total: 1,
    });

    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });

    await waitFor(() => expect(screen.getByText("2.0 MiB")).toBeInTheDocument());
  });

  it("discards a superseded load when a newer one resolves first", async () => {
    let resolveStale: (v: api.DowngradeResponse) => void = () => {};
    mockListDowngrades.mockImplementationOnce(
      () => new Promise<api.DowngradeResponse>((r) => { resolveStale = r; })
    );
    mockListDowngrades.mockResolvedValue({ packages: [cacheVersion], total: 1 });

    const { rerender } = render(
      <DowngradeModal packageName="foo" currentVersion="1-1" isOpen={true} onClose={vi.fn()} />
    );
    // First load (package "foo") is still pending; a package change supersedes it.
    rerender(
      <DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen={true} onClose={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByText("5.1.016-1")).toBeInTheDocument());

    await act(async () => {
      resolveStale({ packages: [{ ...cacheVersion, version: "9.9.9-9" }], total: 1 });
    });

    expect(screen.queryByText("9.9.9-9")).not.toBeInTheDocument();
    expect(screen.getByText("5.1.016-1")).toBeInTheDocument();
  });

  it("does not escalate to a backend search for the cache source", async () => {
    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText("5.1.016-1")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Filter versions"), {
        target: { value: "9.9.9" },
      });
    });

    await waitFor(() => expect(screen.getByText("No matching versions")).toBeInTheDocument());
    expect(mockListArchiveVersions).not.toHaveBeenCalled();
  });

  it("sorts the version column in pacman order", async () => {
    const at = (version: string): api.CachedVersion => ({
      ...cacheVersion,
      version,
      filename: `bash-${version}-x86_64.pkg.tar.zst`,
    });
    mockListDowngrades.mockResolvedValue({ packages: [at("1.9-1"), at("1.2-1"), at("1.10-1")], total: 3 });

    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText("1.10-1")).toBeInTheDocument());
    const versionHeader = screen.getByRole("columnheader", { name: /Version/ });
    const order = () => screen.getAllByText(/^1\.\d+-1$/).map((el) => el.textContent);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Version/ }));
    });
    const descending = ["1.10-1", "1.9-1", "1.2-1"];
    const first = versionHeader.getAttribute("aria-sort");
    expect(order()).toEqual(first === "descending" ? descending : [...descending].reverse());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Version/ }));
    });
    expect(versionHeader.getAttribute("aria-sort")).not.toBe(first);
    expect(order()).toEqual(first === "descending" ? [...descending].reverse() : descending);
  });

  it("shows a no-match message when the filter excludes everything", async () => {
    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText("5.1.016-1")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Filter versions"), {
        target: { value: "9.9.9" },
      });
    });

    expect(screen.getByText("No matching versions")).toBeInTheDocument();
    expect(screen.queryByText("5.1.016-1")).not.toBeInTheDocument();
  });

  it("shows no-match (not a failure) when the escalated search returns empty", async () => {
    mockListArchiveVersions.mockImplementation((_name, query) =>
      query
        ? Promise.resolve({ packages: [], total: 0 })
        : Promise.resolve({ packages: [archiveVersion], total: 1 })
    );

    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    await waitFor(() => expect(screen.getByText("5.0.018-1")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Filter versions"), {
        target: { value: "3.2.57" },
      });
    });

    await waitFor(() =>
      expect(mockListArchiveVersions).toHaveBeenLastCalledWith("bash", "3.2.57")
    );
    await waitFor(() => expect(screen.getByText("No matching versions")).toBeInTheDocument());
    expect(screen.queryByText("Archive search failed")).not.toBeInTheDocument();
  });

  it("labels newer and not-installed versions with the right action", async () => {
    mockListDowngrades.mockResolvedValue({
      packages: [
        { name: "bash", version: "5.3.0-1", filename: "bash-5.3.0-1-x86_64.pkg.tar.zst", size: 1024, installed_version: "5.2.015-1", is_older: false },
        { name: "bash", version: "5.1.0-1", filename: "bash-5.1.0-1-x86_64.pkg.tar.zst", size: 1024, installed_version: null, is_older: false },
      ],
      total: 2,
    });

    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText("5.3.0-1")).toBeInTheDocument());
    expect(screen.getByText("newer")).toBeInTheDocument();
    expect(screen.getByText("cached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select 5.3.0-1" })).toHaveTextContent(/^Select$/);
    expect(screen.getByRole("button", { name: "Select 5.1.0-1" })).toHaveTextContent(/^Select$/);
  });

  async function startDowngrade() {
    let callbacks: api.UpgradeCallbacks | undefined;
    const cancel = vi.fn();
    const forceStop = vi.fn();
    mockDowngradePackage.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel, forceStop };
    });
    const onClose = vi.fn();
    render(
      <DowngradeModal
        packageName="bash"
        currentVersion="5.2.015-1"
        isOpen={true}
        onClose={onClose}
      />,
      { wrapper: AnnouncerProvider }
    );
    await waitFor(() => expect(screen.getByText("5.1.016-1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Select / }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" }));
    return { cancel, forceStop, onClose, callbacks: () => callbacks! };
  }

  it("ignores Escape and backdrop clicks while downgrading", async () => {
    const { cancel, onClose } = await startDowngrade();

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".pf-v6-c-backdrop")!);

    expect(cancel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("stops on request and reports a downgrade that finished anyway", async () => {
    const { cancel, callbacks } = await startDowngrade();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep running" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Keep running" })).toHaveAccessibleDescription(/Stop downgrading bash\?/);
    expect(screen.getByRole("button", { name: "Stop downgrading bash" })).toHaveAccessibleDescription(/cannot be stopped/);
    fireEvent.click(screen.getByRole("button", { name: "Stop downgrading bash" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/Cancelling/).length).toBeGreaterThan(0);

    act(() => callbacks().onComplete());
    expect(screen.getByRole("heading", { name: "The transaction finished before it could be stopped" })).toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Available versions" })).not.toBeInTheDocument();
    expect(document.activeElement).toHaveTextContent("Close");
  });

  it("moves focus to Try again when a stopped downgrade fails", async () => {
    const { callbacks } = await startDowngrade();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop downgrading bash" }));

    act(() => callbacks().onError("failed to commit transaction", "transaction_failed"));
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
  });

  it("keeps the log on a failed downgrade and Try again returns to confirm", async () => {
    const { callbacks } = await startDowngrade();
    act(() => callbacks().onData?.("error: failed to commit transaction\n"));
    act(() => callbacks().onError("failed to commit transaction", "transaction_failed"));

    expect(screen.getByRole("heading", { name: /Downgrade failed/ })).toBeInTheDocument();
    expect(screen.getByRole("log")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" })).toBeInTheDocument();
    expect(mockPreviewDowngrade).toHaveBeenCalledTimes(2);
    expect(mockListDowngrades).toHaveBeenCalledTimes(1);
  });

  async function renderAndPick() {
    const onClose = vi.fn();
    render(
      <DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen={true} onClose={onClose} />
    );
    await waitFor(() => expect(screen.getByText("5.1.016-1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Select / }));
    return { onClose };
  }

  it("previews the downgrade and names the pulled-in packages in a danger commit button", async () => {
    mockPreviewDowngrade.mockResolvedValue(makePreview("5.1.016-1", {
      add: [
        { name: "bash", version: "5.1.016-1", repo: null, download_size: 0, installed_size: 9_000_000, old_version: "5.2.015-1", reason: "target" },
        { name: "readline-compat", version: "8.1-1", repo: "extra", download_size: 300_000, installed_size: 900_000, reason: "dependency" },
      ],
    }));
    await renderAndPick();

    expect(mockPreviewDowngrade).toHaveBeenCalledWith("bash", "5.1.016-1");
    const commit = await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1 and 1 package" });
    expect(commit).toHaveClass("pf-m-danger");
    expect(screen.getByText("readline-compat")).toBeInTheDocument();
    expect(mockDowngradePackage).not.toHaveBeenCalled();
  });

  it("blocks the commit with the free-space reason when the disk is too full", async () => {
    mockPreviewDowngrade.mockResolvedValue(makePreview("5.1.016-1", {
      warnings: [{
        id: "disk_space", severity: "danger", title: "Not enough free space on /usr",
        message: "Needs about 0.2 GiB, 0.1 GiB free.", packages: [],
        blocking: true, disk: { mount: "/usr", deficit: 100 * 1024 * 1024, holds_cache: true },
      }],
    }));
    await renderAndPick();

    const commit = await screen.findByRole("button", { name: /^Downgrade bash to 5.1.016-1/ });
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).toHaveAccessibleDescription(
      "Not enough free space on /usr. Free at least 100.0 MiB on /usr. Cleaning the package cache frees space on /usr."
    );
    fireEvent.click(commit);
    expect(mockDowngradePackage).not.toHaveBeenCalled();
  });

  it("marks the preview stale on a system change, blocks the commit and refreshes it", async () => {
    await renderAndPick();
    const commit = await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" });

    act(() => emitSystemChange("sync"));
    expect(screen.getByRole("heading", { name: /The system changed since this preview/ })).toBeInTheDocument();
    expect(commit).toHaveAttribute("aria-disabled", "true");
    expect(commit).toHaveAccessibleDescription("The system changed since this preview");
    fireEvent.click(commit);
    expect(mockDowngradePackage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    const refreshed = await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" });
    expect(mockPreviewDowngrade).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: /The system changed since this preview/ })).not.toBeInTheDocument();
    expect(refreshed).not.toHaveAttribute("aria-disabled", "true");
  });

  it("offers Check again and Back when the preview fails", async () => {
    mockPreviewDowngrade.mockRejectedValueOnce(new api.BackendError("could not read the package cache", "internal_error"));
    await renderAndPick();

    expect(await screen.findByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Downgrade bash to/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" })).toBeInTheDocument();
    expect(mockPreviewDowngrade).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("grid", { name: "Available versions" })).toBeInTheDocument();
  });

  it("has no commit button when the preview reports the transaction cannot run", async () => {
    mockPreviewDowngrade.mockResolvedValue(makePreview("5.1.016-1", {
      success: false,
      add: [],
      error: "Failed to prepare transaction: could not satisfy dependencies",
    }));
    await renderAndPick();

    expect(await screen.findByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(screen.getByText("Cannot downgrade bash")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Downgrade bash to/ })).not.toBeInTheDocument();
  });

  it("Back during a preview drops its late result", async () => {
    let resolve: (p: api.TransactionPreview) => void = () => {};
    mockPreviewDowngrade.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await renderAndPick();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => resolve(makePreview("5.1.016-1")));
    expect(screen.getByRole("grid", { name: "Available versions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Downgrade bash to 5.1.016-1" })).not.toBeInTheDocument();
  });

  it("shows archive download progress while previewing", async () => {
    let onEvent: ((e: api.StreamEvent) => void) | undefined;
    mockPreviewDowngradeArchive.mockImplementation((_n, _f, options) => {
      onEvent = options?.onEvent;
      return new Promise(() => {});
    });
    render(<DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen={true} onClose={vi.fn()} />);
    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Select / }));

    act(() => onEvent?.({ type: "download", filename: archiveVersion.filename, event: "progress", downloaded: 1, total: 4 }));
    expect(screen.getByRole("progressbar", { name: `Downloading ${archiveVersion.filename}` })).toHaveAttribute("aria-valuenow", "25");
  });

  it("keeps the source toggle when listing versions fails", async () => {
    mockListDowngrades.mockRejectedValue(new api.BackendError("read error", "internal_error"));
    render(<DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText("Could not list versions")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    await waitFor(() => expect(mockListArchiveVersions).toHaveBeenCalledWith("bash"));
    expect(await screen.findByText("5.0.018-1")).toBeInTheDocument();
  });

  it("Close after a successful downgrade runs onClose", async () => {
    const { callbacks, onClose } = await startDowngrade();
    act(() => callbacks().onComplete());
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open until cancellation is acknowledged", async () => {
    const { forceStop, onClose, callbacks } = await startDowngrade();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "Stop downgrading bash" }));
      act(() => vi.advanceTimersByTime(CANCEL_WAIT_NOTICE_MS));
      expect(screen.getByText(/Waiting for the backend to stop safely/)).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      expect(forceStop).not.toHaveBeenCalled();
      act(() => callbacks().onError("Operation cancelled", "cancelled"));
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("names the dialog after the chosen version's verb", async () => {
    const newer = { ...cacheVersion, version: "5.3.0-1", filename: "bash-5.3.0-1-x86_64.pkg.tar.zst", is_older: false };
    mockListDowngrades.mockResolvedValue({ packages: [newer], total: 1 });
    render(<DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen={true} onClose={vi.fn()} />);
    await screen.findByText("5.3.0-1");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Downgrade bash");

    fireEvent.click(screen.getByRole("button", { name: "Select 5.3.0-1" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Upgrade bash");
    expect(await screen.findByRole("button", { name: "Upgrade bash to 5.3.0-1" })).toBeInTheDocument();
  });

  it("shows the cache preview text only after 1 s", async () => {
    mockPreviewDowngrade.mockImplementation(() => new Promise(() => {}));
    render(<DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen={true} onClose={vi.fn()} />);
    await screen.findByText("5.1.016-1");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Select 5.1.016-1" }));
      expect(screen.getByRole("progressbar", { name: "Checking what will change" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(999));
      expect(screen.queryByText(/Checking what will change…/)).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByText(/Checking what will change…/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows downloaded bytes and offers Cancel download while an archive file downloads", async () => {
    let onEvent: ((e: api.StreamEvent) => void) | undefined;
    let signal: { aborted: boolean } | undefined;
    mockPreviewDowngradeArchive.mockImplementation((_n, _f, options) => {
      onEvent = options?.onEvent;
      signal = options?.signal;
      return new Promise(() => {});
    });
    render(<DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen={true} onClose={vi.fn()} />);
    await waitFor(() => expect(mockListDowngrades).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("Archive"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Select 5.0.018-1" }));

    act(() => onEvent?.({ type: "download", filename: archiveVersion.filename, event: "progress", downloaded: 1024, total: 4096 }));
    const bar = screen.getByRole("progressbar", { name: `Downloading ${archiveVersion.filename}` });
    expect(bar).toHaveAttribute("aria-valuetext", "1.0 KiB of 4.0 KiB");
    expect(screen.getByText("1.0 KiB of 4.0 KiB")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("grid", { name: "Available versions" })).toBeInTheDocument();
  });

  it("explains what a plain downgrade keeps and uses danger only when other packages change", async () => {
    await renderAndPick();
    const note = await screen.findByRole("heading", { name: /The next upgrade replaces this version/ });
    expect(note.closest(".pf-v6-c-alert")).toHaveClass("pf-m-info");
    expect(screen.queryByText(/Only proceed if you know what you are doing/)).not.toBeInTheDocument();
    expect(screen.getByText(/install scripts made/)).toBeInTheDocument();
    cleanup();

    mockPreviewDowngrade.mockResolvedValue(makePreview("5.1.016-1", {
      remove: [{ name: "bash-completion", version: "2.11-1", installed_size: 1, reason: "conflict" }],
    }));
    await renderAndPick();
    const danger = await screen.findByRole("heading", { name: /also removes or downgrades packages other than bash/ });
    expect(danger.closest(".pf-v6-c-alert")).toHaveClass("pf-m-danger");
  });

  it("offers to ignore the package after a downgrade, with Undo", async () => {
    let callbacks: api.UpgradeCallbacks | undefined;
    mockDowngradePackage.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });
    render(
      <DowngradeModal packageName="bash" currentVersion="5.2.015-1" isOpen={true} onClose={vi.fn()} />
    );
    await screen.findByText("5.1.016-1");
    fireEvent.click(screen.getByRole("button", { name: "Select 5.1.016-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" }));
    act(() => callbacks!.onComplete());

    expect(screen.getByText(/The next upgrade replaces this version unless it is ignored/)).toBeInTheDocument();
    const ignore = await screen.findByRole("button", { name: "Ignore bash in upgrades" });
    await act(async () => {
      fireEvent.click(ignore);
    });
    expect(mockAddIgnoredPackage).toHaveBeenCalledWith("bash");
    expect(screen.getByRole("heading", { name: /bash is now ignored during upgrades/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ignore bash in upgrades" })).not.toBeInTheDocument();
    expect(screen.getByText(/upgrades leave this version in place/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(mockRemoveIgnoredPackage).toHaveBeenCalledWith("bash");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ignore bash in upgrades" })).toBeInTheDocument();
  });

  it("makes no ignore offer for a package that is already ignored", async () => {
    mockListIgnoredPackages.mockResolvedValue({ packages: ["bash"], total: 1 });
    const { callbacks } = await startDowngrade();
    await act(async () => callbacks().onComplete());
    expect(screen.getByText(/upgrades leave this version in place/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ignore bash in upgrades" })).not.toBeInTheDocument();
  });

  it("offers stale lock removal after a stop that left db.lck behind", async () => {
    mockCheckLock.mockResolvedValue({ locked: true, stale: true, lock_path: "/var/lib/pacman/db.lck", holder_unknown: false });
    const { callbacks } = await startDowngrade();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop downgrading bash" }));
    await act(async () => callbacks().onError("transaction cancelled", "cancelled"));

    expect(screen.getByRole("heading", { name: /Stopped/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Remove stale lock and retry" })).toBeInTheDocument();
  });

  it("retries the preview from the lock alert once the lock is gone", async () => {
    mockCheckLock.mockResolvedValue({ locked: true, stale: false, lock_path: "/var/lib/pacman/db.lck", blocking_process: "pacman (pid 42)", holder_unknown: false });
    mockPreviewDowngrade.mockRejectedValueOnce(new api.BackendError("unable to lock database", "database_locked"));
    await renderAndPick();
    expect(await screen.findByText(/Waiting for/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" })).toBeInTheDocument();
    expect(mockPreviewDowngrade).toHaveBeenCalledTimes(2);
  });
});


describe("DowngradeModal cancellation", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it.each(["Cancel", "Escape", "backdrop"])("waits after %s and preserves a commit failure", async (dismissal) => {
    mockListDowngrades.mockResolvedValue({ packages: [cacheVersion], total: 1 });
    mockPreviewDowngrade.mockImplementation((_name, version) => Promise.resolve(makePreview(version)));
    const cancel = vi.fn();
    mockDowngradePackage.mockReturnValue({ cancel, forceStop: vi.fn() });
    const onClose = vi.fn();
    const props = { packageName: "bash", currentVersion: "5.2.015-1", onClose };
    const { rerender } = render(<DowngradeModal {...props} isOpen />);
    fireEvent.click(await screen.findByRole("button", { name: /^Select / }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade bash to 5.1.016-1" }));
    if (dismissal === "Escape") fireEvent.keyDown(document.body, { key: "Escape" });
    else if (dismissal === "backdrop") fireEvent.mouseDown(document.querySelector(".pf-v6-c-backdrop")!);
    else {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "Stop downgrading bash" }));
    }
    expect(cancel).toHaveBeenCalledTimes(dismissal === "Cancel" ? 1 : 0);
    expect(onClose).not.toHaveBeenCalled();
    rerender(<DowngradeModal {...props} isOpen={false} />);
    rerender(<DowngradeModal {...props} isOpen />);
    if (dismissal === "Cancel") expect(screen.getByRole("button", { name: /Cancelling/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Confirm Downgrade" })).not.toBeInTheDocument();
    act(() => mockDowngradePackage.mock.lastCall![0].onError("Commit failed", "transaction_failed", "No space left on device"));
    expect(screen.getByText("No space left on device")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});

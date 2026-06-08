import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { DowngradeModal } from "./DowngradeModal";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listDowngrades: vi.fn(),
    listArchiveVersions: vi.fn(),
    downgradePackage: vi.fn(),
    downgradeFromArchive: vi.fn(),
  };
});

const mockListDowngrades = vi.mocked(api.listDowngrades);
const mockListArchiveVersions = vi.mocked(api.listArchiveVersions);
const mockDowngradePackage = vi.mocked(api.downgradePackage);
const mockDowngradeFromArchive = vi.mocked(api.downgradeFromArchive);

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
    mockDowngradePackage.mockReturnValue({ cancel: vi.fn() });
    mockDowngradeFromArchive.mockReturnValue({ cancel: vi.fn() });
  });

  afterEach(() => {
    cleanup();
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
      fireEvent.click(screen.getByRole("button", { name: /Downgrade/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Confirm Downgrade/i }));
    });

    expect(mockDowngradePackage).toHaveBeenCalledWith(
      expect.any(Object),
      "bash",
      "5.1.016-1"
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
      fireEvent.click(screen.getByRole("button", { name: /Downgrade/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Confirm Downgrade/i }));
    });

    expect(mockDowngradeFromArchive).toHaveBeenCalledWith(
      expect.any(Object),
      "bash",
      "bash-5.0.018-1-x86_64.pkg.tar.zst"
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
    expect(screen.getByRole("button", { name: /Upgrade/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Install/i })).toBeInTheDocument();
  });
});

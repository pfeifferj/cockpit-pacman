import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { PreflightConfirmModal } from "./PreflightConfirmModal";
import type { PreflightResponse } from "../api";
import previewFixture from "../../test/fixtures/preflight-upgrade-preview.json";

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
  return { ...actual, onSystemChanged: systemChange.subscribe };
});

afterEach(cleanup);

const blocked = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

function preflight(over: Partial<PreflightResponse> = {}): PreflightResponse {
  return {
    success: true,
    conflicts: [],
    replacements: [],
    removals: [],
    providers: [],
    import_keys: [],
    warnings: [],
    packages_to_upgrade: 3,
    total_download_size: 1024,
    ...over,
  };
}

function renderModal(data: PreflightResponse) {
  const onProceed = vi.fn();
  render(
    <PreflightConfirmModal isOpen preflight={data} onClose={vi.fn()} onProceed={onProceed} />
  );
  return { onProceed, proceed: () => screen.getByRole("button", { name: /^Upgrade \d+ packages?/ }) };
}

const STALE = /The system changed since this preview/;
const diskBlock = preflight({
  warnings: [{
    id: "disk_space", severity: "danger", title: "Not enough free space on /usr",
    message: "Needs about 1.4 GiB, 0.9 GiB free.", packages: [],
    blocking: true, disk: { mount: "/usr", deficit: 512 * 1024 * 1024, holds_cache: true },
  }],
});

describe("PreflightConfirmModal freshness", () => {
  const view = (data: PreflightResponse, extra: Partial<React.ComponentProps<typeof PreflightConfirmModal>> = {}) => (
    <PreflightConfirmModal isOpen preflight={data} onClose={vi.fn()} onProceed={vi.fn()} {...extra} />
  );
  const proceed = () => screen.getByRole("button", { name: /^Upgrade \d+ packages?/ });

  it("marks itself stale on a system change and offers Refresh preview until a new preflight arrives", () => {
    const onRefresh = vi.fn();
    const onProceed = vi.fn();
    const first = preflight();
    const { rerender } = render(view(first, { onRefresh, onProceed }));
    expect(blocked(proceed())).toBe(false);
    expect(screen.queryByRole("button", { name: "Refresh preview" })).not.toBeInTheDocument();

    act(() => emitSystemChange("system"));
    expect(screen.getByRole("heading", { name: STALE })).toBeInTheDocument();
    expect(proceed()).toHaveAccessibleDescription("The system changed since this preview");
    fireEvent.click(proceed());
    expect(onProceed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(view(first, { onRefresh, onProceed, refreshing: true }));
    expect(proceed()).toHaveAccessibleDescription("Refreshing the preview…");
    rerender(view(preflight(), { onRefresh, onProceed }));
    expect(screen.queryByRole("heading", { name: STALE })).not.toBeInTheDocument();
    expect(blocked(proceed())).toBe(false);
  });

  it("requires removal consent again after refreshing the preview", () => {
    const first = preflight({ removals: ["old-driver"] });
    const { rerender } = render(view(first));
    fireEvent.click(screen.getByRole("checkbox", { name: "Remove old-driver" }));
    expect(blocked(proceed())).toBe(false);
    rerender(view({ ...first }));
    expect(screen.getByRole("checkbox", { name: "Remove old-driver" })).not.toBeChecked();
    expect(blocked(proceed())).toBe(true);
  });

  it("opens stale when the system changed while the preflight ran", () => {
    render(view(preflight(), { onRefresh: vi.fn(), initiallyStale: true }));
    expect(screen.getByRole("heading", { name: STALE })).toBeInTheDocument();
    expect(blocked(proceed())).toBe(true);
  });

  it("offers Check again on a blocking warning", () => {
    const onRefresh = vi.fn();
    render(view(diskBlock, { onRefresh }));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("stops watching once closed", () => {
    const { rerender } = render(view(preflight()));
    expect(systemChange.listeners.size).toBe(1);
    rerender(<PreflightConfirmModal isOpen={false} preflight={preflight()} onClose={vi.fn()} onProceed={vi.fn()} />);
    expect(systemChange.listeners.size).toBe(0);
  });
});

describe("PreflightConfirmModal", () => {
  it("blocks Proceed until removals are acknowledged", () => {
    const { proceed } = renderModal(preflight({ removals: ["orphan-pkg"] }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Upgrade 3 packages and remove 1?");
    expect(blocked(proceed())).toBe(true);
    expect(proceed()).toHaveAccessibleDescription("Confirm first: Remove orphan-pkg");

    fireEvent.click(screen.getByRole("checkbox", { name: "Remove orphan-pkg" }));
    expect(blocked(proceed())).toBe(false);
  });

  it("blocks Proceed until every warning-severity warning is acknowledged", () => {
    const { proceed } = renderModal(
      preflight({
        warnings: [
          { id: "w1", severity: "warning", title: "Kernel", message: "reboot needed", packages: [], blocking: false },
          { id: "w2", severity: "danger", title: "Firmware", message: "mismatch", packages: [], blocking: false },
        ],
      })
    );
    expect(proceed()).toHaveAccessibleDescription("Confirm first: Proceed despite: Kernel; Proceed despite: Firmware");

    fireEvent.click(screen.getByRole("checkbox", { name: "Proceed despite: Kernel" }));
    expect(proceed()).toHaveAccessibleDescription("Confirm first: Proceed despite: Firmware");
    fireEvent.click(screen.getByRole("checkbox", { name: "Proceed despite: Firmware" }));
    expect(blocked(proceed())).toBe(false);
  });

  it("blocks Proceed with the free-space reason when the disk is too full", () => {
    const { proceed, onProceed } = renderModal(
      preflight({
        warnings: [{
          id: "disk_space", severity: "danger", title: "Not enough free space on /usr",
          message: "Needs about 1.4 GiB, 0.9 GiB free.", packages: [],
          blocking: true, disk: { mount: "/usr", deficit: 512 * 1024 * 1024, holds_cache: true },
        }],
      })
    );
    expect(blocked(proceed())).toBe(true);
    expect(proceed()).toHaveAccessibleDescription(
      "Not enough free space on /usr. Free at least 512.0 MiB on /usr. Cleaning the package cache frees space on /usr."
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(proceed());
    expect(onProceed).not.toHaveBeenCalled();
  });

  it("does not demand acknowledgement for info-severity warnings", () => {
    const { proceed } = renderModal(
      preflight({
        warnings: [{ id: "i1", severity: "info", title: "FYI", message: "nothing scary", packages: [], blocking: false }],
      })
    );
    expect(blocked(proceed())).toBe(false);
  });

  it("copies the transaction as one line per package plus removals and replacements", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const packages = [
      { name: "linux", current_version: "6.9.1-1", new_version: "6.10.2-1" },
      { name: "glibc", current_version: "2.39-1", new_version: "2.40-1" },
    ];
    render(
      <PreflightConfirmModal
        isOpen
        preflight={preflight({
          removals: ["orphan-pkg"],
          replacements: [{ old_package: "old-thing", new_package: "new-thing" }],
        })}
        packages={packages}
        onClose={vi.fn()}
        onProceed={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy transaction" }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0].split("\n")).toEqual([
      "linux 6.9.1-1 -> 6.10.2-1",
      "glibc 2.39-1 -> 2.40-1",
      "remove orphan-pkg",
      "replace old-thing with new-thing",
    ]);
  });

  it("omits the copy section when there is nothing to list", () => {
    renderModal(preflight());
    expect(screen.queryByRole("button", { name: "Copy as text" })).not.toBeInTheDocument();
  });

  it("requires manual verification for a missing signing key", () => {
    const { proceed, onProceed } = renderModal(preflight({ import_keys: [{ fingerprint: "ABCD1234", uid: "Example packager" }] }));
    expect(screen.getByText("Signing keys require verification")).toBeInTheDocument();
    expect(screen.getByText(/Example packager.*ABCD1234/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /trust these keys/ })).not.toBeInTheDocument();
    expect(proceed()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(proceed());
    expect(onProceed).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    render(
      <PreflightConfirmModal isOpen={false} preflight={preflight()} onClose={vi.fn()} onProceed={vi.fn()} />
    );
    expect(screen.queryByRole("button", { name: /^Upgrade/ })).not.toBeInTheDocument();
  });

  describe("with a transaction preview", () => {
    const fixture = previewFixture as PreflightResponse;
    const selected = [
      { name: "linux", current_version: "6.7.0-arch1-1", new_version: "6.7.1-arch1-1" },
      { name: "glibc", current_version: "2.38-1", new_version: "2.39-1" },
    ];

    function renderPreview(data: PreflightResponse, onClose = vi.fn()) {
      render(
        <PreflightConfirmModal isOpen preflight={data} packages={selected} onClose={onClose} onProceed={vi.fn()} />
      );
      return onClose;
    }

    it("names the counts in the title and the pulled-in package beyond the selection", () => {
      renderPreview(fixture);
      expect(screen.getByRole("dialog")).toHaveAccessibleName("Upgrade 2 packages, install 1 and remove 1?");
      expect(screen.getByText("Beyond your selection:").parentElement).toHaveTextContent(
        "Beyond your selection: libxcrypt pulled in (117.2 KiB download) and libxcrypt-legacy removed (293.0 KiB freed)"
      );
      const installs = screen.getByRole("grid", { name: "Will be installed" });
      expect(installs).toHaveTextContent("libxcrypt");
      expect(installs).toHaveTextContent("Dependency");
    });

    it("shows the card's download and net totals", () => {
      renderPreview(fixture);
      expect(screen.getByText("Download size 151.0 MiB · Net size +3.9 MiB")).toBeInTheDocument();
    });

    it("puts the counts and removals in a danger commit label", () => {
      renderPreview(fixture);
      const commit = screen.getByRole("button", { name: "Upgrade 2 packages, install 1 and remove 1" });
      expect(commit).toHaveClass("pf-m-danger");
    });

    it("uses a primary 'Upgrade N packages' commit without removals", () => {
      renderPreview({ ...fixture, conflicts: [], remove: [] });
      const commit = screen.getByRole("button", { name: "Upgrade 2 packages and install 1" });
      expect(commit).toHaveClass("pf-m-primary");
      expect(blocked(commit)).toBe(false);
    });

    it("needs only the removal tick when every conflict implies a listed removal", () => {
      renderPreview(fixture);
      const commit = screen.getByRole("button", { name: "Upgrade 2 packages, install 1 and remove 1" });
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
      expect(blocked(commit)).toBe(true);
      fireEvent.click(screen.getByRole("checkbox", { name: "Remove libxcrypt-legacy" }));
      expect(blocked(commit)).toBe(false);
    });

    it("keeps a separate conflict tick when a conflict implies no listed removal", () => {
      renderPreview({ ...fixture, conflicts: [...fixture.conflicts!, { package1: "mesa", package2: "mesa-amber" }] });
      expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("gives the upgrades a Reason column", () => {
      renderPreview(fixture);
      const upgrades = screen.getByRole("grid", { name: "Will be upgraded or reinstalled" });
      expect(within(upgrades).getAllByText("Requested")).toHaveLength(2);
    });

    it("lists more than five pulled-in packages in their own expanded group, first", () => {
      const deps = Array.from({ length: 6 }, (_, i) => ({
        name: `dep${i}`, version: "1-1", repo: "extra", download_size: 1024, installed_size: 1024, reason: "dependency" as const,
      }));
      renderPreview({ ...fixture, add: [...fixture.add!, ...deps] });
      expect(screen.getByText("Beyond your selection:").parentElement).toHaveTextContent(
        "7 packages pulled in (123.2 KiB download), listed first below"
      );
      const groups = screen.getAllByRole("grid");
      expect(groups[0]).toHaveAccessibleName("Beyond your selection");
      expect(within(groups[0]).getAllByRole("row")).toHaveLength(8);
      expect(screen.queryByRole("grid", { name: "Will be installed" })).not.toBeInTheDocument();
    });

    it("names the skipped updates of a partial upgrade", () => {
      render(
        <PreflightConfirmModal
          isOpen
          preflight={fixture}
          packages={selected}
          skipped={["firefox", "mesa"]}
          onClose={vi.fn()}
          onProceed={vi.fn()}
        />
      );
      expect(screen.getByText(/Skipping firefox, mesa\./)).toBeInTheDocument();
    });

    it("requires verification of every unknown signing key", () => {
      renderPreview({
        ...fixture,
        conflicts: [],
        remove: [],
        import_keys: [
          { fingerprint: "AAAA", uid: "Jane Doe <jane@example.org>" },
          { fingerprint: "BBBB", uid: "John Roe <john@example.org>" },
        ],
      });
      const commit = screen.getByRole("button", { name: "Upgrade 2 packages and install 1" });
      expect(screen.queryByRole("checkbox", { name: /Import key/ })).not.toBeInTheDocument();
      expect(screen.getByText(/Jane Doe.*AAAA/)).toBeInTheDocument();
      expect(screen.getByText(/John Roe.*BBBB/)).toBeInTheDocument();
      expect(commit).toHaveAccessibleDescription("Verify and import the signing keys before retrying.");
      expect(blocked(commit)).toBe(true);
    });

    it("closes on a backdrop click until a tick is set, then keeps the dialog", () => {
      const onClose = renderPreview(fixture);
      const backdrop = document.querySelector(".pf-v6-c-backdrop")!;
      fireEvent.mouseDown(backdrop);
      expect(onClose).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("checkbox", { name: "Remove libxcrypt-legacy" }));
      fireEvent.mouseDown(backdrop);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

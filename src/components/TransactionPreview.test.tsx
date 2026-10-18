import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { PreviewGroups, TransactionPreview, previewSummary } from "./TransactionPreview";
import { formatPreviewTotals, type PreviewAdd, type TransactionPreview as PreviewData } from "../api";

function makePreview(overrides: Partial<PreviewData> = {}): PreviewData {
  return {
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
    ...overrides,
  };
}

const dep = (name: string): PreviewAdd => ({
  name, version: "1.0-1", repo: "extra", download_size: 1024, installed_size: 2048, reason: "dependency",
});

const rowNames = (table: HTMLElement) =>
  within(table).getAllByRole("row").slice(1).map(r => within(r).getAllByRole("cell")[0].textContent);

describe("TransactionPreview", () => {
  afterEach(() => cleanup());

  it("builds the summary from formatPreviewTotals", () => {
    const preview = makePreview({
      add: [dep("a"), dep("b")],
      remove: [{ name: "c", version: "1", installed_size: 100, reason: "conflict" }],
      total_download_size: 12_000_000,
      net_installed_size: 48_000_000,
    });
    const totals = formatPreviewTotals(preview);
    expect(previewSummary(preview)).toBe(`3 packages · Download size ${totals.download} · Net size ${totals.net}`);
  });

  it("leaves out the download part when nothing is downloaded", () => {
    const preview = makePreview({
      remove: [{ name: "c", version: "1", installed_size: 2048, reason: "target" }],
      net_installed_size: -2048,
    });
    expect(previewSummary(preview)).toBe(`1 package · Net size ${formatPreviewTotals(preview).net}`);
  });

  it("groups installs, upgrades and removals with the target first and reasons as text", () => {
    render(
      <TransactionPreview
        failureTitle="Cannot install foo"
        preview={makePreview({
          add: [
            dep("zlib"),
            { ...dep("foo"), reason: "target" },
            { ...dep("glibc"), version: "2.41-1", old_version: "2.40-1" },
          ],
          remove: [{ name: "foo-git", version: "r1", installed_size: 4096, reason: "conflict" }],
        })}
      />
    );

    expect(rowNames(screen.getByRole("grid", { name: "Will be installed" }))).toEqual(["foo", "zlib"]);
    const upgrades = screen.getByRole("grid", { name: "Will be upgraded or reinstalled" });
    expect(within(upgrades).getByText("2.40-1 → 2.41-1")).toBeInTheDocument();
    const removed = screen.getByRole("grid", { name: "Will be removed" });
    expect(within(removed).getByText("Conflicts with a package being installed")).toBeInTheDocument();
  });

  it("lists recursive removals separately", () => {
    render(
      <TransactionPreview
        failureTitle="Cannot remove orphans"
        preview={makePreview({
          remove: [
            { name: "bar", version: "1", installed_size: 1, reason: "target" },
            { name: "libbar", version: "1", installed_size: 1, reason: "dependency" },
          ],
        })}
      />
    );
    expect(rowNames(screen.getByRole("grid", { name: "Will be removed" }))).toEqual(["bar"]);
    expect(rowNames(screen.getByRole("grid", { name: "Also removed (no longer needed)" }))).toEqual(["libbar"]);
  });

  it("names each blocking dependent and hides the summary", () => {
    render(
      <TransactionPreview
        failureTitle="Cannot uninstall nss"
        preview={makePreview({
          success: false,
          blocked_by: [
            { target: "firefox", depend: "nss" },
            { target: "thunderbird", depend: "nss" },
          ],
        })}
      />
    );
    expect(screen.getByText("Cannot uninstall nss")).toBeInTheDocument();
    expect(screen.getByText("firefox requires nss")).toBeInTheDocument();
    expect(screen.getByText("thunderbird requires nss")).toBeInTheDocument();
    expect(screen.queryByText(/packages? ·/)).not.toBeInTheDocument();
  });

  it("keeps an unknown signing key blocked after removal consent", () => {
    const onAcknowledgedChange = vi.fn();
    render(
      <TransactionPreview
        failureTitle="x"
        onAcknowledgedChange={onAcknowledgedChange}
        preview={makePreview({
          add: [{ ...dep("foo"), reason: "target" }],
          remove: [{ name: "foo-git", version: "r1", installed_size: 1, reason: "conflict" }],
          import_keys: [{ fingerprint: "ABCD", uid: "Packager <p@example.org>" }],
        })}
      />
    );
    expect(onAcknowledgedChange).toHaveBeenLastCalledWith({
      complete: false,
      missing: ["Remove foo-git"],
      reason: "Verify and import the signing keys before retrying. Confirm first: Remove foo-git",
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Remove foo-git" }));
    expect(screen.queryByRole("checkbox", { name: /Import key/ })).not.toBeInTheDocument();
    expect(onAcknowledgedChange).toHaveBeenLastCalledWith({ complete: false, missing: [], reason: "Verify and import the signing keys before retrying." });
  });

  it("asks no tick for requested removals", () => {
    const onAcknowledgedChange = vi.fn();
    render(
      <TransactionPreview
        failureTitle="x"
        onAcknowledgedChange={onAcknowledgedChange}
        preview={makePreview({ remove: [{ name: "bar", version: "1", installed_size: 1, reason: "target" }] })}
      />
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(onAcknowledgedChange).toHaveBeenLastCalledWith({ complete: true, missing: [], reason: undefined });
  });

  it("shows conflicts, replacements, providers, keys and warnings", () => {
    render(
      <TransactionPreview
        failureTitle="x"
        preview={makePreview({
          conflicts: [{ package1: "foo", package2: "foo-git" } as PreviewData["conflicts"][number]],
          replacements: [{ old_package: "old", new_package: "new" }],
          providers: [{ dependency: "java-runtime", providers: ["jre-openjdk", "jre17-openjdk"] }],
          import_keys: [{ fingerprint: "ABCD", uid: "Packager <p@example.org>" }],
          warnings: [{ id: "w1", severity: "warning", title: "Kernel update", message: "Reboot needed", packages: [], blocking: false }],
        })}
      />
    );
    expect(screen.getByText("foo conflicts with foo-git")).toBeInTheDocument();
    expect(screen.getByText("new replaces old")).toBeInTheDocument();
    expect(screen.getByText(/java-runtime: jre-openjdk/)).toBeInTheDocument();
    expect(screen.getByText("Packager <p@example.org> (ABCD)")).toBeInTheDocument();
    expect(screen.getByText("Kernel update")).toBeInTheDocument();
  });

  it("collapses a group over ten rows behind a toggle naming the count", () => {
    const add = Array.from({ length: 11 }, (_, i) => dep(`lib${String(i).padStart(2, "0")}`));
    render(<TransactionPreview failureTitle="x" preview={makePreview({ add })} />);

    const toggle = screen.getByRole("button", { name: "Will be installed (11 packages)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(rowNames(screen.getByRole("grid", { name: "Will be installed" }))).toHaveLength(11);
    expect(screen.getByText(/^11 packages/)).toBeInTheDocument();
  });

  it("exports the grouped list on its own, without summary or alerts", () => {
    render(
      <PreviewGroups
        add={[dep("zlib"), { ...dep("glibc"), version: "2.41-1", old_version: "2.40-1", reason: "target" }]}
        remove={[{ name: "old", version: "1", installed_size: 10, reason: "conflict" }]}
      />
    );
    expect(rowNames(screen.getByRole("grid", { name: "Will be installed" }))).toEqual(["zlib"]);
    expect(rowNames(screen.getByRole("grid", { name: "Will be upgraded or reinstalled" }))).toEqual(["glibc"]);
    expect(rowNames(screen.getByRole("grid", { name: "Will be removed" }))).toEqual(["old"]);
    expect(screen.queryByText(/packages? ·/)).not.toBeInTheDocument();
  });
});

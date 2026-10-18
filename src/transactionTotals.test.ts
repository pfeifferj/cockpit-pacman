import { describe, it, expect } from "vitest";
import updatesFixture from "../test/fixtures/updates.json";
import previewFixture from "../test/fixtures/preflight-upgrade-preview.json";
import { formatPreviewTotals, type PreflightResponse, type PreviewAdd, type TransactionPreview } from "./api";
import {
  beyondSelection,
  describeUpgrade,
  formatTotalsLine,
  listNames,
  needsUpgradeConfirm,
  selectionTotals,
  upgradeCounts,
  upgradePreviewTotals,
} from "./transactionTotals";

const updates = updatesFixture.updates;
const names = updates.map((u) => u.name);

const targetsOf = (): PreviewAdd[] =>
  updates.map((u) => ({
    name: u.name,
    version: u.new_version,
    repo: u.repository,
    download_size: u.download_size,
    installed_size: u.new_size,
    old_version: u.current_version,
    reason: "target",
  }));

function upgrade(add: PreviewAdd[], over: Partial<PreflightResponse> = {}): PreflightResponse {
  const old = new Map(updates.map((u) => [u.name, u.current_size]));
  return {
    success: true,
    packages_to_upgrade: add.length,
    total_download_size: add.reduce((s, p) => s + p.download_size, 0),
    net_installed_size: add.reduce((s, p) => s + p.installed_size - (old.get(p.name) ?? 0), 0),
    add,
    ...over,
  };
}

const libnew: PreviewAdd = {
  name: "libnew", version: "1.0-1", repo: "core", download_size: 0, installed_size: 3_000_000, reason: "dependency",
};

describe("selectionTotals and upgradePreviewTotals", () => {
  it("give identical strings for the selection and a preview of the same packages", () => {
    expect(upgradePreviewTotals(upgrade(targetsOf()))).toEqual(selectionTotals(updates));
  });

  it("change only the count and net when the preview pulls in a dependency", () => {
    const card = selectionTotals(updates);
    const preview = upgradePreviewTotals(upgrade([...targetsOf(), libnew]));
    expect(preview).toEqual({ ...card, count: card.count + 1, net: preview!.net });
    expect(preview!.net).not.toBe(card.net);
  });

  it("follow the formatPreviewTotals sign convention", () => {
    const fixture = previewFixture as PreflightResponse;
    const asPreview = {
      add: fixture.add!, remove: fixture.remove!,
      total_download_size: fixture.total_download_size, net_installed_size: fixture.net_installed_size!,
    } as TransactionPreview;
    expect(upgradePreviewTotals(fixture)).toEqual(formatPreviewTotals(asPreview));
    expect(upgradePreviewTotals(fixture)!.net.startsWith("+")).toBe(true);
    const shrink = selectionTotals([{ download_size: 0, current_size: 2048, new_size: 1024 }]);
    expect(shrink.net).toBe(formatPreviewTotals({ ...asPreview, net_installed_size: -1024 }).net);
  });

  it("returns null for a preflight without a preview", () => {
    expect(upgradePreviewTotals({ success: true, packages_to_upgrade: 2, total_download_size: 10 })).toBeNull();
  });
});

describe("needsUpgradeConfirm", () => {
  it("is false when the preview equals the selection", () => {
    expect(needsUpgradeConfirm(upgrade(targetsOf()), names)).toBe(false);
  });

  it("is true for an extra add", () => {
    expect(needsUpgradeConfirm(upgrade([...targetsOf(), libnew]), names)).toBe(true);
  });

  it("is true for a removal", () => {
    const remove = [{ name: "old", version: "1-1", installed_size: 10, reason: "conflict" as const }];
    expect(needsUpgradeConfirm(upgrade(targetsOf(), { remove }), names)).toBe(true);
  });

  it("is true when a selected package is missing from the preview", () => {
    expect(needsUpgradeConfirm(upgrade(targetsOf().slice(0, 1)), names)).toBe(true);
  });

  it("is true for issues even when the sets match", () => {
    const conflicts = [{ package1: "a", package2: "b" }];
    expect(needsUpgradeConfirm(upgrade(targetsOf(), { conflicts }), names)).toBe(true);
  });

  it("is true for any deselected row, even when the preview equals the selection", () => {
    expect(needsUpgradeConfirm(upgrade(targetsOf()), names, ["firefox"])).toBe(true);
  });

  it("falls back to the issue list without a preview", () => {
    expect(needsUpgradeConfirm({ success: true, packages_to_upgrade: 2, total_download_size: 0 }, names)).toBe(false);
  });
});

describe("beyondSelection", () => {
  it("lists pulled-in packages and removals with the extra download", () => {
    const fixture = previewFixture as PreflightResponse;
    const beyond = beyondSelection(fixture, names);
    expect(beyond.add.map((p) => p.name)).toEqual(["libxcrypt"]);
    expect(beyond.remove.map((p) => p.name)).toEqual(["libxcrypt-legacy"]);
    expect(beyond.downloadBytes).toBe(120_000);
    expect(beyond.freedBytes).toBe(300_000);
  });

  it("counts removals from the same union the commit uses", () => {
    const fixture = { ...(previewFixture as PreflightResponse), removals: ["libxcrypt-legacy", "nvidia-lts"] };
    expect(beyondSelection(fixture, names).removeNames).toEqual(["libxcrypt-legacy", "nvidia-lts"]);
    expect(upgradeCounts(fixture).remove).toBe(2);
  });
});

describe("upgradeCounts and describeUpgrade", () => {
  it("split the preview into upgrades, installs and removals", () => {
    const counts = upgradeCounts(previewFixture as PreflightResponse);
    expect(counts).toEqual({ upgrade: 2, install: 1, remove: 1 });
    expect(describeUpgrade(counts)).toBe("Upgrade 2 packages, install 1 and remove 1");
    expect(describeUpgrade(counts, "past")).toBe("Upgraded 2 packages, installed 1 and removed 1");
  });

  it("names only the upgrade when nothing else changes", () => {
    expect(describeUpgrade({ upgrade: 1, install: 0, remove: 0 })).toBe("Upgrade 1 package");
    expect(describeUpgrade({ upgrade: 3, install: 0, remove: 2 })).toBe("Upgrade 3 packages and remove 2");
  });

  it("groups thousands in every count", () => {
    expect(describeUpgrade({ upgrade: 1000, install: 1000, remove: 1000 }, "past"))
      .toBe("Upgraded 1,000 packages, installed 1,000 and removed 1,000");
  });

  it("falls back to packages_to_upgrade without a preview", () => {
    expect(upgradeCounts({ success: true, packages_to_upgrade: 4, total_download_size: 0 })).toEqual({
      upgrade: 4, install: 0, remove: 0,
    });
  });
});

describe("formatTotalsLine", () => {
  it("gives the card and the confirm one line for the same packages", () => {
    const line = formatTotalsLine(selectionTotals(updates));
    expect(line).toBe(formatTotalsLine(upgradePreviewTotals(upgrade(targetsOf()))!));
    expect(line).toMatch(/^Download size .+ · Net size .+$/);
  });

  it("leaves out the download when nothing is downloaded", () => {
    expect(formatTotalsLine(selectionTotals([{ download_size: 0, current_size: 2048, new_size: 1024 }]))).toBe("Net size -1.0 KiB");
  });
});

describe("listNames", () => {
  it("joins names and folds the tail past the limit", () => {
    expect(listNames(["a"])).toBe("a");
    expect(listNames(["a", "b", "c"])).toBe("a, b and c");
    expect(listNames(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d and 3 more");
  });
});

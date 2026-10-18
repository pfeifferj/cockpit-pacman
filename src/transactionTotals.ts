import {
  previewTotals,
  type PreflightResponse,
  type PreviewAdd,
  type PreviewRemove,
  type PreviewTotals,
  type UpdateInfo,
} from "./api";
import { plural } from "./utils";

/** Totals of the selected rows in the Updates table. */
export function selectionTotals(updates: Pick<UpdateInfo, "download_size" | "current_size" | "new_size">[]): PreviewTotals {
  return previewTotals(
    updates.length,
    updates.reduce((sum, u) => sum + u.download_size, 0),
    updates.reduce((sum, u) => sum + u.new_size - u.current_size, 0),
  );
}

/** Totals of the transaction preflight resolved, or null when it carries no preview. */
export function upgradePreviewTotals(preflight: PreflightResponse): PreviewTotals | null {
  if (!preflight.add) return null;
  return previewTotals(
    preflight.add.length + (preflight.remove?.length ?? 0),
    preflight.total_download_size,
    preflight.net_installed_size ?? 0,
  );
}

/** "Download size X · Net size Y"; the download part is left out when nothing is downloaded. */
export function formatTotalsLine(totals: PreviewTotals): string {
  const parts = totals.downloadBytes > 0 ? [`Download size ${totals.download}`] : [];
  parts.push(`Net size ${totals.net}`);
  return parts.join(" · ");
}

/** Names the upgrade removes: alpm's remove list plus packages it asked to remove. */
export function removalNames(preflight: PreflightResponse | null): string[] {
  return [...new Set([...(preflight?.removals ?? []), ...(preflight?.remove ?? []).map((p) => p.name)])];
}

export interface UpgradeCounts {
  upgrade: number;
  install: number;
  remove: number;
}

/** Counts upgraded, newly installed and removed packages. */
export function upgradeCounts(preflight: PreflightResponse): UpgradeCounts {
  const add = preflight.add;
  return {
    upgrade: add ? add.filter((p) => p.old_version).length : preflight.packages_to_upgrade,
    install: add ? add.filter((p) => !p.old_version).length : 0,
    remove: removalNames(preflight).length,
  };
}

/** "Upgrade 3 packages, install 1 and remove 1", or its past tense. */
export function describeUpgrade(counts: UpgradeCounts, tense: "imperative" | "past" = "imperative"): string {
  const [upgrade, install, remove] = tense === "past"
    ? ["Upgraded", "installed", "removed"]
    : ["Upgrade", "install", "remove"];
  const parts = [`${upgrade} ${plural(counts.upgrade, "package")}`];
  if (counts.install > 0) parts.push(`${install} ${counts.install.toLocaleString()}`);
  if (counts.remove > 0) parts.push(`${remove} ${counts.remove.toLocaleString()}`);
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export interface BeyondSelection {
  add: PreviewAdd[];
  remove: PreviewRemove[];
  /** Same union removalNames gives, so the beyond line and the commit agree. */
  removeNames: string[];
  downloadBytes: number;
  freedBytes: number;
}

/** What the resolved upgrade does that the selected rows did not show. */
export function beyondSelection(preflight: PreflightResponse, selectedNames: Iterable<string>): BeyondSelection {
  const selected = new Set(selectedNames);
  const add = (preflight.add ?? []).filter((p) => !selected.has(p.name));
  const remove = preflight.remove ?? [];
  return {
    add,
    remove,
    removeNames: removalNames(preflight),
    downloadBytes: add.reduce((sum, p) => sum + p.download_size, 0),
    freedBytes: remove.reduce((sum, p) => sum + p.installed_size, 0),
  };
}

function hasUpgradeIssues(preflight: PreflightResponse): boolean {
  return (
    (preflight.conflicts?.length ?? 0) > 0 ||
    (preflight.replacements?.length ?? 0) > 0 ||
    (preflight.removals?.length ?? 0) > 0 ||
    (preflight.providers?.length ?? 0) > 0 ||
    (preflight.import_keys?.length ?? 0) > 0 ||
    (preflight.warnings?.some((w) => w.severity !== "info") ?? false)
  );
}

/** Requires confirmation for transaction risks, changed package selections and partial upgrades. */
export function needsUpgradeConfirm(
  preflight: PreflightResponse,
  selectedNames: Iterable<string>,
  deselectedNames: Iterable<string> = [],
): boolean {
  if ([...deselectedNames].length > 0) return true;
  if (hasUpgradeIssues(preflight)) return true;
  if (!preflight.add) return false;
  if ((preflight.remove?.length ?? 0) > 0) return true;
  const selected = new Set(selectedNames);
  const added = new Set(preflight.add.map((p) => p.name));
  return added.size !== selected.size || [...added].some((name) => !selected.has(name));
}

/** "a", "a and b", "a, b and c"; past `max` names the rest as "N more". */
export function listNames(names: string[], max = 5): string {
  if (names.length === 0) return "";
  const shown = names.length > max ? [...names.slice(0, max - 1), `${names.length - max + 1} more`] : names;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

import type { PackageSecurityAdvisory } from "./bindings";

export function isActionable(advisory: PackageSecurityAdvisory): boolean {
  return advisory.fixed_version != null;
}

export interface PartitionedAdvisories {
  actionable: PackageSecurityAdvisory[];
  unresolved: PackageSecurityAdvisory[];
}

export function partitionAdvisories(
  advisories: readonly PackageSecurityAdvisory[],
): PartitionedAdvisories {
  const actionable: PackageSecurityAdvisory[] = [];
  const unresolved: PackageSecurityAdvisory[] = [];
  for (const advisory of advisories) {
    (isActionable(advisory) ? actionable : unresolved).push(advisory);
  }
  return { actionable, unresolved };
}

const SEVERITY_ORDER: Record<string, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
  Unknown: 0,
};

export function highestOf(advisories: PackageSecurityAdvisory[]): PackageSecurityAdvisory | null {
  if (advisories.length === 0) return null;
  return advisories.reduce((a, b) =>
    (SEVERITY_ORDER[b.severity] ?? 0) > (SEVERITY_ORDER[a.severity] ?? 0) ? b : a
  );
}

export const NO_FIX_CAVEAT =
  "Arch's tracker lists no fixed version for these. Records can stay open after " +
  "a fix lands upstream, so an advisory may no longer apply to the installed " +
  "version even though the tracker still matches it.";

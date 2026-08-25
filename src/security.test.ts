import { describe, it, expect } from "vitest";
import { highestOf, isActionable, partitionAdvisories } from "./security";
import type { PackageSecurityAdvisory } from "./bindings";

function advisory(over: Partial<PackageSecurityAdvisory> = {}): PackageSecurityAdvisory {
  return {
    package: "linux",
    severity: "High",
    advisory_type: "arbitrary code execution",
    avg_name: "AVG-1879",
    cve_ids: ["CVE-2021-43976"],
    fixed_version: null,
    affected_version: "5.15.8.arch1-1",
    installed_version: "7.1.8.arch1-3",
    status: "Vulnerable",
    ...over,
  };
}

describe("isActionable", () => {
  it("is true when the tracker names a fix to update to", () => {
    expect(isActionable(advisory({ fixed_version: "9.0.1225-1" }))).toBe(true);
  });

  it("is false when no fix is recorded", () => {
    expect(isActionable(advisory())).toBe(false);
  });

  it("is false when the field is absent rather than null", () => {
    const bare = advisory();
    delete (bare as { fixed_version?: unknown }).fixed_version;
    expect(isActionable(bare)).toBe(false);
  });
});

describe("partitionAdvisories", () => {
  it("separates what an update fixes from what it cannot", () => {
    const fixable = advisory({ package: "vim", fixed_version: "9.0.1225-1" });
    const stuck = advisory();

    const { actionable, unresolved } = partitionAdvisories([stuck, fixable]);

    expect(actionable.map((a) => a.package)).toEqual(["vim"]);
    expect(unresolved.map((a) => a.package)).toEqual(["linux"]);
  });

  it("copes with an empty list", () => {
    expect(partitionAdvisories([])).toEqual({ actionable: [], unresolved: [] });
  });
});

describe("highestOf", () => {
  it("ranks by severity, not list order", () => {
    const low = advisory({ package: "a", severity: "Low" });
    const critical = advisory({ package: "b", severity: "Critical" });
    const high = advisory({ package: "c", severity: "High" });

    expect(highestOf([low, critical, high])?.package).toBe("b");
    expect(highestOf([low, high])?.package).toBe("c");
  });

  it("ranks a severity it does not know below every known one", () => {
    const weird = advisory({ package: "a", severity: "Catastrophic" });
    const low = advisory({ package: "b", severity: "Low" });

    expect(highestOf([weird, low])?.package).toBe("b");
  });

  it("is null for an empty list", () => {
    expect(highestOf([])).toBeNull();
  });
});

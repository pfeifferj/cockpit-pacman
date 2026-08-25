import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AdvisoryPopover } from "./AdvisoryPopover";
import { partitionAdvisories } from "../security";
import type { PackageSecurityAdvisory } from "../api";

afterEach(cleanup);

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

describe("AdvisoryPopover", () => {
  it("labels with the highest actionable severity and counts the rest", () => {
    const partition = partitionAdvisories([
      advisory({ avg_name: "AVG-1", severity: "Low", fixed_version: "1.1-1" }),
      advisory({ avg_name: "AVG-2", severity: "Critical", fixed_version: "1.2-1" }),
      advisory({ avg_name: "AVG-3" }),
    ]);
    render(<AdvisoryPopover partition={partition} />);
    expect(screen.getByText(/Critical/)).toBeInTheDocument();
    expect(screen.getByText(/\+2/)).toBeInTheDocument();
  });

  it("says No fix when nothing is actionable", () => {
    const partition = partitionAdvisories([advisory()]);
    render(<AdvisoryPopover partition={partition} />);
    expect(screen.getByText("No fix")).toBeInTheDocument();
  });
});

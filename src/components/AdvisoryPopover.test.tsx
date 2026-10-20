import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AdvisoryPopover } from "./AdvisoryPopover";
import { NO_FIX_CAVEAT, UNOFFERED_FIX_CAVEAT, partitionAdvisories } from "../security";
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
    fix_available: false,
    affected_version: "5.15.8.arch1-1",
    installed_version: "7.1.8.arch1-3",
    status: "Vulnerable",
    ...over,
  };
}

describe("AdvisoryPopover", () => {
  it("labels with the highest actionable severity and counts the rest", () => {
    const partition = partitionAdvisories([
      advisory({ avg_name: "AVG-1", severity: "Low", fixed_version: "1.1-1", fix_available: true }),
      advisory({ avg_name: "AVG-2", severity: "Critical", fixed_version: "1.2-1", fix_available: true }),
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

  it("distinguishes an unavailable fix from a missing tracker fix", async () => {
    render(<AdvisoryPopover partition={partitionAdvisories([
      advisory({ fixed_version: "8.0-1" }),
    ])} />);
    fireEvent.click(screen.getByText("Fix not offered"));
    expect(await screen.findByText("Fix not offered by the configured repositories")).toBeInTheDocument();
    expect(screen.getByText("fixed in 8.0-1, installed 7.1.8.arch1-3")).toBeInTheDocument();
    expect(screen.getByText(UNOFFERED_FIX_CAVEAT)).toBeInTheDocument();
    expect(screen.queryByText("No fix recorded")).not.toBeInTheDocument();
    expect(screen.queryByText(NO_FIX_CAVEAT)).not.toBeInTheDocument();
  });

  it("labels an available fix's severity ahead of an unoffered fix", () => {
    render(<AdvisoryPopover partition={partitionAdvisories([
      advisory({ avg_name: "AVG-1", severity: "Critical", fixed_version: "8.0-1" }),
      advisory({ avg_name: "AVG-2", severity: "Low", fixed_version: "8.1-1", fix_available: true }),
    ])} />);
    expect(screen.getByText(/Low/)).toBeInTheDocument();
    expect(screen.queryByText(/Critical/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fix not offered/)).not.toBeInTheDocument();
  });

  it("shows the tracker caveat only with records that lack a fixed version", async () => {
    render(<AdvisoryPopover partition={partitionAdvisories([
      advisory({ avg_name: "AVG-1", fixed_version: "8.0-1" }),
      advisory({ avg_name: "AVG-2" }),
    ])} />);
    fireEvent.click(screen.getByText(/Fix not offered/));
    expect(await screen.findByText("Fix not offered by the configured repositories")).toBeInTheDocument();
    expect(screen.getByText("No fix recorded")).toBeInTheDocument();
    expect(screen.getByText(NO_FIX_CAVEAT)).toBeInTheDocument();
  });
});

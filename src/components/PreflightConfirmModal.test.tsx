import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PreflightConfirmModal } from "./PreflightConfirmModal";
import type { PreflightResponse } from "../api";

afterEach(cleanup);

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
  return { onProceed, proceed: () => screen.getByRole("button", { name: /Proceed with Upgrade/ }) };
}

describe("PreflightConfirmModal", () => {
  it("blocks Proceed until removals are acknowledged", () => {
    const { proceed } = renderModal(preflight({ removals: ["orphan-pkg"] }));
    expect(proceed()).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /remov/i }));
    expect(proceed()).toBeEnabled();
  });

  it("blocks Proceed until every warning-severity warning is acknowledged", () => {
    const { proceed } = renderModal(
      preflight({
        warnings: [
          { id: "w1", severity: "warning", title: "Kernel", message: "reboot needed", packages: [] },
          { id: "w2", severity: "danger", title: "Firmware", message: "mismatch", packages: [] },
        ],
      })
    );
    expect(proceed()).toBeDisabled();

    const acks = screen.getAllByRole("checkbox");
    fireEvent.click(acks[0]);
    expect(proceed()).toBeDisabled();
    fireEvent.click(acks[1]);
    expect(proceed()).toBeEnabled();
  });

  it("does not demand acknowledgement for info-severity warnings", () => {
    const { proceed } = renderModal(
      preflight({
        warnings: [{ id: "i1", severity: "info", title: "FYI", message: "nothing scary", packages: [] }],
      })
    );
    expect(proceed()).toBeEnabled();
  });

  it("renders nothing while closed", () => {
    render(
      <PreflightConfirmModal isOpen={false} preflight={preflight()} onClose={vi.fn()} onProceed={vi.fn()} />
    );
    expect(screen.queryByRole("button", { name: /Proceed with Upgrade/ })).not.toBeInTheDocument();
  });
});

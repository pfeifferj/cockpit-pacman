import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatBox } from "./StatBox";

describe("StatBox", () => {
  it("renders a real button named with value and label when clickable", () => {
    const onClick = vi.fn();
    render(<StatBox value="12" label="Orphans" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "12 Orphans" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit accessible name when given", () => {
    render(<StatBox value="12" label="Orphans" onClick={() => {}} ariaLabel="12 orphans, view orphaned packages" />);
    expect(screen.getByRole("button", { name: "12 orphans, view orphaned packages" })).toBeInTheDocument();
  });

  it("exposes the description through aria-describedby", () => {
    render(<StatBox value="3" label="Orphans" onClick={() => {}} description="No longer required." />);
    expect(screen.getByRole("button", { name: "3 Orphans" })).toHaveAccessibleDescription("No longer required.");
  });

  it("reports the pressed state of a toggle box", () => {
    render(<StatBox value="2" label="Security" onClick={() => {}} isActive />);
    expect(screen.getByRole("button", { name: "2 Security" })).toHaveAttribute("aria-pressed", "true");
  });

  it("stays an inert, non-focusable box without onClick", () => {
    const { container } = render(<StatBox value="5" label="Total" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector("[tabindex]")).toBeNull();
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});

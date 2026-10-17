import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NetworkErrorState } from "./NetworkErrorState";
import { ARCH_STATUS_URL } from "../constants";

describe("NetworkErrorState", () => {
  afterEach(() => {
    cleanup();
  });

  it("names the resource and links the Arch status page", () => {
    render(<NetworkErrorState resource="mirror status" />);
    expect(
      screen.getByText(/Couldn't load mirror status/)
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Arch Linux status page" });
    expect(link).toHaveAttribute("href", ARCH_STATUS_URL);
  });

  it("wires retry and dismiss actions", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<NetworkErrorState onRetry={onRetry} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry without the click event and uses the given label", () => {
    const onRetry = vi.fn();
    render(<NetworkErrorState onRetry={onRetry} retryLabel="Retry sync" />);

    fireEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    expect(onRetry).toHaveBeenCalledWith();
  });

  it("omits the footer when no actions are given", () => {
    render(<NetworkErrorState />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { App } from "./App";
import { bundleVersion, mismatchedBackendVersion } from "../version";

vi.mock("../version", async () => {
  const actual = await vi.importActual<typeof import("../version")>("../version");
  return { ...actual, mismatchedBackendVersion: vi.fn() };
});

vi.mock("./HistoryView", () => ({
  HistoryView: () => <div>History view mounted</div>,
}));

const mockMismatch = vi.mocked(mismatchedBackendVersion);
const RELOAD_NOTICE = /Reload to finish updating this page/i;

describe("App version notice", () => {
  beforeEach(() => mockMismatch.mockReset());
  afterEach(() => cleanup());

  it("tells the user to reload when the backend has moved on beneath the bundle", async () => {
    mockMismatch.mockResolvedValue("99.0.0");
    render(<App />);

    await waitFor(() => expect(screen.getByText(RELOAD_NOTICE)).toBeInTheDocument());
    const escapedBundleVersion = bundleVersion!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(screen.getByText(new RegExp(`version ${escapedBundleVersion}`, "i"))).toBeInTheDocument();
    expect(screen.getByText(/version 99\.0\.0/i)).toBeInTheDocument();
  });

  it("says nothing when the versions agree", async () => {
    mockMismatch.mockResolvedValue(null);
    render(<App />);

    await waitFor(() => expect(mockMismatch).toHaveBeenCalled());
    expect(screen.queryByText(RELOAD_NOTICE)).not.toBeInTheDocument();
  });
});


describe("App tabs", () => {
  afterEach(() => cleanup());

  it("mounts a hidden view on first selection and retains it when switching tabs", () => {
    mockMismatch.mockResolvedValue(null);
    render(<App />);
    expect(screen.queryByText("History view mounted")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByText("History view mounted")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
    expect(screen.getByText("History view mounted")).toBeInTheDocument();
    expect(screen.getByText("History view mounted")).not.toBeVisible();
  });
});

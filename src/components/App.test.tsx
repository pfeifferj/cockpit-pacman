import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { App } from "./App";
import { bundleVersion, mismatchedBackendVersion } from "../version";

vi.mock("../version", async () => {
  const actual = await vi.importActual<typeof import("../version")>("../version");
  return { ...actual, mismatchedBackendVersion: vi.fn() };
});

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

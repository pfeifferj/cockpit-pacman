import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { mockLocationGo, resetMockLocation, setMockLocation } from "../test/setup";
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

describe("App routing", () => {
  beforeEach(() => mockMismatch.mockResolvedValue(null));

  const tab = (name: string) => screen.getByRole("tab", { name });

  it("follows locationchanged and moves focus to the new panel", async () => {
    render(<App />);
    expect(tab("Updates")).toHaveAttribute("aria-selected", "true");
    act(() => setMockLocation(["keyring"]));
    await waitFor(() => expect(tab("Keyring")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tabpanel", { name: "Keyring" })).toHaveFocus();
  });

  it("treats an unknown tab as Updates", () => {
    resetMockLocation(["nonsense"]);
    render(<App />);
    expect(tab("Updates")).toHaveAttribute("aria-selected", "true");
  });

  it("a tab click navigates with go and leaves focus on the tab", async () => {
    render(<App />);
    tab("Mirrors").focus();
    fireEvent.click(tab("Mirrors"));
    expect(mockLocationGo).toHaveBeenCalledWith(["mirrors"]);
    await waitFor(() => expect(tab("Mirrors")).toHaveAttribute("aria-selected", "true"));
    expect(tab("Mirrors")).toHaveFocus();
  });

  it("returning to a tab by click keeps its options", async () => {
    resetMockLocation(["history"], { q: "linux" });
    render(<App />);
    fireEvent.click(tab("Cache"));
    await waitFor(() => expect(tab("Cache")).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(tab("History"));
    expect(mockLocationGo).toHaveBeenLastCalledWith(["history"], { q: "linux" });
  });

});

describe("App package jump and shortcuts", () => {
  beforeEach(() => mockMismatch.mockResolvedValue(null));

  const jump = () => screen.getByRole("textbox", { name: "Go to package or tab" });

  it("renders the jump field on every tab", async () => {
    render(<App />);
    const tabs = [screen.getByRole("tab", { name: "Updates" }), screen.getByRole("tab", { name: "History" })];
    expect(tabs.length).toBeGreaterThan(1);
    for (const tab of tabs) {
      fireEvent.click(tab);
      await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
      expect(screen.getAllByRole("textbox", { name: "Go to package or tab" })).toHaveLength(1);
    }
  });

  it("'/' focuses the jump from the page but not from inside another field", async () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(jump()).toHaveFocus();

    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    const notPrevented = fireEvent.keyDown(other, { key: "/" });
    expect(notPrevented).toBe(true);
    expect(other).toHaveFocus();
    other.remove();
  });

  it("Ctrl+/ does not move focus", () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    expect(jump()).not.toHaveFocus();
  });

  it("'?' opens the shortcut help", async () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

});

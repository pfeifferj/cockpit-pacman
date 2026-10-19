import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { KeyringView } from "./KeyringView";
import * as api from "../api";
import { mockPermission, mockSpawn } from "../test/setup";
import { createMockStreamingProcess } from "../test/mocks";
import { sweepA11y } from "../test/a11ySweep";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";

const systemChange = vi.hoisted(() => {
  const listeners = new Set<{ listener: (kind: "system" | "sync") => void; kinds: ("system" | "sync")[] }>();
  return {
    listeners,
    subscribe: (listener: (kind: "system" | "sync") => void, kinds: ("system" | "sync")[] = ["system", "sync"]) => {
      const entry = { listener, kinds };
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
  };
});

function emitSystemChange(kind: "system" | "sync") {
  for (const { listener, kinds } of [...systemChange.listeners]) {
    if (kinds.includes(kind)) listener(kind);
  }
}

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getKeyringStatus: vi.fn(),
    onSystemChanged: systemChange.subscribe,
    refreshKeyring: vi.fn(),
    initKeyring: vi.fn(),
    previewInstall: vi.fn(),
    installPackage: vi.fn(),
    receiveKey: vi.fn(),
    lsignKey: vi.fn(),
  };
});

const mockGetKeyringStatus = vi.mocked(api.getKeyringStatus);
const mockRefreshKeyring = vi.mocked(api.refreshKeyring);
const mockInitKeyring = vi.mocked(api.initKeyring);
const mockPreviewInstall = vi.mocked(api.previewInstall);
const mockInstallPackage = vi.mocked(api.installPackage);
const mockReceiveKey = vi.mocked(api.receiveKey);
const mockLsignKey = vi.mocked(api.lsignKey);

const keyringPreview: api.TransactionPreview = {
  success: true,
  add: [{ name: "archlinux-keyring", version: "20260901-1", repo: "core", download_size: 1, installed_size: 1, old_version: "20250101-1", reason: "target" }],
  remove: [],
  conflicts: [],
  replacements: [],
  providers: [],
  import_keys: [],
  warnings: [],
  blocked_by: [],
  total_download_size: 1,
  net_installed_size: 0,
};

function alertOf(title: string): HTMLElement {
  return screen.getByRole("heading", { name: new RegExp(title) }).closest(".pf-v6-c-alert") as HTMLElement;
}

const mockKeyringResponse: api.KeyringStatusResponse = {
  keys: [
    {
      fingerprint: "ABCD1234EFGH5678IJKL9012MNOP3456QRST7890",
      uid: "Arch Linux Master Key <master@archlinux.org>",
      created: "2020-01-15",
      expires: null,
      trust: "ultimate",
    },
    {
      fingerprint: "1234ABCD5678EFGH9012IJKL3456MNOP7890QRST",
      uid: "Test Packager <test@archlinux.org>",
      created: "2021-06-20",
      expires: "2025-06-20",
      trust: "full",
    },
    {
      fingerprint: "5678IJKL9012MNOP3456QRST7890ABCD1234EFGH",
      uid: "Another Packager <another@archlinux.org>",
      created: "2022-03-10",
      expires: null,
      trust: "marginal",
    },
  ],
  total: 3,
  master_key_initialized: true,
  status: "ready",
  warnings: [],
};

const mockUninitializedKeyring: api.KeyringStatusResponse = {
  keys: [],
  total: 0,
  master_key_initialized: false,
  status: "uninitialized",
  warnings: ["Keyring not initialized"],
};

describe("KeyringView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetKeyringStatus.mockResolvedValue(mockKeyringResponse);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders loading spinner initially", async () => {
    mockGetKeyringStatus.mockImplementation(() => new Promise(() => {}));
    render(<KeyringView />);
    expect(screen.getByText(/Loading keyring status/i)).toBeInTheDocument();
  });

  it("renders key list after loading", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText(/3 keys in keyring/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Arch Linux Master Key <master@archlinux.org>")).toBeInTheDocument();
    expect(screen.getByText("Test Packager <test@archlinux.org>")).toBeInTheDocument();
    sweepA11y();
  });

  it("wraps fingerprints in 4-character blocks while a copied selection stays the raw 40-hex value", async () => {
    const hex = "4AA4767BBC9C4B1D18AE28B77F2D434B9741E8AC";
    mockGetKeyringStatus.mockResolvedValue({
      ...mockKeyringResponse,
      keys: [{ ...mockKeyringResponse.keys[0], fingerprint: hex }],
      total: 1,
    });
    render(<KeyringView />);

    const cell = (await screen.findByText("4AA4")).closest("code")!;
    expect(cell.style.overflowWrap).toBe("anywhere");
    expect(Array.from(cell.querySelectorAll("span"), (s) => s.textContent)).toEqual(hex.match(/.{4}/g));
    expect(cell.querySelectorAll("wbr")).toHaveLength(9);
    expect(cell.textContent).toBe(hex);

    const range = document.createRange();
    range.selectNodeContents(cell);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(hex);
    expect(selection.toString()).toMatch(/^[0-9A-F]{40}$/);
  });

  it("offers trust and refresh help as named buttons that do not sort", async () => {
    render(<KeyringView />);
    await waitFor(() => {
      expect(screen.getByText(/3 keys in keyring/i)).toBeInTheDocument();
    });

    expect(screen.getAllByRole("button", { name: /^More information about/ })).toHaveLength(2);
    const trustHeader = screen.getByRole("columnheader", { name: /Trust/ });
    const before = trustHeader.getAttribute("aria-sort");
    fireEvent.click(screen.getByRole("button", { name: "More information about trust levels" }));
    expect(await screen.findByText(/Marginal trust: Signatures from this key are partially trusted/)).toBeInTheDocument();
    expect(trustHeader.getAttribute("aria-sort")).toBe(before);
  });

  it("shows a load failure with its cause and announces it", async () => {
    mockGetKeyringStatus.mockRejectedValue(new Error("gpg exited with status 2"));

    render(<AnnouncerProvider><KeyringView /></AnnouncerProvider>);

    const heading = await screen.findByRole("heading", { name: "Could not load keyring status" });
    expect(heading.closest(".pf-v6-c-empty-state")).toHaveTextContent("gpg exited with status 2");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not load keyring status"));
  });

  it("shows retry button on error", async () => {
    mockGetKeyringStatus.mockRejectedValue(new Error("Network error"));

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });
  });

  it("renders table with correct headers", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText(/3 keys in keyring/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Fingerprint")).toBeInTheDocument();
    expect(screen.getByText("User ID")).toBeInTheDocument();
    expect(screen.getByText("Trust")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("Expires")).toBeInTheDocument();
  });

  it("displays trust level labels with colors", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText("ultimate")).toBeInTheDocument();
    });

    expect(screen.getByText("full")).toBeInTheDocument();
    expect(screen.getByText("marginal")).toBeInTheDocument();
  });

  it("filters keys by search input", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText("Arch Linux Master Key <master@archlinux.org>")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Filter keys/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "Test Packager" } });
    });

    await waitFor(() => {
      expect(screen.queryByText("Arch Linux Master Key <master@archlinux.org>")).not.toBeInTheDocument();
    });

    expect(screen.getByText("Test Packager <test@archlinux.org>")).toBeInTheDocument();
  });

  it("shows filtered count when filtering", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText(/3 keys in keyring/i)).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Filter keys/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "Test" } });
    });

    await waitFor(() => {
      expect(screen.getByText(/1 shown/i)).toBeInTheDocument();
    });
  });

  it("clears search when clicking clear button", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText("Arch Linux Master Key <master@archlinux.org>")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Filter keys/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "Test" } });
    });

    await waitFor(() => {
      expect(screen.queryByText("Arch Linux Master Key <master@archlinux.org>")).not.toBeInTheDocument();
    });

    const clearButton = screen.getByLabelText(/Reset/i);
    await act(async () => {
      fireEvent.click(clearButton);
    });

    await waitFor(() => {
      expect(screen.getByText("Arch Linux Master Key <master@archlinux.org>")).toBeInTheDocument();
    });
  });

  it("shows refresh keys button", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Refresh$/i })).toBeInTheDocument();
    });
  });

  it("starts refresh when clicking Refresh", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRefreshKeyring.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Refresh$/i })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /^Refresh$/i });
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    expect(mockRefreshKeyring).toHaveBeenCalled();

    expect(screen.getByText(/keyserver/i)).toBeInTheDocument();

    await act(async () => {
      capturedCallbacks?.onComplete();
    });

    await waitFor(() => {
      expect(mockGetKeyringStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("shows error on refresh failure", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRefreshKeyring.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Refresh$/i })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /^Refresh$/i });
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    await act(async () => {
      capturedCallbacks?.onData?.("gpg: refreshing 3 keys\n");
      capturedCallbacks?.onError("Failed to refresh keys");
    });

    expect(screen.getByText("Key refresh failed")).toBeInTheDocument();
    expect(screen.queryByText(/Error loading keyring status/i)).not.toBeInTheDocument();
    expect(screen.getByRole("log")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(mockRefreshKeyring).toHaveBeenCalledTimes(2);
    expect(mockGetKeyringStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure screen when a late system change arrives", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRefreshKeyring.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<KeyringView />);
    await screen.findByRole("button", { name: /^Refresh$/i });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Refresh$/i }));
    });
    await act(async () => {
      capturedCallbacks?.onError("Failed to refresh keys");
    });
    await act(async () => {
      emitSystemChange("system");
    });

    expect(screen.getByText("Key refresh failed")).toBeInTheDocument();
  });

  it.each([
    ["refresh", "network_error"],
    ["refresh", "internal_error"],
    ["initialize", "network_error"],
    ["initialize", "internal_error"],
  ] as const)("gates %s retry after %s when administrative access changes", async (operation, code) => {
    let onChanged: (() => void) | undefined;
    const permission = {
      allowed: true,
      addEventListener: vi.fn((_: string, callback: () => void) => { onChanged = callback; }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
    mockPermission.mockReturnValueOnce(permission);
    const isRefresh = operation === "refresh";
    if (!isRefresh) mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);
    const start = isRefresh ? mockRefreshKeyring : mockInitKeyring;
    let callbacks!: api.UpgradeCallbacks;
    start.mockImplementation((next) => {
      callbacks = next;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<KeyringView />);
    fireEvent.click(await screen.findByRole("button", { name: isRefresh ? "Refresh" : "Initialize keyring" }));
    act(() => { callbacks.onError("Key operation failed", code); });
    const retry = await screen.findByRole("button", { name: "Try again" });

    permission.allowed = false;
    act(() => { onChanged?.(); });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    act(() => {
      fireEvent.click(retry);
      retry.focus();
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      `Turn on administrative access to ${isRefresh ? "refresh the keys" : "initialize the keyring"}`,
    );
    expect(document.activeElement).toBe(retry);

    permission.allowed = true;
    await act(async () => { onChanged?.(); });
    expect(retry).not.toHaveAttribute("aria-disabled");
    fireEvent.click(retry);
    expect(start).toHaveBeenCalledTimes(2);
  });

  async function startRefresh() {
    let callbacks: api.UpgradeCallbacks | null = null;
    const cancel = vi.fn();
    const forceStop = vi.fn();
    mockRefreshKeyring.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel, forceStop };
    });
    render(<AnnouncerProvider><KeyringView /></AnnouncerProvider>);
    const refresh = await screen.findByRole("button", { name: /^Refresh$/i });
    await act(async () => {
      fireEvent.click(refresh);
    });
    return { callbacks: () => callbacks!, cancel, forceStop };
  }

  async function confirmStop(confirm: string) {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: confirm }));
    });
  }

  it("asks before stopping a refresh and sends nothing until confirmed", async () => {
    const { cancel, forceStop } = await startRefresh();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(screen.getByText("Stop refreshing keys?")).toBeInTheDocument();
    expect(screen.getByText("Keys already refreshed stay refreshed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep running" })).toHaveFocus();
    expect(cancel).not.toHaveBeenCalled();
    expect(forceStop).not.toHaveBeenCalled();
    sweepA11y();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    });
    expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("stops a refresh gracefully and keeps the log beside the backend's summary", async () => {
    const { callbacks, cancel, forceStop } = await startRefresh();
    await act(async () => {
      callbacks().onData?.("Refreshing key: ABCD1234\n");
    });
    await confirmStop("Stop refreshing");

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(forceStop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Stopping…/ })).toHaveFocus();

    await act(async () => {
      callbacks().onError("Stopped at key 37 of 112", "cancelled");
    });

    expect(screen.getByRole("heading", { name: "Key refresh stopped" })).toBeInTheDocument();
    expect(screen.getByText("Stopped at key 37 of 112")).toBeInTheDocument();
    expect(screen.queryByText("Key refresh failed")).not.toBeInTheDocument();
    expect(within(screen.getByRole("log")).getByText(/ABCD1234/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to keyring" }));
    });
    expect(await screen.findByText(/3 keys in keyring/i)).toBeInTheDocument();
  });

  it("asks with initialization copy and stops an init gracefully", async () => {
    mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);
    let callbacks: api.UpgradeCallbacks | null = null;
    const cancel = vi.fn();
    mockInitKeyring.mockImplementation((cb) => {
      callbacks = cb;
      return { cancel, forceStop: vi.fn() };
    });
    render(<KeyringView />);
    const init = await screen.findByRole("button", { name: "Initialize keyring" });
    await act(async () => {
      fireEvent.click(init);
    });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(screen.getByText("Stop initializing the keyring?")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop initializing" }));
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    await act(async () => {
      callbacks!.onError("Operation cancelled by user", "cancelled");
    });
    expect(screen.getByRole("heading", { name: "Keyring initialization stopped" })).toBeInTheDocument();
  });

  it("waits for cancellation to finish after the stall timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { callbacks, forceStop } = await startRefresh();
      await confirmStop("Stop refreshing");
      await act(async () => { vi.advanceTimersByTime(20_000); });
      expect(screen.queryByRole("button", { name: "Force stop" })).not.toBeInTheDocument();
      expect(forceStop).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { name: "Key refresh stopped" })).not.toBeInTheDocument();
      await act(async () => { callbacks().onError("cancelled", "cancelled"); });
      expect(screen.getByRole("heading", { name: "Key refresh stopped" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts refreshed keys in the progress bar once the total is known", async () => {
    const { callbacks } = await startRefresh();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await act(async () => {
      callbacks().onEvent?.({ type: "event", event: "Refreshing key", package: "ABCD", current: 37, total: 112 });
    });
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuetext", "Key 37 of 112");
    expect(bar).toHaveAttribute("aria-valuenow", "33");
    sweepA11y();
  });

  it("disables Refresh for a session without admin access", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });

    render(<KeyringView />);

    const button = await screen.findByRole("button", { name: /^Refresh$/i });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(mockRefreshKeyring).not.toHaveBeenCalled();
  });

  it("disables Refresh and Initialize while an upgrade runs", async () => {
    const upgrade = createMockStreamingProcess();
    mockSpawn.mockReturnValueOnce(upgrade);
    act(() => {
      api.runUpgrade({ onComplete: vi.fn(), onError: vi.fn() });
    });

    render(<KeyringView />);
    const refresh = await screen.findByRole("button", { name: /^Refresh$/i });
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      fireEvent.click(refresh);
      refresh.focus();
    });
    expect(mockRefreshKeyring).not.toHaveBeenCalled();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("An upgrade is running.");

    cleanup();
    mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);
    render(<KeyringView />);
    expect(await screen.findByRole("button", { name: /Initialize keyring/ })).toHaveAttribute("aria-disabled", "true");

    act(() => {
      upgrade._emit(JSON.stringify({ type: "complete", success: true }) + "\n");
    });
    expect(screen.getByRole("button", { name: /Initialize keyring/ })).toHaveAttribute("aria-disabled", "true");
    act(() => upgrade._complete());
    expect(screen.getByRole("button", { name: /Initialize keyring/ })).not.toHaveAttribute("aria-disabled");
  });

  it("disables Refresh while administrative access is still being checked", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });

    render(<KeyringView />);
    const refresh = await screen.findByRole("button", { name: /^Refresh$/i });
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      refresh.focus();
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Checking administrative access…");
  });

  it("explains the admin need when the keyring is undetermined without access", async () => {
    let onChanged: (() => void) | undefined;
    const permission = {
      allowed: false as boolean | null,
      addEventListener: vi.fn((_: string, cb: () => void) => { onChanged = cb; }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    };
    mockPermission.mockReturnValueOnce(permission);
    mockGetKeyringStatus.mockResolvedValueOnce({
      keys: [],
      total: 0,
      master_key_initialized: false,
      status: "undetermined",
      warnings: ["permission denied"],
    });

    render(<KeyringView />);

    expect(await screen.findByText(/needs administrative access/i)).toHaveTextContent(
      "Use the Limited access button in Cockpit's top bar.",
    );
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();

    permission.allowed = true;
    await act(async () => {
      onChanged?.();
    });

    expect(await screen.findByText(/3 keys in keyring/i)).toBeInTheDocument();
    expect(mockGetKeyringStatus).toHaveBeenCalledTimes(2);
  });

  it("reloads once when the system changes while active", async () => {
    render(<KeyringView />);
    await screen.findByText(/3 keys in keyring/i);

    await act(async () => {
      emitSystemChange("system");
    });

    expect(mockGetKeyringStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/3 keys in keyring/i)).toBeInTheDocument();
  });

  it("groups thousands in the keyring total", async () => {
    mockGetKeyringStatus.mockResolvedValue({ ...mockKeyringResponse, total: 1000 });
    render(<KeyringView />);
    expect(await screen.findByText("1,000 keys in keyring (3 shown)")).toBeInTheDocument();
  });

  it("does not offer to initialize a keyring it could not read", async () => {
    mockGetKeyringStatus.mockResolvedValue({
      keys: [],
      total: 0,
      master_key_initialized: false,
      status: "undetermined",
      warnings: ["Failed to check keyring status: permission denied (requires root)"],
    });

    render(<KeyringView />);

    expect(
      await screen.findByText(/Keyring state could not be determined/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Initialize keyring/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Keyring not initialized/i)).not.toBeInTheDocument();
  });

  it("disables initialization for a session without admin access", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });
    mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);

    render(<KeyringView />);

    const button = await screen.findByRole("button", { name: /Initialize keyring/ });
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("ignores clicks on the disabled initialize button", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });
    mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);

    render(<KeyringView />);

    const button = await screen.findByRole("button", { name: /Initialize keyring/ });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockInitKeyring).not.toHaveBeenCalled();
  });

  it("shows initialize keyring for uninitialized keyring", async () => {
    mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Initialize keyring/ })).toBeInTheDocument();
    });

    const headings = screen.getAllByText(/Keyring not initialized/i);
    expect(headings.length).toBeGreaterThan(0);
  });

  it("starts initialization when clicking Initialize keyring", async () => {
    mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);

    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockInitKeyring.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Initialize keyring/ })).toBeInTheDocument();
    });

    const initButton = screen.getByRole("button", { name: /Initialize keyring/ });
    await act(async () => {
      fireEvent.click(initButton);
    });

    expect(mockInitKeyring).toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText(/Initializing Keyring/i)).toBeInTheDocument();
    });

    mockGetKeyringStatus.mockResolvedValue(mockKeyringResponse);

    await act(async () => {
      capturedCallbacks?.onComplete();
    });

    await waitFor(() => {
      expect(screen.getByText(/3 keys in keyring/i)).toBeInTheDocument();
    });
  });

  it("displays warnings when present", async () => {
    mockGetKeyringStatus.mockResolvedValue({
      ...mockKeyringResponse,
      warnings: ["Some keys are expired"],
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText("Some keys are expired")).toBeInTheDocument();
    });
  });

  it("renders several warnings under one title", async () => {
    mockGetKeyringStatus.mockResolvedValue({
      ...mockKeyringResponse,
      warnings: ["Some keys are expired", "The trust database is stale"],
    });

    render(<KeyringView />);

    const heading = await screen.findByRole("heading", { name: /Keyring warnings/ });
    const alert = heading.closest(".pf-v6-c-alert") as HTMLElement;
    expect(screen.getAllByRole("heading", { name: /Keyring warning/ })).toHaveLength(1);
    expect(alert).toHaveTextContent("Some keys are expired");
    expect(alert).toHaveTextContent("The trust database is stale");
  });

  it("shows empty state when no keys match filter", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText("Arch Linux Master Key <master@archlinux.org>")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Filter keys/i);
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "nonexistent" } });
    });

    await waitFor(() => {
      expect(screen.getByText(/No keys found/i)).toBeInTheDocument();
    });
  });

  it("handles pagination", async () => {
    const manyKeys = Array.from({ length: 75 }, (_, i) => ({
      fingerprint: `FINGERPRINT${i.toString().padStart(4, "0")}`,
      uid: `User ${i} <user${i}@example.com>`,
      created: "2023-01-01",
      expires: null,
      trust: "full",
    }));

    mockGetKeyringStatus.mockResolvedValue({
      keys: manyKeys,
      total: 75,
      master_key_initialized: true,
      status: "ready",
      warnings: [],
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText(/75 keys in keyring/i)).toBeInTheDocument();
    });

    const user0 = screen.queryByText("User 0 <user0@example.com>");
    expect(user0).toBeInTheDocument();
  });

  it("sorts keys by fingerprint when clicking header", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText("Arch Linux Master Key <master@archlinux.org>")).toBeInTheDocument();
    });

    const fingerprintHeader = screen.getByText("Fingerprint");
    await act(async () => {
      fireEvent.click(fingerprintHeader);
    });

    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(1);
  });

  it("sorts keys by trust when clicking header", async () => {
    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText("Arch Linux Master Key <master@archlinux.org>")).toBeInTheDocument();
    });

    const trustHeader = screen.getByText("Trust");
    await act(async () => {
      fireEvent.click(trustHeader);
    });

    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(1);
  });

  it("shows streaming progress during refresh", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRefreshKeyring.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn(), forceStop: vi.fn() };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Refresh$/i })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /^Refresh$/i });
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    await act(async () => {
      capturedCallbacks?.onData?.("Refreshing key ABCD1234...\n");
    });

    expect(screen.getByText(/Refreshing keys from keyserver/i)).toBeInTheDocument();
  });

  describe("filter miss", () => {
    it("offers Clear filter, which restores the list and focuses the input", async () => {
      render(<KeyringView />);
      await waitFor(() => {
        expect(screen.getByText(/3 keys in keyring/i)).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/Filter keys/i);
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: "no-such-key" } });
      });

      const clear = screen.getByRole("button", { name: "Clear filter" });
      await act(async () => {
        fireEvent.click(clear);
      });

      expect(screen.getByText("Arch Linux Master Key <master@archlinux.org>")).toBeInTheDocument();
      expect(screen.getByText("Test Packager <test@archlinux.org>")).toBeInTheDocument();
      expect(searchInput).toHaveValue("");
      expect(document.activeElement).toBe(searchInput);
    });
  });

  describe("signature failure arrival", () => {
    it("offers the remedies and the way back to the failed upgrade", async () => {
      const retry = vi.fn();
      const onRetryFailed = vi.fn();
      const { rerender } = render(
        <KeyringView signatureFailure={{ origin: "upgrade", retry }} onRetryFailed={onRetryFailed} />
      );
      expect(await screen.findByText(/A package signature could not be verified\./)).toBeInTheDocument();
      expect(alertOf("Upgrade blocked by an untrusted signature")).toHaveClass("pf-m-danger");
      expect(screen.getByRole("button", { name: "Update archlinux-keyring" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh keys" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Retry upgrade" }));
      expect(onRetryFailed).toHaveBeenCalledTimes(1);

      rerender(<KeyringView signatureFailure={null} onRetryFailed={onRetryFailed} />);
      expect(screen.queryByText(/blocked by an untrusted signature/)).not.toBeInTheDocument();
    });

    it("previews an archlinux-keyring update in a dialog", async () => {
      mockPreviewInstall.mockReturnValue(new Promise(() => {}));
      render(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn() }} />);
      fireEvent.click(await screen.findByRole("button", { name: "Update archlinux-keyring" }));
      expect(await screen.findByRole("dialog", { name: "Install archlinux-keyring" })).toBeInTheDocument();
      await waitFor(() => expect(mockPreviewInstall).toHaveBeenCalledWith("archlinux-keyring"));
    });

    it("retries a closed install from its preview in place", async () => {
      mockPreviewInstall.mockReturnValue(new Promise(() => {}));
      const onRetryFailed = vi.fn();
      render(<KeyringView signatureFailure={{ origin: "install", target: "vim" }} onRetryFailed={onRetryFailed} />);
      expect(await screen.findByText(/The install of vim stopped because a package signature could not be verified\./)).toBeInTheDocument();
      expect(alertOf("Install blocked by an untrusted signature")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Retry install" }));
      expect(await screen.findByRole("dialog", { name: "Install vim" })).toBeInTheDocument();
      await waitFor(() => expect(mockPreviewInstall).toHaveBeenCalledWith("vim"));
      expect(onRetryFailed).not.toHaveBeenCalled();
    });

    it("dismisses through the close button", async () => {
      const onDismissFailure = vi.fn();
      render(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn() }} onDismissFailure={onDismissFailure} />);
      await screen.findByText(/a package signature could not be verified/i);
      fireEvent.click(screen.getByRole("button", { name: /^Close Danger alert/ }));
      expect(onDismissFailure).toHaveBeenCalledTimes(1);
    });

    it("gates the remedies without administrative access", async () => {
      mockPermission.mockReturnValueOnce({ allowed: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() });
      render(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn() }} />);
      await screen.findByText(/a package signature could not be verified/i);
      for (const name of ["Update archlinux-keyring", "Refresh keys", "Retry upgrade"]) {
        expect(screen.getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
      }
    });

    it("labels the retry with the number of packages it upgrades", async () => {
      render(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn(), count: 12 }} />);
      expect(await screen.findByRole("button", { name: "Retry upgrade (12 packages)" })).toBeInTheDocument();
    });

    it.each([
      [1, "Retry upgrade (1 package)"],
      [1000, "Retry upgrade (1,000 packages)"],
    ])("formats a retry count of %i", async (count, name) => {
      render(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn(), count }} />);
      expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    });

    it("recovers in 4 interventions: Open Keyring, Update archlinux-keyring, confirm, Retry", async () => {
      mockPreviewInstall.mockResolvedValue(keyringPreview);
      let install: api.UpgradeCallbacks | null = null;
      mockInstallPackage.mockImplementation((callbacks) => {
        install = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      const onRetryFailed = vi.fn();
      render(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn(), count: 12 }} onRetryFailed={onRetryFailed} />);

      fireEvent.click(await screen.findByRole("button", { name: "Update archlinux-keyring" }));
      fireEvent.click(await screen.findByRole("button", { name: /^Install archlinux-keyring/ }));
      expect(mockInstallPackage).toHaveBeenCalledTimes(1);
      await act(async () => {
        install?.onComplete();
      });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const alert = alertOf("Upgrade blocked by an untrusted signature");
      expect(alert).toHaveClass("pf-m-warning");
      expect(screen.getByRole("list", { name: "Completed steps" })).toHaveTextContent("archlinux-keyring updated");
      expect(screen.getByText("Keyring updated. Retry the upgrade.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Update archlinux-keyring" })).not.toBeInTheDocument();
      const retry = screen.getByRole("button", { name: "Retry upgrade (12 packages)" });
      expect(retry).toHaveClass("pf-m-primary");
      await waitFor(() => expect(retry).toHaveFocus());
      expect(screen.getAllByRole("button", { name: /^Retry upgrade/ })).toHaveLength(1);

      fireEvent.click(retry);
      expect(onRetryFailed).toHaveBeenCalledTimes(1);
    });

    it("marks a key refresh as done and promotes the retry", async () => {
      let refresh: api.UpgradeCallbacks | null = null;
      mockRefreshKeyring.mockImplementation((callbacks) => {
        refresh = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      render(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn() }} />);

      fireEvent.click(await screen.findByRole("button", { name: "Refresh keys" }));
      await act(async () => {
        refresh?.onComplete();
      });

      expect(await screen.findByRole("list", { name: "Completed steps" })).toHaveTextContent("Keys refreshed");
      expect(alertOf("Upgrade blocked by an untrusted signature")).toHaveClass("pf-m-warning");
      expect(screen.queryByRole("button", { name: "Refresh keys" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Update archlinux-keyring" })).toBeInTheDocument();
      const retry = screen.getByRole("button", { name: "Retry upgrade" });
      expect(retry).toHaveClass("pf-m-primary");
      await waitFor(() => expect(retry).toHaveFocus());
    });

    it("starts a new failure with no completed steps", async () => {
      let refresh: api.UpgradeCallbacks | null = null;
      mockRefreshKeyring.mockImplementation((callbacks) => {
        refresh = callbacks;
        return { cancel: vi.fn(), forceStop: vi.fn() };
      });
      const { rerender } = render(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn() }} />);
      fireEvent.click(await screen.findByRole("button", { name: "Refresh keys" }));
      await act(async () => {
        refresh?.onComplete();
      });
      await screen.findByRole("list", { name: "Completed steps" });

      rerender(<KeyringView signatureFailure={{ origin: "upgrade", retry: vi.fn() }} />);
      expect(screen.queryByRole("list", { name: "Completed steps" })).not.toBeInTheDocument();
      expect(alertOf("Upgrade blocked by an untrusted signature")).toHaveClass("pf-m-danger");
    });
  });

  describe("add key", () => {
    const FPR = "3B94A80E50A477C7C8E44F8A0FA8E1BCB1F1A2C0";
    const fetchedKey: api.KeyringKey = {
      fingerprint: FPR,
      uid: "Jane Doe <jane@example.org>",
      created: "2024-01-01",
      expires: null,
      trust: "unknown",
    };

    const openAddKey = async () => {
      render(<KeyringView />);
      fireEvent.click(await screen.findByRole("button", { name: "Add key" }));
      return screen.getByRole("dialog", { name: "Add key" });
    };

    it("receives, shows the key, and signs only after the named confirm", async () => {
      mockReceiveKey.mockResolvedValue({ key: fetchedKey });
      mockLsignKey.mockResolvedValue({ key: { ...fetchedKey, trust: "full" } });
      await openAddKey();
      const input = screen.getByRole("textbox", { name: "Key fingerprint" });
      expect(input).toHaveFocus();

      fireEvent.change(input, { target: { value: "3b94 a80e 50a4 77c7 c8e4 4f8a 0fa8 e1bc b1f1 a2c0" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
      });

      expect(mockReceiveKey).toHaveBeenCalledWith(FPR, undefined, expect.any(AbortSignal));
      const fetched = screen.getByRole("group", { name: "Fetched key" });
      expect(fetched).toHaveTextContent("Jane Doe <jane@example.org>");
      expect(fetched).toHaveTextContent("3B94 A80E 50A4 77C7 C8E4 4F8A 0FA8 E1BC B1F1 A2C0");
      expect(fetched).toHaveTextContent("unknown");
      expect(screen.getByText(/accepts any package it signs/)).toBeInTheDocument();
      expect(mockLsignKey).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Locally sign key for Jane Doe <jane@example.org>" }));
      });

      expect(mockLsignKey).toHaveBeenCalledWith(FPR, expect.any(AbortSignal));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Locally signed key for Jane Doe/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add key" })).toHaveFocus();
      await waitFor(() => expect(mockGetKeyringStatus).toHaveBeenCalledTimes(2));
    });

    const fill = (value = FPR) =>
      fireEvent.change(screen.getByRole("textbox", { name: "Key fingerprint" }), { target: { value } });

    it("shows the keyserver and elapsed time and refuses to close while fetching", async () => {
      let resolve!: (value: api.KeyActionResponse) => void;
      mockReceiveKey.mockImplementation(() => new Promise((r) => { resolve = r; }));
      render(<AnnouncerProvider><KeyringView /></AnnouncerProvider>);
      fireEvent.click(await screen.findByRole("button", { name: "Add key" }));
      fill();
      fireEvent.click(screen.getByRole("button", { name: "Keyserver" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Keyserver (optional)" }), { target: { value: "hkps://keys.example.org" } });

      vi.useFakeTimers();
      try {
        fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
        expect(mockReceiveKey).toHaveBeenCalledWith(FPR, "hkps://keys.example.org", expect.any(AbortSignal));
        act(() => { vi.advanceTimersByTime(3000); });
        expect(screen.getByText(/Fetching the key from hkps:\/\/keys\.example\.org: 3 s/)).toBeInTheDocument();

        sweepA11y({ dialogs: ["Add key"] });
        const dialog = screen.getByRole("dialog", { name: "Add key" });
        for (const name of ["Close", "Cancel"]) {
          const button = within(dialog).getByRole("button", { name });
          expect(button).toHaveAttribute("aria-disabled", "true");
          expect(button).toHaveAccessibleDescription("Fetching cannot be interrupted");
          fireEvent.click(button);
        }
        fireEvent.keyDown(document.body, { key: "Escape" });
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByRole("dialog", { name: "Add key" })).toBeInTheDocument();
        expect(document.querySelector('[role="status"][aria-live="polite"]')).toHaveTextContent("Fetching cannot be interrupted");
      } finally {
        vi.useRealTimers();
      }

      await act(async () => { resolve({ key: fetchedKey }); });
      const close = screen.getByRole("button", { name: "Close" });
      expect(close).not.toHaveAttribute("aria-disabled", "true");
    });

    it("refuses a malformed keyserver before fetching", async () => {
      await openAddKey();
      fill();
      fireEvent.click(screen.getByRole("button", { name: "Keyserver" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Keyserver (optional)" }), { target: { value: "keyserver.ubuntu.com" } });
      const fetch = screen.getByRole("button", { name: "Fetch" });
      expect(fetch).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(fetch);
      expect(mockReceiveKey).not.toHaveBeenCalled();
    });

    it("reports a fetched key left unsigned on close and marks its row", async () => {
      mockReceiveKey.mockResolvedValue({ key: fetchedKey });
      await openAddKey();
      mockGetKeyringStatus.mockResolvedValue({
        ...mockKeyringResponse,
        keys: [...mockKeyringResponse.keys, fetchedKey],
        total: 4,
      });
      fill();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockLsignKey).not.toHaveBeenCalled();
      const alert = alertOf("Key for Jane Doe <jane@example.org> was added to the keyring but not trusted");
      expect(alert).toHaveClass("pf-m-info");
      expect(within(alert).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
      const row = (await screen.findByText("Jane Doe <jane@example.org>")).closest("tr") as HTMLElement;
      expect(within(row).getByText("New")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add key" })).toHaveFocus();

      fireEvent.click(within(alert).getByRole("button", { name: /^Close/ }));
      expect(within(row).queryByText("New")).not.toBeInTheDocument();
    });

    it("says an already present key is still untrusted", async () => {
      const present = { ...fetchedKey, trust: "marginal" };
      mockGetKeyringStatus.mockResolvedValue({
        ...mockKeyringResponse,
        keys: [...mockKeyringResponse.keys, present],
        total: 4,
      });
      mockReceiveKey.mockResolvedValue({ key: present });
      await openAddKey();
      fill(present.fingerprint);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
      });
      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(alertOf("was already in the keyring and is still not trusted")).toBeInTheDocument();
      const row = screen.getByText(present.uid).closest("tr") as HTMLElement;
      expect(within(row).getByText("Fetched")).toBeInTheDocument();
    });

    it("refuses a key id and does not fetch it", async () => {
      await openAddKey();
      fireEvent.change(screen.getByRole("textbox", { name: "Key fingerprint" }), { target: { value: "0FA8E1BCB1F1A2C0" } });

      expect(screen.getByText(/This is a key id/)).toBeInTheDocument();
      const fetch = screen.getByRole("button", { name: "Fetch" });
      expect(fetch).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(fetch);
      expect(mockReceiveKey).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Locally sign key" })).toHaveAttribute("aria-disabled", "true");
    });

    it("keeps the dialog open with the reason when signing fails", async () => {
      mockReceiveKey.mockResolvedValue({ key: fetchedKey });
      mockLsignKey.mockRejectedValue(new Error("gpg: signing failed"));
      await openAddKey();
      fireEvent.change(screen.getByRole("textbox", { name: "Key fingerprint" }), { target: { value: FPR } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Locally sign key for/ }));
      });

      expect(screen.getByRole("dialog", { name: "Add key" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Key not signed/ })).toBeInTheDocument();
    });

    it("gates Add key without administrative access", async () => {
      mockPermission.mockReturnValueOnce({
        allowed: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      });
      render(<KeyringView />);
      const button = await screen.findByRole("button", { name: "Add key" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

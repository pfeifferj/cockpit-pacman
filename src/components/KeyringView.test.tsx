import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { KeyringView } from "./KeyringView";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    getKeyringStatus: vi.fn(),
    refreshKeyring: vi.fn(),
    initKeyring: vi.fn(),
  };
});

const mockGetKeyringStatus = vi.mocked(api.getKeyringStatus);
const mockRefreshKeyring = vi.mocked(api.refreshKeyring);
const mockInitKeyring = vi.mocked(api.initKeyring);

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
  warnings: [],
};

const mockUninitializedKeyring: api.KeyringStatusResponse = {
  keys: [],
  total: 0,
  master_key_initialized: false,
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
  });

  it("displays error message on API failure", async () => {
    mockGetKeyringStatus.mockRejectedValue(new Error("Network error"));

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByText(/Error loading keyring status/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Network error/)).toBeInTheDocument();
  });

  it("shows retry button on error", async () => {
    mockGetKeyringStatus.mockRejectedValue(new Error("Network error"));

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
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
      expect(screen.getByRole("button", { name: /Refresh Keys/i })).toBeInTheDocument();
    });
  });

  it("starts refresh when clicking Refresh Keys", async () => {
    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockRefreshKeyring.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn() };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Refresh Keys/i })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /Refresh Keys/i });
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
      return { cancel: vi.fn() };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Refresh Keys/i })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /Refresh Keys/i });
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    await act(async () => {
      capturedCallbacks?.onError("Failed to refresh keys");
    });

    await waitFor(() => {
      expect(screen.getByText(/Error loading keyring status/i)).toBeInTheDocument();
    });
  });

  it("cancels refresh when clicking Cancel", async () => {
    const mockCancel = vi.fn();
    mockRefreshKeyring.mockImplementation(() => {
      return { cancel: mockCancel };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Refresh Keys/i })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /Refresh Keys/i });
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    expect(screen.getByText(/keyserver/i)).toBeInTheDocument();

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    expect(mockCancel).toHaveBeenCalled();
  });

  it("shows initialize keyring for uninitialized keyring", async () => {
    mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Initialize Keyring/i })).toBeInTheDocument();
    });

    const headings = screen.getAllByText(/Keyring not initialized/i);
    expect(headings.length).toBeGreaterThan(0);
  });

  it("starts initialization when clicking Initialize Keyring", async () => {
    mockGetKeyringStatus.mockResolvedValue(mockUninitializedKeyring);

    let capturedCallbacks: api.UpgradeCallbacks | null = null;
    mockInitKeyring.mockImplementation((callbacks) => {
      capturedCallbacks = callbacks;
      return { cancel: vi.fn() };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Initialize Keyring/i })).toBeInTheDocument();
    });

    const initButton = screen.getByRole("button", { name: /Initialize Keyring/i });
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
      return { cancel: vi.fn() };
    });

    render(<KeyringView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Refresh Keys/i })).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /Refresh Keys/i });
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    await act(async () => {
      capturedCallbacks?.onData?.("Refreshing key ABCD1234...\n");
    });

    expect(screen.getByText(/Refreshing keys from keyserver/i)).toBeInTheDocument();
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { ErrorAlert } from "./ErrorAlert";
import { NavigationProvider } from "../contexts/NavigationContext";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import * as api from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return { ...actual, checkLock: vi.fn() };
});

const mockCheckLock = vi.mocked(api.checkLock);
const LOCK_FAILURE = "failed to initialize transaction (unable to lock database)";

const PGP_FAILURE =
  "Failed to commit transaction: invalid or corrupted package (PGP signature)";

describe("ErrorAlert", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders details under the message when present", () => {
    render(
      <ErrorAlert
        error="Preflight failed"
        title="Error"
        details="caused by: could not resolve host mirror.example"
      />
    );
    expect(screen.getByText("Preflight failed")).toBeInTheDocument();
    expect(
      screen.getByText(/could not resolve host mirror.example/)
    ).toBeInTheDocument();
  });

  it("retains diagnostics when the database is locked", () => {
    render(
      <ErrorAlert
        error="failed to initialize transaction (unable to lock database)"
        code="database_locked"
        title="Error"
        details="internal context chain"
        lockMessage="Database is busy, try again shortly."
      />
    );
    expect(
      screen.getByText("Database is busy, try again shortly.")
    ).toBeInTheDocument();
    expect(screen.getByText("internal context chain")).toBeInTheDocument();
  });

  it("routes a signature failure to the Keyring tab", () => {
    const onViewKeyring = vi.fn();
    render(
      <NavigationProvider value={{ onViewKeyring }}>
        <ErrorAlert error={PGP_FAILURE} code="signature_error" title="Upgrade failed" />
      </NavigationProvider>
    );
    expect(screen.getByText("Package signature could not be verified")).toBeInTheDocument();
    expect(screen.getByText(PGP_FAILURE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
    expect(onViewKeyring).toHaveBeenCalledTimes(1);
  });

  it("runs beforeNavigate ahead of the Keyring navigation", () => {
    const calls: string[] = [];
    render(
      <NavigationProvider value={{ onViewKeyring: () => calls.push("keyring") }}>
        <ErrorAlert
          error={PGP_FAILURE}
          code="signature_error"
          title="Upgrade failed"
          beforeNavigate={() => calls.push("close")}
        />
      </NavigationProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
    expect(calls).toEqual(["close", "keyring"]);
  });

  it("classifies a signature failure from the message when no code is given", () => {
    render(
      <NavigationProvider value={{ onViewKeyring: vi.fn() }}>
        <ErrorAlert error={PGP_FAILURE} title="Upgrade failed" />
      </NavigationProvider>
    );
    expect(screen.getByText("Package signature could not be verified")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Keyring" })).toBeInTheDocument();
  });

  it("offers no Keyring action without a navigation handler", () => {
    render(<ErrorAlert error={PGP_FAILURE} code="signature_error" title="Upgrade failed" />);
    expect(screen.getByText("Package signature could not be verified")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Keyring" })).not.toBeInTheDocument();
  });

  it("keeps the caller's title for other failures", () => {
    render(
      <NavigationProvider value={{ onViewKeyring: vi.fn() }}>
        <ErrorAlert error="could not commit transaction" code="transaction_failed" title="Upgrade failed" />
      </NavigationProvider>
    );
    expect(screen.getByText("Upgrade failed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Keyring" })).not.toBeInTheDocument();
  });

  it("hides Try again while waiting on the lock holder and offers it once stopped", async () => {
    mockCheckLock.mockResolvedValue({ locked: true, stale: false, blocking_process: "pacman", holder_unknown: false } as api.LockStatus);
    const onRetry = vi.fn();
    render(<ErrorAlert error={LOCK_FAILURE} code="database_locked" title="Search failed" onRetry={onRetry} details="Lock held by another request" />);
    expect(screen.getByText("Lock held by another request")).toBeInTheDocument();
    expect(await screen.findByText("pacman")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Keep waiting" })).toBeInTheDocument();
  });

  it("offers Try again beside a secondary stale-lock removal", async () => {
    mockCheckLock.mockResolvedValue({ locked: true, stale: true, holder_unknown: false } as api.LockStatus);
    render(<ErrorAlert error={LOCK_FAILURE} code="database_locked" title="Search failed" onRetry={vi.fn()} />);
    const remove = await screen.findByRole("button", { name: "Remove stale lock and retry" });
    expect(remove).toHaveClass("pf-m-secondary");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("retries once on its own when the first check finds no lock", async () => {
    mockCheckLock.mockResolvedValue({ locked: false, stale: false, holder_unknown: false } as api.LockStatus);
    const onRetry = vi.fn();
    const first = render(<ErrorAlert error={LOCK_FAILURE} code="database_locked" title="Install preview failed" onRetry={onRetry} />);
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    first.unmount();

    // The retry failed the same way and the host remounted the alert.
    render(<ErrorAlert error={LOCK_FAILURE} code="database_locked" title="Install preview failed" onRetry={onRetry} />);
    expect(await screen.findByText(/not locked now, but the operation failed again/)).toBeInTheDocument();
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("offers Try again for other failures only when asked", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorAlert error="boom" title="Error loading orphans" onRetry={onRetry} />);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    rerender(<ErrorAlert error="boom" title="Error loading orphans" onRetry={onRetry} showRetry />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the fixed lock text without a retry", () => {
    mockCheckLock.mockClear();
    render(<ErrorAlert error={LOCK_FAILURE} code="database_locked" title="Search failed" lockMessage="Busy." />);
    expect(screen.getByText("Busy.")).toBeInTheDocument();
    expect(mockCheckLock).not.toHaveBeenCalled();
  });

  it("hands the Keyring tab the failed operation and its retry", async () => {
    const onViewKeyring = vi.fn();
    const onRetry = vi.fn();
    render(
      <NavigationProvider value={{ onViewKeyring }}>
        <ErrorAlert
          error={PGP_FAILURE}
          code="signature_error"
          title="Install failed"
          onRetry={onRetry}
          signatureOrigin={{ origin: "install", target: "vim" }}
        />
      </NavigationProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
    await waitFor(() => expect(onViewKeyring).toHaveBeenCalledWith({ origin: "install", target: "vim", retry: onRetry }));
  });

  it("drops the retry when its host closes before navigating", () => {
    const onViewKeyring = vi.fn();
    render(
      <NavigationProvider value={{ onViewKeyring }}>
        <ErrorAlert
          error={PGP_FAILURE}
          code="signature_error"
          title="Install failed"
          onRetry={vi.fn()}
          beforeNavigate={vi.fn()}
          signatureOrigin={{ origin: "install", target: "vim" }}
        />
      </NavigationProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Keyring" }));
    expect(onViewKeyring).toHaveBeenCalledWith({ origin: "install", target: "vim", retry: undefined });
  });

  describe("announcement", () => {
    const watchStatus = () => {
      const seen: string[] = [];
      const status = screen.getByRole("status");
      new MutationObserver(() => {
        if (status.textContent) seen.push(status.textContent);
      }).observe(status, { childList: true, characterData: true, subtree: true });
      return seen;
    };
    const flush = () => act(async () => { await Promise.resolve(); });

    it("announces a failure once when it appears and again when it changes", async () => {
      const { rerender } = render(<AnnouncerProvider><div /></AnnouncerProvider>);
      const seen = watchStatus();

      rerender(<AnnouncerProvider><ErrorAlert error="Preflight failed" title="Install failed" /></AnnouncerProvider>);
      await flush();
      expect(seen).toHaveLength(1);

      rerender(<AnnouncerProvider><ErrorAlert error="Preflight failed" title="Install failed" className="x" /></AnnouncerProvider>);
      await flush();
      expect(seen).toHaveLength(1);

      rerender(<AnnouncerProvider><ErrorAlert error="Disk full" title="Install failed" /></AnnouncerProvider>);
      await flush();
      expect(seen).toHaveLength(2);
    });

    it("announces a signature failure once", async () => {
      const { rerender } = render(<AnnouncerProvider><div /></AnnouncerProvider>);
      const seen = watchStatus();
      rerender(<AnnouncerProvider><ErrorAlert error={PGP_FAILURE} code="signature_error" title="Upgrade failed" /></AnnouncerProvider>);
      await flush();
      expect(seen).toHaveLength(1);
    });
  });
});

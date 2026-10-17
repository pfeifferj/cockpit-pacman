import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Modal } from "@patternfly/react-core";
import { DowngradeProvider, useDowngrade } from "./DowngradeContext";
import { TransactionHost, TransactionHostProvider } from "../components/TransactionHost";
import { TRANSACTION_BANNER_ACTION_ID } from "../components/TransactionBanner";
import * as api from "../api";

vi.mock("../api", async () => ({
  ...await vi.importActual("../api"),
  listDowngrades: vi.fn(),
  previewDowngrade: vi.fn(),
  downgradePackage: vi.fn(),
}));

const versions: api.DowngradeResponse = {
  packages: [{
    name: "linux", version: "6.6.0-arch1-1", filename: "linux.pkg.tar.zst", size: 1024,
    installed_version: "6.7.0-arch1-1", is_older: true,
  }],
  total: 1,
};

const Launcher = ({ target }: { target: { name: string; version: string } }) => {
  const downgrade = useDowngrade()!;
  return <button onClick={() => downgrade.open(target)}>Open {target.name}</button>;
};

const RoutedDetails = ({ requested }: { requested: boolean }) => {
  const downgrade = useDowngrade()!;
  return (
    <Modal isOpen={requested && !downgrade.isOpen} aria-label="Routed details">
      <button>Details action</button>
    </Modal>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDowngrades).mockResolvedValue(versions);
  vi.mocked(api.previewDowngrade).mockResolvedValue({
    success: true, add: [], remove: [], conflicts: [], replacements: [], providers: [],
    import_keys: [], warnings: [], blocked_by: [], total_download_size: 0, net_installed_size: 0,
  });
});
afterEach(() => cleanup());

describe("DowngradeProvider", () => {
  it.each(["Installed", "Keyring"])("returns lost focus to the current %s panel", async (destination) => {
    const page = (active: string, source: boolean) => (
      <DowngradeProvider>
        <section role="tabpanel" aria-label="Installed" hidden={active !== "Installed"} tabIndex={0}>
          {source && <Launcher target={{ name: "linux", version: "6.7.0-arch1-1" }} />}
        </section>
        <section role="tabpanel" aria-label="Keyring" hidden={active !== "Keyring"} tabIndex={0} />
      </DowngradeProvider>
    );
    const { rerender } = render(page("Installed", true));
    const trigger = screen.getByRole("button", { name: "Open linux" });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    rerender(page(destination, false));
    act(() => cancel.focus());
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.getByRole("tabpanel", { name: destination })).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets newly routed details take focus when the downgrade closes", async () => {
    const page = (requested: boolean) => (
      <DowngradeProvider>
        <section role="tabpanel" aria-label="Current view" tabIndex={0}>
          {!requested && <Launcher target={{ name: "linux", version: "6.7.0-arch1-1" }} />}
        </section>
        <RoutedDetails requested={requested} />
      </DowngradeProvider>
    );
    const { rerender } = render(page(false));
    const panelFocus = vi.spyOn(screen.getByRole("tabpanel"), "focus");
    const trigger = screen.getByRole("button", { name: "Open linux" });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    rerender(page(true));
    act(() => cancel.focus());
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.getByRole("button", { name: "Details action" })).toHaveFocus());
    expect(screen.getAllByRole("dialog")).toEqual([screen.getByRole("dialog", { name: "Routed details" })]);
    expect(panelFocus).not.toHaveBeenCalled();
  });

  it("pins preparation to its original target after replacement requests and source removal", async () => {
    let resolveVersions!: (response: api.DowngradeResponse) => void;
    vi.mocked(api.listDowngrades).mockReturnValueOnce(new Promise((resolve) => { resolveVersions = resolve; }));
    const target = { name: "linux", version: "6.7.0-arch1-1" };
    const { rerender } = render(
      <DowngradeProvider>
        <Launcher target={target} />
        <Launcher target={{ name: "bash", version: "5.2-1" }} />
      </DowngradeProvider>,
    );
    const replacement = screen.getByRole("button", { name: "Open bash" });
    fireEvent.click(screen.getByRole("button", { name: "Open linux" }));
    const dialog = screen.getByRole("dialog", { name: "Downgrade linux" });
    fireEvent.click(replacement);
    target.name = "changed";
    target.version = "99-1";
    rerender(<DowngradeProvider>{null}</DowngradeProvider>);

    await act(async () => { resolveVersions(versions); });
    expect(screen.getByRole("dialog", { name: "Downgrade linux" })).toBe(dialog);
    expect(within(dialog).getByText("6.7.0-arch1-1")).toBeInTheDocument();
    expect(api.listDowngrades).toHaveBeenCalledTimes(1);
    expect(api.listDowngrades).toHaveBeenCalledWith("linux");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("survives source removal and hands the same run to the transaction host", async () => {
    let callbacks!: api.UpgradeCallbacks;
    let reopen: (() => void) | undefined;
    const cancel = vi.fn();
    vi.mocked(api.downgradePackage).mockImplementation((next) => {
      callbacks = next;
      return { cancel, forceStop: vi.fn(), setReopen: (open) => { reopen = open; } };
    });
    const page = (withSource: boolean) => (
      <TransactionHostProvider>
        <DowngradeProvider>
          <TransactionHost />
          <section role="tabpanel" aria-label="Current view" tabIndex={0}>
            <button id={TRANSACTION_BANNER_ACTION_ID}>View progress</button>
          </section>
          {withSource && <Launcher target={{ name: "linux", version: "6.7.0-arch1-1" }} />}
        </DowngradeProvider>
      </TransactionHostProvider>
    );
    const { rerender } = render(page(true));
    fireEvent.click(screen.getByRole("button", { name: "Open linux" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select 6.6.0-arch1-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Downgrade linux to 6.6.0-arch1-1" }));
    const foreground = screen.getByRole("dialog", { name: "Downgrade linux" });
    const log = within(foreground).getByRole("log");
    rerender(page(false));
    expect(screen.getByRole("dialog", { name: "Downgrade linux" })).toBe(foreground);
    expect(within(foreground).getByRole("log")).toBe(log);
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run in background" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
    expect(reopen).toBeTypeOf("function");
    await waitFor(() => expect(screen.getByRole("button", { name: "View progress" })).toHaveFocus());

    act(() => { reopen?.(); });
    const dialog = screen.getByRole("dialog", { name: "Downgrade linux" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(api.listDowngrades).toHaveBeenCalledTimes(1);
    expect(api.downgradePackage).toHaveBeenCalledTimes(1);

    act(() => callbacks.onComplete());
    expect(screen.getByRole("dialog", { name: "Downgrade linux" })).toBe(dialog);
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).find((button) => button.textContent === "Close")!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });
});

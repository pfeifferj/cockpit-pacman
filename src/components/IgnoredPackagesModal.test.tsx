import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within, cleanup } from "@testing-library/react";
import { IgnoredPackagesModal } from "./IgnoredPackagesModal";
import * as api from "../api";
import { mockPermission } from "../test/setup";
import { sweepA11y } from "../test/a11ySweep";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { SEARCH_DEBOUNCE_MS } from "../constants";

vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    listIgnoredPackages: vi.fn(),
    addIgnoredPackage: vi.fn(),
    removeIgnoredPackage: vi.fn(),
    getPackageInfo: vi.fn(),
    searchPackages: vi.fn(),
    getSyncPackageInfo: vi.fn(),
  };
});

const mockList = vi.mocked(api.listIgnoredPackages);
const mockAdd = vi.mocked(api.addIgnoredPackage);
const mockRemove = vi.mocked(api.removeIgnoredPackage);

let ignored: string[];

beforeEach(() => {
  vi.clearAllMocks();
  ignored = ["linux", "vim", "zsh"];
  mockList.mockImplementation(async () => ({ packages: [...ignored], total: ignored.length }));
  mockRemove.mockImplementation(async (name: string) => {
    ignored = ignored.filter((p) => p !== name);
    return { success: true, package: name, message: "" };
  });
  mockAdd.mockImplementation(async (name: string) => {
    ignored = [...ignored, name];
    return { success: true, package: name, message: "" };
  });
  vi.mocked(api.getPackageInfo).mockRejectedValue(new Error("not installed"));
});

async function renderModal(onIgnoredChange = vi.fn()) {
  render(<IgnoredPackagesModal isOpen onClose={vi.fn()} onIgnoredChange={onIgnoredChange} />);
  const dialog = await screen.findByRole("dialog", { name: "Ignored packages" });
  await within(dialog).findByRole("button", { name: "Unignore vim" });
  return { dialog, onIgnoredChange };
}

async function unignore(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: `Unignore ${name}` }));
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: `Unignore ${name}` })).not.toBeInTheDocument());
}

describe("IgnoredPackagesModal", () => {
  it("labels Unignore with text and keeps one primary action", async () => {
    await renderModal();
    expect(screen.getByRole("button", { name: "Unignore vim" })).toHaveTextContent("Unignore");
    sweepA11y({ dialogs: ["Ignored packages"] });
  });

  it("shows an Undo alert after Unignore, and Undo ignores the package again", async () => {
    const { onIgnoredChange } = await renderModal();
    await unignore("vim");

    expect(await screen.findByText("vim is no longer ignored during upgrades")).toBeInTheDocument();
    expect(mockRemove).toHaveBeenCalledWith("vim");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith("vim"));
    expect(await screen.findByText("vim is now ignored during upgrades")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Unignore vim" })).toBeInTheDocument();
    expect(onIgnoredChange).toHaveBeenLastCalledWith(["linux", "zsh", "vim"]);
  });

  it("renders the result inside a live region", async () => {
    await renderModal();
    await unignore("vim");
    const alert = await screen.findByText("vim is no longer ignored during upgrades");
    expect(alert.closest("[aria-live]")).not.toBeNull();
  });

  it("passes the reloaded list to onIgnoredChange", async () => {
    const { onIgnoredChange } = await renderModal();
    await unignore("linux");
    await waitFor(() => expect(onIgnoredChange).toHaveBeenCalledTimes(1));
    expect(onIgnoredChange).toHaveBeenCalledWith(["vim", "zsh"]);
  });

  it("derives the list when only the reload fails", async () => {
    const { onIgnoredChange } = await renderModal();
    mockList.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unignore vim" }));
    });
    await waitFor(() => expect(onIgnoredChange).toHaveBeenCalledWith(["linux", "zsh"]));
    expect(screen.getByText("Could not load ignored packages")).toBeInTheDocument();
  });

  it("names the failed operation and leaves the list unchanged", async () => {
    const { onIgnoredChange } = await renderModal();
    mockRemove.mockRejectedValueOnce(new Error("permission denied"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unignore vim" }));
    });
    expect(await screen.findByText("Could not unignore vim")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unignore vim" })).toBeInTheDocument();
    expect(onIgnoredChange).not.toHaveBeenCalled();
    expect(screen.queryByText("vim is no longer ignored during upgrades")).not.toBeInTheDocument();
  });

  it("moves focus to the next row, then the previous row, then the filter field", async () => {
    await renderModal();

    await unignore("vim");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Unignore zsh" })));

    await unignore("zsh");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Unignore linux" })));

    await unignore("linux");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  });

  it("focuses the filter field when the filter hides every remaining row", async () => {
    await renderModal();
    const filter = screen.getByRole("textbox", { name: "Filter ignored packages" });
    fireEvent.change(filter, { target: { value: "vim" } });
    await unignore("vim");
    await waitFor(() => expect(document.activeElement).toBe(filter));
  });

  it("keeps the table mounted during the reload", async () => {
    await renderModal();
    let resolve!: (v: { packages: string[]; total: number }) => void;
    mockList.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unignore vim" }));
    });
    const table = screen.getByRole("grid", { name: "Ignored packages" });
    expect(table).toHaveAttribute("aria-busy", "true");
    await act(async () => resolve({ packages: ["linux", "zsh"], total: 2 }));
    expect(table).toHaveAttribute("aria-busy", "false");
  });

  it("ignores a chosen package, returns focus to the search field and offers Undo", async () => {
    vi.mocked(api.searchPackages).mockResolvedValue({
      results: [{ name: "firefox", version: "130.0-1", description: "", repository: "extra", installed: false, installed_version: null }],
      total: 1,
    } as unknown as Awaited<ReturnType<typeof api.searchPackages>>);
    vi.mocked(api.getSyncPackageInfo).mockRejectedValue(new Error("offline"));
    const { onIgnoredChange } = await renderModal();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "fire" } });
    await waitFor(() => expect(api.searchPackages).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("option", { name: /firefox/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ignore package" }));
    });

    expect(await screen.findByText("firefox is now ignored during upgrades")).toBeInTheDocument();
    expect(mockAdd).toHaveBeenCalledWith("firefox");
    expect(onIgnoredChange).toHaveBeenCalledWith(["linux", "vim", "zsh", "firefox"]);
    expect(document.activeElement).toBe(input);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith("firefox"));
    expect(await screen.findByText("firefox is no longer ignored during upgrades")).toBeInTheDocument();
  });

  it("shows a load error with Try again instead of the empty state", async () => {
    mockList.mockRejectedValueOnce(new Error("pacman.conf unreadable"));
    render(<IgnoredPackagesModal isOpen onClose={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("heading", { name: "Could not load ignored packages" })).toBeInTheDocument();
    expect(screen.queryByText("No ignored packages")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ignore package" })).toHaveAttribute("aria-disabled", "true");
    sweepA11y({ dialogs: ["Ignored packages"] });

    retry.focus();
    await act(async () => {
      fireEvent.click(retry);
    });
    await screen.findByRole("button", { name: "Unignore vim" });
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Filter ignored packages" })));
  });

  it("announces a failed initial load", async () => {
    mockList.mockRejectedValueOnce(new Error("boom"));
    render(<AnnouncerProvider><IgnoredPackagesModal isOpen onClose={vi.fn()} /></AnnouncerProvider>);
    await screen.findByRole("button", { name: "Try again" });
    const polite = document.querySelector("[aria-live='polite'][aria-atomic='true']");
    await waitFor(() => expect(polite?.textContent).not.toBe(""));
  });

  it("reports unknown saved ignores without replacing them with an empty list", async () => {
    mockList.mockResolvedValueOnce({ packages: null, total: null });
    const onIgnoredChange = vi.fn();
    await act(async () => {
      render(<IgnoredPackagesModal isOpen onClose={vi.fn()} onIgnoredChange={onIgnoredChange} />);
    });
    expect(screen.getByText("Saved package ignores are unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No ignored packages")).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Ignore package" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(add);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(onIgnoredChange).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(screen.getByRole("button", { name: "Unignore vim" })).toBeInTheDocument();
    expect(screen.queryByText("Saved package ignores are unavailable")).not.toBeInTheDocument();
  });

  it("preserves shown ignores and blocks changes and Undo when a reload returns unknown", async () => {
    await renderModal();
    const row = screen.getByRole("button", { name: "Unignore zsh" });
    mockList.mockResolvedValueOnce({ packages: null, total: null });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Unignore vim" })); });
    expect(screen.getByText("Saved package ignores are unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unignore zsh" })).toBe(row);
    const undo = screen.getByRole("button", { name: "Undo" });
    for (const button of [row, undo, screen.getByRole("button", { name: "Ignore package" })]) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
    }
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockAdd).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(screen.queryByRole("button", { name: "Unignore vim" })).not.toBeInTheDocument();
    expect(row).not.toHaveAttribute("aria-disabled", "true");
    expect(undo).not.toHaveAttribute("aria-disabled", "true");
  });

  it("shows the backend details when the saved ignores cannot be read", async () => {
    mockList.mockRejectedValueOnce(new api.BackendError("Cannot read configuration", "permission_denied", "/etc/cockpit-pacman/config.json: Permission denied"));
    await act(async () => { render(<IgnoredPackagesModal isOpen onClose={vi.fn()} />); });
    expect(screen.getByText("Cannot read configuration")).toBeInTheDocument();
    expect(screen.getByText("/etc/cockpit-pacman/config.json: Permission denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ignore package" })).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps Try again in place when the retry fails too", async () => {
    mockList.mockRejectedValueOnce(new Error("boom")).mockRejectedValueOnce(new Error("boom"));
    render(<IgnoredPackagesModal isOpen onClose={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
    expect(screen.queryByText("No ignored packages")).not.toBeInTheDocument();
  });

  it("opens filtered to a package and focuses its Unignore", async () => {
    render(<IgnoredPackagesModal isOpen onClose={vi.fn()} initialFilter="vim" focusName="vim" />);
    const row = await screen.findByRole("button", { name: "Unignore vim" });
    expect(screen.getByRole("textbox", { name: "Filter ignored packages" })).toHaveValue("vim");
    expect(screen.queryByRole("button", { name: "Unignore linux" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("keeps the result alert mounted while the next change runs", async () => {
    await renderModal();
    await unignore("vim");
    const alert = (await screen.findByText("vim is no longer ignored during upgrades")).closest(".pf-v6-c-alert");
    expect(alert).not.toBeNull();

    let finish!: () => void;
    mockRemove.mockImplementationOnce((name: string) => new Promise((r) => {
      finish = () => {
        ignored = ignored.filter((p) => p !== name);
        r({ success: true, package: name, message: "" });
      };
    }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unignore zsh" }));
    });
    expect(alert).toBeInTheDocument();
    await act(async () => finish());
    await screen.findByText("zsh is no longer ignored during upgrades");
    expect(screen.getByText("zsh is no longer ignored during upgrades").closest(".pf-v6-c-alert")).toBe(alert);
  });

  it("selects a suggestion with ArrowDown and Enter, skipping ignored ones", async () => {
    vi.useFakeTimers();
    try {
      let resolveSearch!: (response: api.SearchResponse) => void;
      vi.mocked(api.searchPackages).mockReturnValueOnce(new Promise((resolve) => { resolveSearch = resolve; }));
      vi.mocked(api.getSyncPackageInfo).mockRejectedValue(new Error("offline"));
      await act(async () => { render(<IgnoredPackagesModal isOpen onClose={vi.fn()} />); });
      expect(screen.getByRole("button", { name: "Unignore vim" })).toBeInTheDocument();
      const input = screen.getByRole("combobox");
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "vim" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1); });
      expect(api.searchPackages).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(api.searchPackages).toHaveBeenCalledWith({ query: "vim", limit: 20, installed: "all" });
      await act(async () => {
        resolveSearch({
          results: [
            { name: "vim", version: "9.1-1", description: "", repository: "extra", installed: true, installed_version: "9.1-1" },
            { name: "vim-airline", version: "0.11-1", description: "", repository: "extra", installed: false, installed_version: null },
          ],
          total: 2,
          total_installed: 1,
          total_not_installed: 1,
          repositories: ["extra"],
          repository_counts: [{ name: "extra", count: 2 }],
        });
      });

      fireEvent.keyDown(input, { key: "ArrowDown" });
      const option = screen.getByRole("option", { name: /vim-airline/ });
      expect(input).toHaveAttribute("aria-activedescendant", option.id);

      await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
      expect(input).toHaveValue("vim-airline");
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("button", { name: "Ignore package" })).not.toHaveAttribute("aria-disabled", "true");
      expect(document.activeElement).toBe(input);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("gates Unignore and Ignore package without administrative access", async () => {
    mockPermission.mockReturnValueOnce({
      allowed: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    });
    await renderModal();
    const reason = "Turn on administrative access to change ignored packages";
    const row = screen.getByRole("button", { name: "Unignore vim" });
    const add = screen.getByRole("button", { name: "Ignore package" });
    for (const button of [row, add]) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription(reason);
    }
    fireEvent.click(row);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

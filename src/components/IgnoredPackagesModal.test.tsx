import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IgnoredPackagesModal } from "./IgnoredPackagesModal";
import * as api from "../api";

vi.mock("../api", async () => ({
  ...await vi.importActual("../api"),
  listIgnoredPackages: vi.fn(), removeIgnoredPackage: vi.fn(), addIgnoredPackage: vi.fn(),
  getPackageInfo: vi.fn(), searchPackages: vi.fn(),
}));

describe("saved package ignores", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getPackageInfo).mockRejectedValue(new Error("Not installed"));
    vi.mocked(api.searchPackages).mockResolvedValue({ results: [], total: 0, total_installed: 0, total_not_installed: 0, repositories: [] });
  });

  it("shows unreadable values as unavailable and recovers on retry", async () => {
    vi.mocked(api.listIgnoredPackages).mockResolvedValueOnce({ packages: null, total: null })
      .mockResolvedValueOnce({ packages: ["linux"], total: 1 });
    render(<IgnoredPackagesModal isOpen onClose={vi.fn()} />);
    expect(await screen.findByText("Saved package ignores are unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No ignored packages")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ignore Package" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Unignore linux" })).toBeEnabled();
    expect(screen.queryByText("Saved package ignores are unavailable")).not.toBeInTheDocument();
  });

  it("notifies the caller with the list loaded after removing a package", async () => {
    vi.mocked(api.listIgnoredPackages).mockResolvedValueOnce({ packages: ["linux", "glibc"], total: 2 })
      .mockResolvedValueOnce({ packages: ["glibc"], total: 1 });
    vi.mocked(api.removeIgnoredPackage).mockResolvedValue({ success: true, package: "linux", message: "Removed" });
    const changed = vi.fn();
    render(<IgnoredPackagesModal isOpen onClose={vi.fn()} onIgnoredChange={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unignore linux" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(["glibc"]));
    expect(screen.queryByRole("button", { name: "Unignore linux" })).not.toBeInTheDocument();
  });

  it("does not report defaults when the refresh after a mutation fails", async () => {
    vi.mocked(api.listIgnoredPackages).mockResolvedValueOnce({ packages: ["linux"], total: 1 })
      .mockRejectedValueOnce(new Error("Permission denied"));
    vi.mocked(api.removeIgnoredPackage).mockResolvedValue({ success: true, package: "linux", message: "Removed" });
    const changed = vi.fn();
    render(<IgnoredPackagesModal isOpen onClose={vi.fn()} onIgnoredChange={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unignore linux" }));
    expect(await screen.findByText("Saved package ignores are unavailable")).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });
});

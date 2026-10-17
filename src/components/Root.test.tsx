import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Root, RootBoundary } from "./Root";
import { useAnnounce } from "../contexts/AnnouncerContext";

vi.mock("./App", () => ({
  App: () => {
    const announce = useAnnounce();
    return <button onClick={() => announce("3 updates available")}>announce</button>;
  },
}));

function Throws(): never {
  throw new Error("provider exploded");
}

describe("RootBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders its children when nothing throws", () => {
    render(<RootBoundary><p>content</p></RootBoundary>);
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("shows the fallback with the cause and a Reload page that reloads the page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } });
    try {
      render(<RootBoundary><Throws /></RootBoundary>);
      expect(screen.getByRole("heading", { name: /cockpit-pacman stopped working/ })).toBeInTheDocument();
      expect(screen.getByText(/provider exploded/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
});

describe("Root", () => {
  afterEach(cleanup);

  it("mounts App inside the announcer so announcements reach a live region", async () => {
    render(<Root />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "announce" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("3 updates available");
  });
});

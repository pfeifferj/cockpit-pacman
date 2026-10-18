import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LogViewer } from "./LogViewer";

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 300;

function sizeLog(el: HTMLElement, scrollHeight = SCROLL_HEIGHT) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => CLIENT_HEIGHT });
}

function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  fireEvent.scroll(el);
}

describe("LogViewer", () => {
  afterEach(() => cleanup());

  it("is a focusable, silent log region with a label", () => {
    render(<LogViewer log="line" aria-label="Upgrade output" />);
    const log = screen.getByRole("log", { name: "Upgrade output" });
    expect(log).toHaveAttribute("tabindex", "0");
    expect(log).toHaveAttribute("aria-live", "off");
  });

  it("defaults the label to Output", () => {
    render(<LogViewer log="line" />);
    expect(screen.getByRole("log", { name: "Output" })).toBeInTheDocument();
  });

  it("follows new output while at the bottom", () => {
    const { rerender } = render(<LogViewer log="a" />);
    const log = screen.getByRole("log");
    sizeLog(log);
    rerender(<LogViewer log={"a\nb"} />);
    expect(log.scrollTop).toBe(SCROLL_HEIGHT);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("keeps following within 24 px of the bottom", () => {
    const { rerender } = render(<LogViewer log="a" />);
    const log = screen.getByRole("log");
    sizeLog(log);
    scrollTo(log, SCROLL_HEIGHT - CLIENT_HEIGHT - 20);
    rerender(<LogViewer log={"a\nb"} />);
    expect(log.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it("keeps scrollTop and offers Jump to latest after scrolling up, and resumes on click", () => {
    const { rerender } = render(<LogViewer log="a" />);
    const log = screen.getByRole("log");
    sizeLog(log);
    scrollTo(log, 100);

    sizeLog(log, SCROLL_HEIGHT + 200);
    rerender(<LogViewer log={"a\nb"} />);
    expect(log.scrollTop).toBe(100);

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(log.scrollTop).toBe(SCROLL_HEIGHT + 200);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
    expect(log).toHaveFocus();

    sizeLog(log, SCROLL_HEIGHT + 400);
    rerender(<LogViewer log={"a\nb\nc"} />);
    expect(log.scrollTop).toBe(SCROLL_HEIGHT + 400);
  });
});

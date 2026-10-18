import React, { useEffect } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, act, renderHook } from "@testing-library/react";
import { AnnouncerProvider, useAnnounce, useResultAnnouncement, type Announce } from "./AnnouncerContext";

let announce: Announce = () => {};
const Capture: React.FC = () => {
  const current = useAnnounce();
  useEffect(() => { announce = current; }, [current]);
  return null;
};

const flush = () => act(async () => { await Promise.resolve(); });

describe("AnnouncerProvider", () => {
  it("renders one polite status and one assertive alert region", () => {
    render(<AnnouncerProvider><Capture /></AnnouncerProvider>);
    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(status).toHaveClass("pf-v6-screen-reader");
  });

  it("re-reads a repeated message by clearing before setting it", async () => {
    render(<AnnouncerProvider><Capture /></AnnouncerProvider>);
    const status = screen.getByRole("status");

    act(() => announce("x"));
    expect(status).toHaveTextContent("");
    await flush();
    expect(status).toHaveTextContent("x");

    act(() => announce("x"));
    expect(status).toHaveTextContent("");
    await flush();
    expect(status).toHaveTextContent("x");
  });

  it("changes the DOM for an identical repeat made from a promise callback", async () => {
    render(<AnnouncerProvider><Capture /></AnnouncerProvider>);
    const status = screen.getByRole("status");
    await act(async () => {
      await Promise.resolve();
      announce("System is up to date");
    });
    await flush();
    expect(status).toHaveTextContent("System is up to date");

    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(status, { childList: true, subtree: true, characterData: true });
    await act(async () => {
      await Promise.resolve();
      announce("System is up to date");
    });
    await flush();
    mutations += observer.takeRecords().length;
    observer.disconnect();
    expect(mutations).toBeGreaterThan(0);
    expect(status).toHaveTextContent("System is up to date");
  });

  it("routes assertive messages to the alert region", async () => {
    render(<AnnouncerProvider><Capture /></AnnouncerProvider>);
    act(() => announce("Upgrade failed", { assertive: true }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Upgrade failed");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("does not move focus", async () => {
    render(<AnnouncerProvider><button>focused</button><Capture /></AnnouncerProvider>);
    const button = screen.getByRole("button", { name: "focused" });
    button.focus();
    act(() => announce("hello"));
    await flush();
    expect(document.activeElement).toBe(button);
  });

  it("keeps the regions exposed while a modal hides the rest of the page", async () => {
    render(<AnnouncerProvider><Capture /></AnnouncerProvider>);
    const host = screen.getByRole("status").parentElement!;
    host.setAttribute("aria-hidden", "true");
    await flush();
    expect(host).not.toHaveAttribute("aria-hidden");
  });
});

describe("useAnnounce", () => {
  it("is a no-op outside the provider", () => {
    const { result } = renderHook(() => useAnnounce());
    expect(() => result.current("nobody listens")).not.toThrow();
  });
});

describe("useResultAnnouncement", () => {
  const Result: React.FC<{ message: string | null; resultKey: string | null }> = ({ message, resultKey }) => {
    useResultAnnouncement(message, resultKey);
    return null;
  };

  it("stays silent at mount and announces when the key changes", async () => {
    const { rerender } = render(<AnnouncerProvider><Result message="3 packages" resultKey="a" /></AnnouncerProvider>);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("");

    rerender(<AnnouncerProvider><Result message="2 packages" resultKey="b" /></AnnouncerProvider>);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("2 packages");
  });

  it("announces a repeated key after an unsettled (null) key", async () => {
    const { rerender } = render(<AnnouncerProvider><Result message="1 package" resultKey="a" /></AnnouncerProvider>);
    rerender(<AnnouncerProvider><Result message="1 package" resultKey={null} /></AnnouncerProvider>);
    rerender(<AnnouncerProvider><Result message="1 package" resultKey="a" /></AnnouncerProvider>);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("1 package");
  });
});

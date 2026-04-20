import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBackdropClose } from "./useBackdropClose";

describe("useBackdropClose", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls onClose when clicking the PatternFly backdrop", () => {
    const onClose = vi.fn();
    const backdrop = document.createElement("div");
    backdrop.classList.add("pf-v6-c-backdrop");
    document.body.appendChild(backdrop);

    renderHook(() => useBackdropClose(true, onClose));

    const event = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(event, "target", { value: backdrop });
    document.dispatchEvent(event);

    expect(onClose).toHaveBeenCalledTimes(1);
    document.body.removeChild(backdrop);
  });

  it("does not call onClose when clicking inside dialog", () => {
    const onClose = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);

    renderHook(() => useBackdropClose(true, onClose));

    const event = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(event, "target", { value: dialog });
    document.dispatchEvent(event);

    expect(onClose).not.toHaveBeenCalled();
    document.body.removeChild(dialog);
  });

  it("does not call onClose when clicking a portaled popper (e.g. Select dropdown) outside the dialog", () => {
    const onClose = vi.fn();
    const popper = document.createElement("div");
    document.body.appendChild(popper);

    renderHook(() => useBackdropClose(true, onClose));

    const event = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(event, "target", { value: popper });
    document.dispatchEvent(event);

    expect(onClose).not.toHaveBeenCalled();
    document.body.removeChild(popper);
  });

  it("does not throw when mousedown target is a non-HTMLElement (e.g. Text node)", () => {
    const onClose = vi.fn();
    renderHook(() => useBackdropClose(true, onClose));

    const event = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(event, "target", { value: document.createTextNode("x") });

    expect(() => document.dispatchEvent(event)).not.toThrow();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not attach listener when isOpen is false", () => {
    const onClose = vi.fn();
    const addSpy = vi.spyOn(document, "addEventListener");

    renderHook(() => useBackdropClose(false, onClose));

    const mousedownCalls = addSpy.mock.calls.filter(
      ([type]) => type === "mousedown"
    );
    expect(mousedownCalls).toHaveLength(0);
  });

  it("does not attach listener when onClose is undefined", () => {
    const addSpy = vi.spyOn(document, "addEventListener");

    renderHook(() => useBackdropClose(true, undefined));

    const mousedownCalls = addSpy.mock.calls.filter(
      ([type]) => type === "mousedown"
    );
    expect(mousedownCalls).toHaveLength(0);
  });

  it("removes listener on unmount", () => {
    const onClose = vi.fn();
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = renderHook(() => useBackdropClose(true, onClose));
    unmount();

    const mousedownCalls = removeSpy.mock.calls.filter(
      ([type]) => type === "mousedown"
    );
    expect(mousedownCalls).toHaveLength(1);
  });
});

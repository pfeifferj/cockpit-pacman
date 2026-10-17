import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, fireEvent, cleanup } from "@testing-library/react";
import { shouldIgnoreShortcut, useShortcuts } from "./useShortcuts";

function setup() {
  const onFocusJump = vi.fn();
  const onToggleHelp = vi.fn();
  renderHook(() => useShortcuts({ onFocusJump, onToggleHelp }));
  return { onFocusJump, onToggleHelp };
}

describe("useShortcuts", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("'/' on the page focuses the jump and suppresses the default", () => {
    const { onFocusJump, onToggleHelp } = setup();
    const notPrevented = fireEvent.keyDown(document.body, { key: "/" });
    expect(onFocusJump).toHaveBeenCalledTimes(1);
    expect(onToggleHelp).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false);
  });

  it("'?' toggles the help", () => {
    const { onFocusJump, onToggleHelp } = setup();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(onToggleHelp).toHaveBeenCalledTimes(1);
    expect(onFocusJump).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea", "select"])("'/' inside a %s keeps its default and does nothing", (tag) => {
    const { onFocusJump } = setup();
    const el = document.createElement(tag);
    document.body.appendChild(el);
    el.focus();
    const notPrevented = fireEvent.keyDown(el, { key: "/" });
    expect(notPrevented).toBe(true);
    expect(onFocusJump).not.toHaveBeenCalled();
  });

  it("'/' inside a contenteditable does nothing", () => {
    const { onFocusJump } = setup();
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    el.appendChild(child);
    document.body.appendChild(el);
    fireEvent.keyDown(child, { key: "/" });
    expect(onFocusJump).not.toHaveBeenCalled();
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
  ])("%s+/ does nothing", (_name, mods) => {
    const { onFocusJump } = setup();
    fireEvent.keyDown(document.body, { key: "/", ...mods });
    expect(onFocusJump).not.toHaveBeenCalled();
  });

  it("does nothing while a modal is open", () => {
    const { onFocusJump, onToggleHelp } = setup();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    fireEvent.keyDown(document.body, { key: "/" });
    fireEvent.keyDown(document.body, { key: "?" });
    expect(onFocusJump).not.toHaveBeenCalled();
    expect(onToggleHelp).not.toHaveBeenCalled();
  });

  it("still works while a non-modal popover is open", () => {
    const { onToggleHelp } = setup();
    const popover = document.createElement("div");
    popover.className = "pf-v6-c-popover";
    popover.setAttribute("aria-modal", "true");
    document.body.appendChild(popover);
    fireEvent.keyDown(document.body, { key: "?" });
    expect(onToggleHelp).toHaveBeenCalledTimes(1);
  });

  it("ignores an event another handler already handled", () => {
    const { onFocusJump } = setup();
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.addEventListener("keydown", (e) => e.preventDefault());
    fireEvent.keyDown(el, { key: "/" });
    expect(onFocusJump).not.toHaveBeenCalled();
  });

  it("binds no other key", () => {
    const { onFocusJump, onToggleHelp } = setup();
    for (const key of ["r", "g", "Escape", "Enter", "k"]) {
      fireEvent.keyDown(document.body, { key });
    }
    expect(onFocusJump).not.toHaveBeenCalled();
    expect(onToggleHelp).not.toHaveBeenCalled();
  });
});

type KeyInit = NonNullable<ConstructorParameters<typeof window.KeyboardEvent>[1]>;

describe("shouldIgnoreShortcut", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // The target of a native event is set only while it is dispatched.
  function judge(html: string, init: KeyInit = {}, prevent = false, altGraph = false): boolean {
    document.body.innerHTML = html;
    const target = document.querySelector<HTMLElement>("[data-target]") ?? document.body;
    let result: boolean | undefined;
    const event = new window.KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true, ...init });
    if (altGraph) Object.defineProperty(event, "getModifierState", { value: (k: string) => k === "AltGraph" });
    target.addEventListener("keydown", (e) => {
      if (prevent) e.preventDefault();
      result = shouldIgnoreShortcut(e);
    }, { once: true });
    target.dispatchEvent(event);
    return result as boolean;
  }

  it.each([
    ["the page body", "", {}, false],
    ["a button", "<button data-target>Go</button>", {}, false],
    ["an input", "<input data-target>", {}, true],
    ["a textarea", "<textarea data-target></textarea>", {}, true],
    ["a select", "<select data-target></select>", {}, true],
    ["inside a contenteditable", '<div contenteditable="true"><span data-target>x</span></div>', {}, true],
    ["an empty contenteditable attribute", '<div contenteditable><span data-target>x</span></div>', {}, true],
    ["contenteditable=false", '<div contenteditable="false"><span data-target>x</span></div>', {}, false],
    ["Ctrl", "", { ctrlKey: true }, true],
    ["Alt", "", { altKey: true }, true],
    ["Meta", "", { metaKey: true }, true],
    ["Shift, which '?' needs", "", { shiftKey: true }, false],
    ["an open modal", '<div aria-modal="true"></div>', {}, true],
    ["an open popover", '<div class="pf-v6-c-popover" aria-modal="true"></div>', {}, false],
  ] as [string, string, KeyInit, boolean][])("on %s: %s", (_, html, init, ignored) => {
    expect(judge(html, init)).toBe(ignored);
  });

  it("ignores an event another handler already took", () => {
    expect(judge("", {}, true)).toBe(true);
  });

  it("accepts AltGr, which layouts use to type '/' and '?', though it reports Ctrl and Alt", () => {
    expect(judge("", { ctrlKey: true, altKey: true }, false, true)).toBe(false);
    expect(judge("<input data-target>", { ctrlKey: true, altKey: true }, false, true)).toBe(true);
  });
});

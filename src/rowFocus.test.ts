import { describe, it, expect, vi, afterEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { focusRow, rememberRow, restoreRowFocus, returnFocusToRow, ROW_LEAVE_WATCH_MS } from "./rowFocus";

const SELECTOR = "button[data-row]";

function mountList(names: string[]): { panel: HTMLElement; tbody: HTMLElement } {
  const panel = document.createElement("div");
  panel.setAttribute("role", "tabpanel");
  panel.innerHTML = `<input aria-label="Search"><table><tbody></tbody></table>`;
  document.body.appendChild(panel);
  const tbody = panel.querySelector("tbody")!;
  setRows(tbody, names);
  return { panel, tbody };
}

function setRows(tbody: HTMLElement, names: string[]) {
  tbody.innerHTML = names.map((n) => `<tr><td><button data-row="${n}">${n}</button></td></tr>`).join("");
}

const control = (name: string) => document.querySelector<HTMLElement>(`[data-row="${name}"]`)!;

const remember = (name: string) => rememberRow(control(name), SELECTOR, "data-row")!;

describe("rowFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("records the row's index among the list's controls", () => {
    mountList(["a", "b", "c"]);
    const memo = remember("b");
    expect(memo.index).toBe(1);
    expect(memo.key).toBe("b");
    expect(rememberRow(document.querySelector("input")!, SELECTOR, "data-row")).toBeNull();
  });

  it("focuses the row's own control when it is still in the list, without onGone", async () => {
    const { tbody } = mountList(["a", "b", "c"]);
    const memo = remember("b");
    setRows(tbody, ["z", "a", "b", "c"]);
    const onGone = vi.fn();
    restoreRowFocus(memo, onGone);
    await waitFor(() => expect(control("b")).toHaveFocus());
    expect(onGone).not.toHaveBeenCalled();
  });

  it("focuses the control now at the row's index when the row is gone", async () => {
    const { tbody } = mountList(["a", "b", "c"]);
    const memo = remember("b");
    setRows(tbody, ["a", "c"]);
    const onGone = vi.fn();
    restoreRowFocus(memo, onGone);
    await waitFor(() => expect(control("c")).toHaveFocus());
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("focuses the last row when the last row is gone", async () => {
    const { tbody } = mountList(["a", "b", "c"]);
    const memo = remember("c");
    setRows(tbody, ["a", "b"]);
    restoreRowFocus(memo);
    await waitFor(() => expect(control("b")).toHaveFocus());
  });

  it("focuses the tab panel when the list is empty", async () => {
    const { panel, tbody } = mountList(["a"]);
    const memo = remember("a");
    setRows(tbody, []);
    const onGone = vi.fn();
    restoreRowFocus(memo, onGone);
    await waitFor(() => expect(panel).toHaveFocus());
    expect(panel).toHaveAttribute("tabindex", "-1");
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("finds the rows in a replaced table", async () => {
    const { panel } = mountList(["a", "b", "c"]);
    const memo = remember("b");
    panel.querySelector("table")!.remove();
    const table = document.createElement("table");
    table.innerHTML = "<tbody></tbody>";
    panel.appendChild(table);
    setRows(table.querySelector("tbody")!, ["a", "c"]);
    restoreRowFocus(memo);
    await waitFor(() => expect(control("c")).toHaveFocus());
  });

  it("does not move focus that is somewhere other than the body", async () => {
    const { panel, tbody } = mountList(["a", "b", "c"]);
    const memo = remember("b");
    setRows(tbody, ["a", "c"]);
    const search = panel.querySelector("input")!;
    search.focus();
    const onGone = vi.fn();
    restoreRowFocus(memo, onGone);
    await new Promise((r) => setTimeout(r, 50));
    expect(search).toHaveFocus();
    expect(onGone).not.toHaveBeenCalled();
  });

  it("waits for a row that kept focus to leave, then moves focus to the next row once", async () => {
    const { tbody } = mountList(["a", "b", "c"]);
    const memo = remember("b");
    control("b").focus();
    const onGone = vi.fn();
    restoreRowFocus(memo, onGone);
    await new Promise((r) => setTimeout(r, 50));
    expect(control("b")).toHaveFocus();

    tbody.children[1].remove();
    await waitFor(() => expect(control("c")).toHaveFocus());
    expect(onGone).toHaveBeenCalledTimes(1);
    tbody.children[0].remove();
    await new Promise((r) => setTimeout(r, 20));
    expect(control("c")).toHaveFocus();
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("stops waiting once focus moves elsewhere or the watch runs out", async () => {
    const { panel, tbody } = mountList(["a", "b", "c"]);
    let memo = remember("b");
    control("b").focus();
    restoreRowFocus(memo);
    await new Promise((r) => setTimeout(r, 50));
    panel.querySelector("input")!.focus();
    tbody.children[1].remove();
    await new Promise((r) => setTimeout(r, 20));
    expect(panel.querySelector("input")).toHaveFocus();

    setRows(tbody, ["a", "b", "c"]);
    memo = remember("b");
    control("b").focus();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    restoreRowFocus(memo);
    vi.advanceTimersByTime(20);
    vi.advanceTimersByTime(ROW_LEAVE_WATCH_MS);
    vi.useRealTimers();
    tbody.children[1].remove();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(document.body);
  });

  it("cancels a pending restore", async () => {
    const { tbody } = mountList(["a", "b", "c"]);
    const memo = remember("b");
    setRows(tbody, ["a", "c"]);
    restoreRowFocus(memo)();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(document.body);
  });
});

describe("focusRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["the row is still there, moved", ["a", "b", "c", "d"], ["z", "a", "b", "c", "d"], "b", "b", false],
    ["the row left; the next row takes its index", ["a", "b", "c", "d"], ["a", "c", "d"], "b", "c", true],
    ["the first row left", ["a", "b", "c", "d"], ["b", "c", "d"], "a", "b", true],
    ["the index is past the end; the last row", ["a", "b", "c", "d"], ["a", "b"], "d", "b", true],
    ["several rows left before it", ["a", "b", "c", "d"], ["c"], "d", "c", true],
  ])("%s", (_, before, after, remembered, focused, gone) => {
    const { tbody } = mountList(before);
    const memo = remember(remembered);
    setRows(tbody, after);
    expect(focusRow(memo)).toBe(gone);
    expect(control(focused)).toHaveFocus();
  });

  it("falls back to the panel, made focusable, when no row is left", () => {
    const { panel, tbody } = mountList(["a", "b"]);
    const memo = remember("a");
    setRows(tbody, []);
    expect(focusRow(memo)).toBe(true);
    expect(panel).toHaveFocus();
    expect(panel).toHaveAttribute("tabindex", "-1");
  });

  it("keeps a tabindex the panel already has", () => {
    const { panel, tbody } = mountList(["a"]);
    panel.tabIndex = 0;
    const memo = remember("a");
    setRows(tbody, []);
    focusRow(memo);
    expect(panel).toHaveAttribute("tabindex", "0");
  });

  it("skips controls in hidden rows", () => {
    const { tbody } = mountList(["a", "b", "c"]);
    const memo = remember("b");
    setRows(tbody, ["a", "c", "d"]);
    control("c").closest("tr")!.setAttribute("hidden", "");
    focusRow(memo);
    expect(control("d")).toHaveFocus();
  });

  it("moves no focus when the panel itself is gone", () => {
    const { panel } = mountList(["a"]);
    const memo = remember("a");
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    panel.remove();
    expect(focusRow(memo)).toBe(true);
    expect(outside).toHaveFocus();
  });
});

describe("returnFocusToRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mount() {
    document.body.innerHTML = `
      <div hidden><button data-row="a">hidden a</button></div>
      <button data-row="a">a</button>
      <button data-row="b">b</button>
      <div data-details-for="a"><button>Close</button></div>
      <button id="outside">outside</button>`;
  }

  it("moves focus from the details panel to the visible trigger with the key", () => {
    mount();
    document.querySelector<HTMLElement>("[data-details-for] button")!.focus();
    returnFocusToRow("a", "data-row");
    expect(document.activeElement).toBe(document.querySelectorAll('[data-row="a"]')[1]);
  });

  it("leaves focus alone outside the panel or without a key", () => {
    mount();
    const outside = document.getElementById("outside")!;
    outside.focus();
    returnFocusToRow("a", "data-row");
    expect(outside).toHaveFocus();
    const close = document.querySelector<HTMLElement>("[data-details-for] button")!;
    close.focus();
    returnFocusToRow(null, "data-row");
    expect(close).toHaveFocus();
  });
});

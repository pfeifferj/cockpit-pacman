import { expect } from "vitest";
import { isInaccessible, screen, within } from "@testing-library/react";

const PRIMARY = ".pf-v6-c-button.pf-m-primary, .pf-v6-c-menu-toggle.pf-m-primary";
const HEADING = "h1, h2, h3, h4, h5, h6, [role=heading]";
const OUTLINE_SCOPE = "[role=dialog], [data-details-for]";
const NAMED_ROLES = [
  "button", "checkbox", "radio", "textbox", "searchbox", "combobox", "switch", "menuitem", "link", "slider",
] as const;

export interface A11ySweepOptions {
  /** Names of the dialogs that must be open; each must resolve by getByRole("dialog", { name }). */
  dialogs?: (string | RegExp)[];
  root?: HTMLElement;
}

/** Checks accessible names, heading order, ARIA references, and primary-action count. */
export function sweepA11y({ dialogs = [], root = document.body }: A11ySweepOptions = {}): void {
  const scope = root === document.body ? screen : within(root);
  expect(scope.queryAllByRole("dialog", { name: "" }), "dialog without an accessible name").toHaveLength(0);
  for (const name of dialogs) {
    expect(scope.getByRole("dialog", { name })).toBeInTheDocument();
  }
  for (const role of NAMED_ROLES) {
    const unnamed = scope.queryAllByRole(role, { name: "" });
    expect(unnamed.map((el) => el.outerHTML.slice(0, 120)), `${role} without an accessible name`).toEqual([]);
  }
  const nested = Array.from(root.querySelectorAll<HTMLElement>(HEADING))
    .filter((el) => el.parentElement?.closest(HEADING));
  expect(nested.map((el) => el.outerHTML.slice(0, 120)), "heading inside a heading").toEqual([]);
  const skipped = Array.from(root.querySelectorAll<HTMLElement>(OUTLINE_SCOPE)).flatMap((scopeEl) => {
    const headings = Array.from(scopeEl.querySelectorAll<HTMLElement>(HEADING)).filter((el) => !isInaccessible(el));
    return headings.slice(1).flatMap((el, i) => {
      const previous = headings[i];
      return headingLevel(el) > headingLevel(previous) + 1
        ? [`h${headingLevel(el)} "${el.textContent}" after h${headingLevel(previous)} "${previous.textContent}"`]
        : [];
    });
  });
  expect(skipped, "heading skips a level").toEqual([]);
  const dangling = Array.from(root.querySelectorAll<HTMLElement>("[aria-describedby], [aria-labelledby]"))
    .filter((el) => !isInaccessible(el))
    .flatMap((el) => ["aria-describedby", "aria-labelledby"].flatMap((attr) =>
      (el.getAttribute(attr) ?? "").split(/\s+/).filter((id) => id && !document.getElementById(id))
        .map((id) => `${attr}="${id}" on ${el.outerHTML.slice(0, 80)}`)));
  expect(dangling, "aria reference to a missing id").toEqual([]);
  // SkipToContent is a primary button that stays off screen until focused.
  const primaries = Array.from(root.querySelectorAll<HTMLElement>(PRIMARY))
    .filter((el) => !isInaccessible(el) && !el.closest(".pf-v6-c-skip-to-content"));
  const labels = primaries.map((b) => b.textContent);
  expect(labels.length, `more than one visible primary: ${labels.join(" | ")}`).toBeLessThanOrEqual(1);
}

function headingLevel(el: HTMLElement): number {
  const tag = /^H([1-6])$/.exec(el.tagName);
  return tag ? Number(tag[1]) : Number(el.getAttribute("aria-level") ?? 2);
}

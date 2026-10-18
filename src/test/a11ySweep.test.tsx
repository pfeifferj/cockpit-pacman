import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { sweepA11y } from "./a11ySweep";

describe("sweepA11y", () => {
  it("passes a named control with resolving references", () => {
    render(
      <>
        <h2>Title</h2>
        <input type="checkbox" aria-label="Select vim" aria-describedby="vim-help" />
        <span id="vim-help">Help</span>
      </>,
    );
    expect(() => sweepA11y()).not.toThrow();
  });

  it.each([
    ["an unnamed checkbox", () => <input type="checkbox" />, /checkbox without an accessible name/],
    ["a nested heading", () => <h1>Outer <span><h4>Inner</h4></span></h1>, /heading inside a heading/],
    ["a dangling aria-describedby", () => <button aria-describedby="gone">Go</button>, /aria reference to a missing id/],
    ["a dangling aria-labelledby", () => <div role="dialog" aria-labelledby="gone" aria-label="Dialog" />, /aria reference to a missing id/],
    ["an unnamed link", () => <a href="#x"><span aria-hidden="true">x</span></a>, /link without an accessible name/],
  ])("fails on %s", (_label, ui, message) => {
    render(ui());
    expect(() => sweepA11y()).toThrow(message);
  });

  describe("heading levels", () => {
    it("fails a dialog whose content skips from h1 to h3", () => {
      render(<div role="dialog" aria-label="Downgrade vim"><h1>Downgrade vim</h1><h3>Loading versions</h3></div>);
      expect(() => sweepA11y()).toThrow(/heading skips a level/);
    });

    it("passes a dialog that descends one level at a time and returns upwards", () => {
      render(
        <div role="dialog" aria-label="Downgrade vim">
          <h1>Downgrade vim</h1>
          <h2>Will be installed</h2>
          <h3>Output</h3>
          <h2>Will be removed</h2>
        </div>,
      );
      expect(() => sweepA11y()).not.toThrow();
    });

    it("fails a details panel that skips from h2 to h4", () => {
      render(<div data-details-for="vim" role="region" aria-label="vim"><h2>vim</h2><h4>Package not found</h4></div>);
      expect(() => sweepA11y()).toThrow(/heading skips a level/);
    });

    it("reads aria-level on role=heading", () => {
      render(<div role="dialog" aria-label="Rank"><h1>Rank</h1><div role="heading" aria-level={3}>Mirrors</div></div>);
      expect(() => sweepA11y()).toThrow(/heading skips a level/);
    });

    it("leaves headings outside dialogs and details panels alone", () => {
      render(<><h1>Page</h1><h4>Section</h4></>);
      expect(() => sweepA11y()).not.toThrow();
    });
  });
});

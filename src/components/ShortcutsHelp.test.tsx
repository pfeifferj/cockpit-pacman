import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { sweepA11y } from "../test/a11ySweep";

describe("ShortcutsHelp", () => {
  afterEach(() => cleanup());

  it("lists the bound keys when open", async () => {
    render(<ShortcutsHelp isOpen onOpenChange={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const keys = Array.from(dialog.querySelectorAll("kbd")).map((k) => k.textContent);
    expect(keys).toEqual(["/", "?", "Esc", "\u2191 / \u2193"]);
    sweepA11y({ dialogs: ["Keyboard shortcuts"] });
  });

  it("lists the jump verbs", async () => {
    render(<ShortcutsHelp isOpen onOpenChange={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const verbs = Array.from(dialog.querySelectorAll("code")).map((c) => c.textContent);
    expect(verbs).toEqual(["check", "rank", "progress", "reinstall <package>", "mark <package>"]);
  });

  it("the button requests opening", async () => {
    const onOpenChange = vi.fn();
    render(<ShortcutsHelp isOpen={false} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
  });
});

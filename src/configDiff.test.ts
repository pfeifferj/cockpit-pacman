import { describe, expect, it } from "vitest";
import { configurationDiff } from "./configDiff";

describe("configurationDiff", () => {
  it("keeps shared lines between changes", () => {
    expect(configurationDiff("a\nold\nkeep\nlast\n", "a\nnew\nkeep\nend\n")).toEqual({
      lines: [
        { kind: "context", text: "a" },
        { kind: "removed", text: "old" },
        { kind: "added", text: "new" },
        { kind: "context", text: "keep" },
        { kind: "removed", text: "last" },
        { kind: "added", text: "end" },
        { kind: "context", text: "" },
      ],
      truncated: false,
    });
  });

  it("distinguishes a missing final newline", () => {
    expect(configurationDiff("setting=yes", "setting=yes\n").lines).toContainEqual({ kind: "added", text: "" });
  });

  it("reports identical files without a diff", () => {
    expect(configurationDiff("same\n", "same\n")).toEqual({ lines: [], truncated: false });
  });

  it("lists no lines rather than mislabelled ones when too many changed", () => {
    expect(configurationDiff("old\n".repeat(20_000), "new\n".repeat(20_000))).toEqual({ lines: [], truncated: true });
  });

  it("handles long single lines", () => {
    const line = "x".repeat(100_000);
    expect(configurationDiff(line, line + "y").lines).toEqual([
      { kind: "removed", text: line }, { kind: "added", text: line + "y" },
    ]);
  });
});

import { describe, it, expect } from "vitest";
import { describeRepoChanges, repoModel } from "./RepositoriesView";
import { describeMirrorChanges } from "./MirrorsView";
import type { MirrorEntry, RepoEntry } from "../api";

const server = (value: string, enabled = true) => ({ directive_type: "Server", value, enabled });
const include = (value: string, enabled = true) => ({ directive_type: "Include", value, enabled });

function repo(name: string, over: Partial<RepoEntry> = {}): RepoEntry {
  return { name, enabled: true, sig_level: null, directives: [include("/etc/pacman.d/mirrorlist")], ...over };
}

const repos = (...names: string[]) => names.map((n) => repo(n));

describe("describeRepoChanges", () => {
  it("describes nothing for an unchanged list", () => {
    expect(describeRepoChanges(repos("core", "extra"), repos("core", "extra"))).toEqual([]);
  });

  it.each([
    ["add", repos("core"), repos("core", "custom"), ["Add [custom]"]],
    ["remove", repos("core", "custom"), repos("core"), ["Remove [custom]"]],
    ["disable", repos("core"), [repo("core", { enabled: false })], ["Disable [core]"]],
    ["enable", [repo("core", { enabled: false })], repos("core"), ["Enable [core]"]],
    ["set SigLevel", repos("core"), [repo("core", { sig_level: "Required" })], ["Set SigLevel of [core] to Required"]],
    ["reset SigLevel", [repo("core", { sig_level: "Never" })], repos("core"), ["Reset SigLevel of [core] to the default"]],
    ["empty SigLevel equals the default", [repo("core", { sig_level: "" })], repos("core"), []],
    ["add a directive", repos("core"),
      [repo("core", { directives: [include("/etc/pacman.d/mirrorlist"), server("https://x")] })],
      ["Add Server https://x to [core]"]],
    ["disable a directive", repos("core"), [repo("core", { directives: [include("/etc/pacman.d/mirrorlist", false)] })],
      ["Disable Include /etc/pacman.d/mirrorlist in [core]"]],
    ["remove a directive", repos("core"), [repo("core", { directives: [] })],
      ["Remove Include /etc/pacman.d/mirrorlist from [core]"]],
  ] as [string, RepoEntry[], RepoEntry[], string[]][])("%s", (_, before, after, expected) => {
    expect(describeRepoChanges(before, after)).toEqual(expected);
  });

  it.each([
    ["one repository moved to the end", ["a", "b", "c"], ["b", "c", "a"], ["Move [a] below [c]"]],
    ["one repository moved to the top", ["a", "b", "c"], ["c", "a", "b"], ["Move [c] above [a]"]],
    ["two swapped", ["a", "b", "c", "d"], ["a", "c", "b", "d"], ["Move [b] above [d]"]],
  ])("names only the repositories that moved: %s", (_, before, after, expected) => {
    expect(describeRepoChanges(repos(...before), repos(...after))).toEqual(expected);
  });

  it("does not count a removal or an addition as a move", () => {
    expect(describeRepoChanges(repos("a", "b", "c"), repos("a", "new", "c"))).toEqual(["Add [new]", "Remove [b]"]);
  });

  it("ignores the disabled pacman.conf example section", () => {
    expect(describeRepoChanges(repos("core", "repo-name"), repos("repo-name", "core"))).toEqual([]);
    expect(describeRepoChanges(repos("core"), repos("core", "repo-name"))).toEqual([]);
  });

  it("lists edits in list order, then removals, then moves", () => {
    const before = repos("a", "b", "c");
    const after = [repo("c", { enabled: false }), repo("a"), repo("d")];
    expect(describeRepoChanges(before, after)).toEqual([
      "Disable [c]",
      "Add [d]",
      "Remove [b]",
      "Move [a] below [c]",
    ]);
  });
});

describe("describeMirrorChanges", () => {
  const m = (url: string, enabled = true, comment: string | null = null): MirrorEntry => ({ url, enabled, comment });
  const A = "https://a.example/$repo/os/$arch";
  const B = "https://b.example/$repo/os/$arch";
  const C = "https://c.example/$repo/os/$arch";

  it.each([
    ["unchanged", [m(A), m(B)], [m(A), m(B)], []],
    ["add", [m(A)], [m(A), m(B)], [`Add ${B}`]],
    ["add disabled", [m(A)], [m(A), m(B, false)], [`Add ${B} (disabled)`]],
    ["remove", [m(A), m(B)], [m(A)], [`Remove ${B}`]],
    ["disable", [m(A)], [m(A, false)], [`Disable ${A}`]],
    ["enable", [m(A, false)], [m(A)], [`Enable ${A}`]],
    ["comment", [m(A, true, "old")], [m(A, true, "new")], [`Change the comment on ${A}`]],
    ["null and empty comment are equal", [m(A, true, null)], [m(A, true, "")], []],
    ["swap", [m(A), m(B)], [m(B), m(A)], ["Reorder 2 mirrors"]],
    ["move one to the top", [m(A), m(B), m(C)], [m(C), m(A), m(B)], ["Reorder 3 mirrors"]],
    ["removal is not a reorder", [m(A), m(B), m(C)], [m(A), m(C)], [`Remove ${B}`]],
    ["addition is not a reorder", [m(A), m(B)], [m(C), m(A), m(B)], [`Add ${C}`]],
  ] as [string, MirrorEntry[], MirrorEntry[], string[]][])("%s", (_, before, after, expected) => {
    expect(describeMirrorChanges(before, after)).toEqual(expected);
  });

  it("names a toggle and not a comment change when both changed", () => {
    expect(describeMirrorChanges([m(A, true, "x")], [m(A, false, "y")])).toEqual([`Disable ${A}`]);
  });
});

describe("repoModel", () => {
  it("keys by name and labels as a section", () => {
    expect(repoModel.key(repo("core"))).toBe("core");
    expect(repoModel.label(repo("core"))).toBe("[core]");
  });

  const mirrorlist = include("/etc/pacman.d/mirrorlist");
  it.each([
    ["identical", repo("core"), repo("core"), true],
    ["null and empty SigLevel", repo("core"), repo("core", { sig_level: "" }), true],
    ["enabled state", repo("core"), repo("core", { enabled: false }), false],
    ["SigLevel", repo("core"), repo("core", { sig_level: "Never" }), false],
    ["directive state", repo("core"), repo("core", { directives: [include("/etc/pacman.d/mirrorlist", false)] }), false],
    ["added directive", repo("core"), repo("core", { directives: [mirrorlist, server("https://x")] }), false],
    ["directive order",
      repo("core", { directives: [mirrorlist, server("https://x")] }),
      repo("core", { directives: [server("https://x"), mirrorlist] }), false],
  ] as [string, RepoEntry, RepoEntry, boolean][])("same() over %s is %s", (_, a, b, same) => {
    expect(repoModel.same(a, b)).toBe(same);
  });

  it("replays the user's toggle on a fresh entry that changed elsewhere", () => {
    const base = repo("core");
    const draft = repo("core", { enabled: false });
    const fresh = repo("core", { sig_level: "Required" });
    expect(repoModel.merge(base, draft, fresh)).toEqual({
      entry: repo("core", { enabled: false, sig_level: "Required" }),
      skipped: [],
    });
  });

  it("keeps the outside value and names the edit when both sides changed a field", () => {
    const base = repo("core");
    const draft = repo("core", { sig_level: "Never" });
    const fresh = repo("core", { sig_level: "Required" });
    expect(repoModel.merge(base, draft, fresh)).toEqual({
      entry: repo("core", { sig_level: "Required" }),
      skipped: ["Set SigLevel of [core] to Never: it changed outside this page"],
    });
  });

  it("adds, removes and toggles directives against the fresh list", () => {
    const base = repo("custom", { directives: [server("https://a"), server("https://b")] });
    const draft = repo("custom", { directives: [server("https://a", false), server("https://c")] });
    const fresh = repo("custom", { directives: [server("https://a"), server("https://b"), server("https://d")] });
    expect(repoModel.merge(base, draft, fresh)).toEqual({
      entry: repo("custom", { directives: [server("https://a", false), server("https://d"), server("https://c")] }),
      skipped: [],
    });
  });

  it("names a directive toggle whose line was removed outside", () => {
    const base = repo("custom", { directives: [server("https://a")] });
    const draft = repo("custom", { directives: [server("https://a", false)] });
    const fresh = repo("custom", { directives: [] });
    expect(repoModel.merge(base, draft, fresh).skipped).toEqual([
      "Disable Server https://a in [custom]: the line was removed outside this page",
    ]);
  });

  it("does not drop a directive the user removed if it was toggled outside", () => {
    const base = repo("custom", { directives: [server("https://a")] });
    const draft = repo("custom", { directives: [] });
    const fresh = repo("custom", { directives: [server("https://a", false)] });
    expect(repoModel.merge(base, draft, fresh)).toEqual({
      entry: fresh,
      skipped: ["Remove Server https://a from [custom]: it changed outside this page"],
    });
  });
});

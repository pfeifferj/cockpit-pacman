import { describe, it, expect } from "vitest";
import {
  SIGNOFF_TILE_FILTER,
  countToSignOff,
  decodeSignoffFilters,
  encodeSignoffFilters,
  matchesSignoffFilters,
  patchSignoffGroup,
} from "./SignoffsView";
import type { SignoffGroupWithLocal } from "../api";

type Filters = Parameters<typeof encodeSignoffFilters>[0];
type Filter = Filters extends ReadonlySet<infer F> ? F : never;

const ME = "josie";
const NOW = "2026-10-02T12:00:00Z";

function group(over: Partial<SignoffGroupWithLocal> = {}): SignoffGroupWithLocal {
  return {
    pkgbase: "vim",
    pkgnames: ["vim"],
    version: "9.1-1",
    arch: "x86_64",
    repo: "extra-testing",
    packager: "someone",
    last_update: NOW,
    known_bad: false,
    approved: false,
    required: 2,
    enabled: true,
    signoffs: [],
    local_version: "9.1-1",
    version_match: "match",
    ...over,
  };
}

const signoff = (user: string, revoked = false) => ({ user, created: NOW, revoked });
const set = (...f: Filter[]) => new Set<Filter>(f);

describe("encodeSignoffFilters and decodeSignoffFilters", () => {
  it.each([
    [set("installed", "pending", "unsigned"), ""],
    [set("unsigned", "installed", "pending"), ""],
    [set(), "all"],
    [set("bad"), "bad"],
    [set("signed", "installed"), "installed,signed"],
    [set("bad", "unsigned", "pending", "installed"), "installed,pending,unsigned,bad"],
  ])("%j encodes as %j and decodes back", (filters, encoded) => {
    expect(encodeSignoffFilters(filters)).toBe(encoded);
    expect(decodeSignoffFilters(encoded)).toEqual(filters);
  });

  it("decodes a missing value to the tile filter", () => {
    expect(decodeSignoffFilters(undefined)).toEqual(decodeSignoffFilters(SIGNOFF_TILE_FILTER));
    expect(decodeSignoffFilters(SIGNOFF_TILE_FILTER)).toEqual(set("installed", "pending", "unsigned"));
  });

  it.each(["nonsense", ",", "INSTALLED"])("falls back to the tile filter for %j", (value) => {
    expect(decodeSignoffFilters(value)).toEqual(set("installed", "pending", "unsigned"));
  });

  it("keeps the valid part of a partly invalid value", () => {
    expect(decodeSignoffFilters("bad,nonsense,signed")).toEqual(set("bad", "signed"));
  });

  it("returns a fresh set each time, so callers can change it", () => {
    const a = decodeSignoffFilters("");
    a.add("bad");
    expect(decodeSignoffFilters("")).not.toContain("bad");
  });
});

describe("matchesSignoffFilters", () => {
  const groups: Record<string, SignoffGroupWithLocal> = {
    pending: group(),
    notInstalled: group({ version_match: "not_installed", local_version: null }),
    mismatch: group({ version_match: "mismatch", local_version: "9.0-1" }),
    approved: group({ approved: true, signoffs: [signoff("a"), signoff("b")] }),
    enoughSignoffs: group({ signoffs: [signoff("a"), signoff("b")] }),
    revokedDoNotCount: group({ signoffs: [signoff("a"), signoff("b", true)] }),
    knownBad: group({ known_bad: true }),
    signedByMe: group({ signoffs: [signoff(ME)] }),
    revokedByMe: group({ signoffs: [signoff(ME, true)] }),
    signedByOther: group({ signoffs: [signoff("a")] }),
  };

  it.each([
    [set(), Object.keys(groups)],
    [set("installed"), Object.keys(groups).filter((k) => k !== "notInstalled")],
    [set("pending"), ["pending", "notInstalled", "mismatch", "revokedDoNotCount", "signedByMe", "revokedByMe", "signedByOther"]],
    [set("signed"), ["signedByMe"]],
    [set("unsigned"), Object.keys(groups).filter((k) => k !== "signedByMe")],
    [set("bad"), ["knownBad"]],
    [set("installed", "bad"), ["knownBad"]],
  ])("%j keeps the expected rows", (filters, expected) => {
    const kept = Object.entries(groups).filter(([, g]) => matchesSignoffFilters(g, filters, ME)).map(([k]) => k);
    expect(kept).toEqual(expected);
  });

  it("with the tile filter keeps exactly installed, pending rows the user has not signed off, as the tile counts", () => {
    const tile = decodeSignoffFilters(SIGNOFF_TILE_FILTER);
    const all = Object.values(groups);
    for (const [key, g] of Object.entries(groups)) {
      const installed = g.version_match !== "not_installed";
      const active = g.signoffs.filter((s) => !s.revoked);
      const pending = !g.approved && !g.known_bad && active.length < g.required;
      const unsigned = !active.some((s) => s.user === ME);
      expect(matchesSignoffFilters(g, tile, ME), key).toBe(installed && pending && unsigned);
    }
    expect(countToSignOff(all, ME)).toBe(all.filter((g) => matchesSignoffFilters(g, tile, ME)).length);
    expect(countToSignOff(all, ME)).toBe(5);
  });
});

describe("patchSignoffGroup", () => {
  it("adds the user's signoff and approves once the required count is reached", () => {
    const one = patchSignoffGroup(group({ signoffs: [signoff("a")] }), "signoff", ME, NOW);
    expect(one.signoffs).toEqual([signoff("a"), { user: ME, created: NOW, revoked: false }]);
    expect(one.approved).toBe(true);
  });

  it("does not approve below the required count, and revoked signoffs do not count", () => {
    const patched = patchSignoffGroup(group({ signoffs: [signoff("a", true)] }), "signoff", ME, NOW);
    expect(patched.approved).toBe(false);
  });

  it("never approves a known bad group", () => {
    const patched = patchSignoffGroup(group({ known_bad: true, signoffs: [signoff("a")] }), "signoff", ME, NOW);
    expect(patched.approved).toBe(false);
    expect(patched.signoffs).toHaveLength(2);
  });

  it("revokes only the user's active signoff and withdraws approval below the count", () => {
    const g = group({
      approved: true,
      signoffs: [signoff(ME, true), signoff(ME), signoff("a")],
    });
    const patched = patchSignoffGroup(g, "revoke", ME, NOW);
    expect(patched.signoffs).toEqual([signoff(ME, true), signoff(ME, true), signoff("a")]);
    expect(patched.approved).toBe(false);
  });

  it("keeps approval after a revoke that leaves enough signoffs", () => {
    const g = group({ approved: true, required: 1, signoffs: [signoff(ME), signoff("a")] });
    expect(patchSignoffGroup(g, "revoke", ME, NOW).approved).toBe(true);
  });

  it("leaves the input group unchanged", () => {
    const g = group({ signoffs: [signoff("a")] });
    const before = JSON.parse(JSON.stringify(g));
    patchSignoffGroup(g, "signoff", ME, NOW);
    patchSignoffGroup(g, "revoke", "a", NOW);
    expect(g).toEqual(before);
  });

  it("moves a row out of the tile filter after a sign off and back after the revoke", () => {
    const tile = decodeSignoffFilters(SIGNOFF_TILE_FILTER);
    const g = group();
    const signed = patchSignoffGroup(g, "signoff", ME, NOW);
    expect(matchesSignoffFilters(g, tile, ME)).toBe(true);
    expect(matchesSignoffFilters(signed, tile, ME)).toBe(false);
    expect(matchesSignoffFilters(patchSignoffGroup(signed, "revoke", ME, NOW), tile, ME)).toBe(true);
  });
});

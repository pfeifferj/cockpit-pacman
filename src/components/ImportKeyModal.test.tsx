import { describe, it, expect } from "vitest";
import { formatFingerprint } from "./ImportKeyModal";
import { normalizeFingerprint } from "../api";

const FPR = "3B94A80E50A477C7C8E44F8A0FA8E1BCB1F1A2C0";
const GROUPED = "3B94 A80E 50A4 77C7 C8E4 4F8A 0FA8 E1BC B1F1 A2C0";

describe("formatFingerprint", () => {
  it("groups a 40-hex fingerprint in 4-character blocks without a trailing space", () => {
    expect(formatFingerprint(FPR)).toBe(GROUPED);
  });

  it.each([
    ["", ""],
    ["ABCD", "ABCD"],
    ["ABCDE", "ABCD E"],
    ["ABCDEFGH", "ABCD EFGH"],
  ])("%j becomes %j", (input, out) => {
    expect(formatFingerprint(input)).toBe(out);
  });

  it.each([
    FPR.toLowerCase(),
    GROUPED,
    GROUPED.toLowerCase(),
    `0x${FPR}`,
    `  ${GROUPED.replace(/ /g, "\t")}  `,
  ])("shows typed %j in the canonical grouping once normalized", (typed) => {
    const normalized = normalizeFingerprint(typed);
    expect(normalized).toBe(FPR);
    expect(formatFingerprint(normalized ?? "")).toBe(GROUPED);
  });
});

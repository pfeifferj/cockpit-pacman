import { describe, it, expect } from "vitest";
import { vercmp } from "./vercmp";

describe("vercmp", () => {
  const chain = ["1.0a", "1.0alpha", "1.0b", "1.0beta", "1.0p", "1.0pre", "1.0rc", "1.0", "1.0.a", "1.0.1"];

  it("orders the vercmp(8) chain pairwise in both directions", () => {
    for (let i = 0; i < chain.length; i++) {
      for (let j = i + 1; j < chain.length; j++) {
        expect([chain[i], chain[j], vercmp(chain[i], chain[j])]).toEqual([chain[i], chain[j], -1]);
        expect([chain[j], chain[i], vercmp(chain[j], chain[i])]).toEqual([chain[j], chain[i], 1]);
      }
    }
  });

  it.each([
    ["1.10", "1.9", 1],
    ["1:1.0", "2.0", 1],
    ["1.0-2", "1.0-1", 1],
    ["1.0", "1.0", 0],
    ["1.0-1", "1.0", 0],
    ["1.0.0", "1.0", 1],
    ["1.001", "1.1", 0],
    ["1.0_1", "1.0.1", 0],
    ["1..0", "1.0", 1],
    ["0:1.0", "1.0", 0],
    [":1.0", "1.0", 0],
    ["2:1.0-1", "1:3.0-1", 1],
    ["6.10.1.arch1-1", "6.9.12.arch1-1", 1],
    ["1.0+git20240101-1", "1.0-1", 1],
  ])("vercmp(%s, %s) = %i", (a, b, expected) => {
    expect(vercmp(a, b)).toBe(expected);
    expect(vercmp(b, a)).toBe(-expected || 0);
  });
});

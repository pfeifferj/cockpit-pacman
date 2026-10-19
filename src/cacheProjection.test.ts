import { describe, expect, it } from "vitest";
import { keepFreeing } from "./cacheProjection";

describe("keepFreeing", () => {
  const projections = new Map([
    [2, { files: 2, bytes: 700 }],
    [1, { files: 4, bytes: 960 }],
    [0, { files: 6, bytes: 1110 }],
  ]);

  it("keeps the most versions that meet the shortfall", () => {
    expect(keepFreeing(projections, 700)).toBe(2);
    expect(keepFreeing(projections, 701)).toBe(1);
    expect(keepFreeing(projections, 960)).toBe(1);
  });

  it("does not suggest deleting every version", () => {
    expect(keepFreeing(projections, 961)).toBeNull();
  });

  it("cannot suggest a setting without its server projection", () => {
    expect(keepFreeing(new Map(), 1)).toBeNull();
  });
});

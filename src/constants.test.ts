import { describe, it, expect } from "vitest";
import { REBOOT_PACKAGES } from "./constants";
import rebootPackages from "../test/fixtures/reboot-packages.json";

describe("REBOOT_PACKAGES", () => {
  it("matches the list the backend shares", () => {
    const expected = [...rebootPackages.kernels, ...rebootPackages.critical].sort();
    expect([...REBOOT_PACKAGES].sort()).toEqual(expected);
  });
});

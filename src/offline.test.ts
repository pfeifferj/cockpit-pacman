import { describe, it, expect } from "vitest";
import { isNetworkError } from "./offline";
import { BackendError } from "./api";

describe("isNetworkError", () => {
  it("treats network_error and timeout codes as connectivity failures", () => {
    expect(isNetworkError(null, "network_error")).toBe(true);
    expect(isNetworkError(null, "timeout")).toBe(true);
  });

  it("treats other codes as non-connectivity", () => {
    expect(isNetworkError(null, "database_locked")).toBe(false);
    expect(isNetworkError(null, "internal_error")).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });

  it("unwraps a BackendError's code when no explicit code is given", () => {
    expect(isNetworkError(new BackendError("could not resolve host", "network_error"))).toBe(true);
    expect(isNetworkError(new BackendError("locked", "database_locked"))).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isNetworkError(new Error("network_error"))).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { bundleVersion, mismatchedBackendVersion } from "./version";
import { getBackendVersion } from "./api";

vi.mock("./api", () => ({ getBackendVersion: vi.fn() }));

const mocked = vi.mocked(getBackendVersion);

describe("mismatchedBackendVersion", () => {
  beforeEach(() => mocked.mockReset());

  it("reports nothing when the backend matches the bundle", async () => {
    mocked.mockResolvedValue(bundleVersion!);
    expect(await mismatchedBackendVersion()).toBeNull();
  });

  it("reports the backend version when a pacman upgrade has moved it on", async () => {
    mocked.mockResolvedValue("99.0.0");
    expect(await mismatchedBackendVersion()).toBe("99.0.0");
  });

  it("short-circuits without asking the backend when a dev build has no bundle version", async () => {
    vi.stubGlobal("__BUNDLE_VERSION__", undefined);
    vi.resetModules();
    const devApi = await import("./api");
    const devVersion = await import("./version");

    expect(devVersion.bundleVersion).toBeNull();
    expect(await devVersion.mismatchedBackendVersion()).toBeNull();
    expect(vi.mocked(devApi.getBackendVersion)).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("propagates a backend probe failure for the caller to treat as no mismatch", async () => {
    mocked.mockRejectedValueOnce(new Error("backend unavailable"));
    expect(await mismatchedBackendVersion().catch(() => null)).toBeNull();
    mocked.mockRejectedValueOnce(new Error("backend unavailable"));
    await expect(mismatchedBackendVersion()).rejects.toThrow("backend unavailable");
  });
});

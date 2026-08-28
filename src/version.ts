import { getBackendVersion } from "./api";

declare const __BUNDLE_VERSION__: string | undefined;

export const bundleVersion: string | null =
  typeof __BUNDLE_VERSION__ === "string" ? __BUNDLE_VERSION__ : null;

export async function mismatchedBackendVersion(): Promise<string | null> {
  if (bundleVersion === null) {
    return null;
  }
  const version = await getBackendVersion();
  return version === bundleVersion ? null : version;
}

import { BackendError, ErrorCode, isNetworkErrorCode } from "./api";

/**
 * True when an error (or an explicit streaming error code) represents a loss of
 * connectivity to Arch services rather than an application-level failure.
 *
 * Network calls originate from the managed host via the backend binary, not the
 * browser, so navigator.onLine is meaningless here: connectivity is inferred
 * from real backend call results.
 */
export function isNetworkError(err: unknown, code?: ErrorCode): boolean {
  if (code) {
    return isNetworkErrorCode(code);
  }
  if (err instanceof BackendError) {
    return isNetworkErrorCode(err.code);
  }
  return false;
}

import { MAX_LOG_SIZE_BYTES } from "./constants";

export const MAX_SEARCH_LENGTH = 256;
const MAX_ERROR_LENGTH = 500;

/** Append streamed output to a log, keeping only the trailing cap bytes. */
export function appendCapped(prev: string, data: string, cap = MAX_LOG_SIZE_BYTES): string {
  const next = prev + data;
  return next.length > cap ? next.slice(-cap) : next;
}

// The substring fallback covers errors that arrive as raw stream output
// without the structured envelope; the backend's code is authoritative.
export function isDbLockError(message: string, code?: string): boolean {
  if (code === "database_locked") return true;
  const lower = message.toLowerCase();
  return lower.includes("unable to lock database") || lower.includes("database is locked");
}

export function sanitizeSearchInput(input: string): string {
  return input.trim().normalize("NFC").slice(0, MAX_SEARCH_LENGTH);
}

export function sanitizeErrorMessage(message: string | null | undefined): string {
  if (!message) return "An unknown error occurred";
  // eslint-disable-next-line no-control-regex
  const cleaned = message.replace(/[\x00-\x1F\x7F]/g, " ").trim();
  if (cleaned.length > MAX_ERROR_LENGTH) {
    return cleaned.slice(0, MAX_ERROR_LENGTH) + "...";
  }
  return cleaned || "An unknown error occurred";
}

const ALLOWED_URL_PROTOCOLS = ["http:", "https:"];

export function sanitizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

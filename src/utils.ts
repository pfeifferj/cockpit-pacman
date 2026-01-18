export const MAX_SEARCH_LENGTH = 256;
const MAX_ERROR_LENGTH = 500;

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

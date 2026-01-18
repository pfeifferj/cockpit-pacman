export const MAX_SEARCH_LENGTH = 256;

export function sanitizeSearchInput(input: string): string {
  return input.trim().normalize("NFC").slice(0, MAX_SEARCH_LENGTH);
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

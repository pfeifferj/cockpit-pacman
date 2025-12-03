export const MAX_SEARCH_LENGTH = 256;

export function sanitizeSearchInput(input: string): string {
  return input.trim().normalize("NFC").slice(0, MAX_SEARCH_LENGTH);
}

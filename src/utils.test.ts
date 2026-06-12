import { describe, it, expect } from "vitest";
import {
  appendCapped,
  isDbLockError,
  sanitizeSearchInput,
  sanitizeErrorMessage,
  sanitizeUrl,
  MAX_SEARCH_LENGTH,
} from "./utils";

describe("appendCapped", () => {
  it("appends below the cap", () => {
    expect(appendCapped("abc", "def", 10)).toBe("abcdef");
  });

  it("keeps the trailing bytes when over the cap", () => {
    expect(appendCapped("abcde", "fgh", 4)).toBe("efgh");
  });

  it("returns the input unchanged at exactly the cap", () => {
    expect(appendCapped("ab", "cd", 4)).toBe("abcd");
  });

  it("handles appending to an empty log", () => {
    expect(appendCapped("", "data", 10)).toBe("data");
  });

  it("truncates a single chunk longer than the cap", () => {
    expect(appendCapped("", "abcdef", 3)).toBe("def");
  });

  it("returns an empty string for a zero cap", () => {
    expect(appendCapped("abc", "def", 0)).toBe("");
  });
});

describe("isDbLockError", () => {
  it("trusts the structured code regardless of message", () => {
    expect(isDbLockError("anything", "database_locked")).toBe(true);
  });

  it("matches the alpm lock message case-insensitively", () => {
    expect(isDbLockError("Unable to lock database")).toBe(true);
    expect(isDbLockError("error: DATABASE IS LOCKED")).toBe(true);
  });

  it("rejects unrelated errors and codes", () => {
    expect(isDbLockError("failed retrieving file", "network_error")).toBe(false);
    expect(isDbLockError("")).toBe(false);
  });

  it("falls back to the message when the code is not database_locked", () => {
    expect(isDbLockError("unable to lock database", "network_error")).toBe(true);
  });
});

describe("sanitizeSearchInput", () => {
  it("trims whitespace", () => {
    expect(sanitizeSearchInput("  linux  ")).toBe("linux");
  });

  it("normalizes unicode to NFC", () => {
    // e + combining acute accent (NFD) -> e-acute (NFC)
    const nfd = "e\u0301";
    const nfc = "\u00e9";
    expect(sanitizeSearchInput(nfd)).toBe(nfc);
  });

  it("truncates to MAX_SEARCH_LENGTH", () => {
    const long = "a".repeat(MAX_SEARCH_LENGTH + 100);
    expect(sanitizeSearchInput(long)).toHaveLength(MAX_SEARCH_LENGTH);
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeSearchInput("   ")).toBe("");
  });

  it("passes through normal input unchanged", () => {
    expect(sanitizeSearchInput("linux-headers")).toBe("linux-headers");
  });

  it("handles empty string", () => {
    expect(sanitizeSearchInput("")).toBe("");
  });
});

describe("sanitizeErrorMessage", () => {
  it("returns fallback for null", () => {
    expect(sanitizeErrorMessage(null)).toBe("An unknown error occurred");
  });

  it("returns fallback for undefined", () => {
    expect(sanitizeErrorMessage(undefined)).toBe("An unknown error occurred");
  });

  it("returns fallback for empty string", () => {
    expect(sanitizeErrorMessage("")).toBe("An unknown error occurred");
  });

  it("strips control characters", () => {
    expect(sanitizeErrorMessage("bad\x00input\x1Bhere")).toBe("bad input here");
  });

  it("returns fallback when message is only control characters", () => {
    expect(sanitizeErrorMessage("\x00\x01\x02")).toBe("An unknown error occurred");
  });

  it("truncates long messages with ellipsis", () => {
    const long = "x".repeat(600);
    const result = sanitizeErrorMessage(long);
    expect(result).toHaveLength(503); // 500 + "..."
    expect(result).toMatch(/\.\.\.$/);
  });

  it("does not truncate messages at the limit", () => {
    const exact = "x".repeat(500);
    expect(sanitizeErrorMessage(exact)).toBe(exact);
  });

  it("passes through normal messages", () => {
    expect(sanitizeErrorMessage("Permission denied")).toBe("Permission denied");
  });
});

describe("sanitizeUrl", () => {
  it("returns null for null input", () => {
    expect(sanitizeUrl(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(sanitizeUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(sanitizeUrl("")).toBeNull();
  });

  it("allows http URLs", () => {
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com/");
  });

  it("allows https URLs", () => {
    expect(sanitizeUrl("https://archlinux.org/packages")).toBe(
      "https://archlinux.org/packages"
    );
  });

  it("rejects javascript: URLs", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: URLs", () => {
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects ftp: URLs", () => {
    expect(sanitizeUrl("ftp://files.example.com")).toBeNull();
  });

  it("rejects file: URLs", () => {
    expect(sanitizeUrl("file:///etc/passwd")).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(sanitizeUrl("not a url")).toBeNull();
  });

  it("normalizes valid URLs", () => {
    const result = sanitizeUrl("https://EXAMPLE.COM/path");
    expect(result).toBe("https://example.com/path");
  });
});

import { describe, it, expect } from "vitest";
import {
  sanitizeSearchInput,
  sanitizeErrorMessage,
  sanitizeUrl,
  MAX_SEARCH_LENGTH,
} from "./utils";

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

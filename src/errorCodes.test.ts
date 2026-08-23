import { describe, it, expect } from "vitest";
import { NETWORK_ERROR_KEYWORDS, parseErrorCode } from "./api";
import fixture from "../test/fixtures/stream-complete-codes.json";
import networkKeywords from "../test/fixtures/network-error-keywords.json";

// The backend asserts it produces these strings; this end asserts the mapping.
describe("parseErrorCode against the messages the backend emits", () => {
  it.each(fixture.messages.map((m) => [m.message, m.code] as const))(
    "maps %j to %s",
    (message, code) => {
      expect(parseErrorCode(message)).toBe(code);
    },
  );

  it("covers every message in the fixture", () => {
    expect(fixture.messages.length).toBeGreaterThan(0);
  });
});

describe("NETWORK_ERROR_KEYWORDS", () => {
  it("matches the list the backend classifies by", () => {
    expect(NETWORK_ERROR_KEYWORDS).toEqual(networkKeywords.keywords);
  });

  it("actually classifies each keyword as a network error", () => {
    for (const keyword of networkKeywords.keywords) {
      expect(parseErrorCode(`pacman: ${keyword} while fetching`)).toBe("network_error");
    }
  });
});

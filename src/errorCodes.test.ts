import { describe, it, expect } from "vitest";
import { KNOWN_ERROR_CODES, NETWORK_ERROR_KEYWORDS, SIGNATURE_ERROR_KEYWORDS, parseErrorCode } from "./api";
import fixture from "../test/fixtures/stream-complete-codes.json";
import networkKeywords from "../test/fixtures/network-error-keywords.json";
import errorCodes from "../test/fixtures/error-codes.json";

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

describe("SIGNATURE_ERROR_KEYWORDS", () => {
  it("matches the list the backend classifies by", () => {
    expect(SIGNATURE_ERROR_KEYWORDS).toEqual(errorCodes.signatureKeywords);
  });

  it("classifies each keyword as a signature error", () => {
    for (const keyword of SIGNATURE_ERROR_KEYWORDS) {
      expect(parseErrorCode(`error: foo: ${keyword}`)).toBe("signature_error");
    }
  });

  it("maps the pacman commit failure for a bad signature", () => {
    expect(
      parseErrorCode("failed to commit transaction (invalid or corrupted package (PGP signature))"),
    ).toBe("signature_error");
  });
});

describe("config_changed", () => {
  it("is in the shared vocabulary and known to the frontend", () => {
    expect(errorCodes.codes).toContain("config_changed");
    expect(KNOWN_ERROR_CODES.has("config_changed")).toBe(true);
  });

  it("is never guessed from message text, only taken from the envelope", () => {
    expect(parseErrorCode("/etc/pacman.conf changed outside this editor since it was loaded")).not.toBe("config_changed");
  });
});

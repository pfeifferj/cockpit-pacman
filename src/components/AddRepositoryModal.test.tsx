import { describe, it, expect } from "vitest";
import { repoNameProblem } from "./AddRepositoryModal";

const CHARSET = "Use letters, digits, hyphens, underscores and periods only";

describe("repoNameProblem", () => {
  it.each([
    ["core", null],
    ["extra-testing", null],
    ["my_repo.2", null],
    ["a".repeat(256), null],
    ["a".repeat(257), "A repository name has at most 256 characters"],
    ["core]", CHARSET],
    ["core\nServer = evil", CHARSET],
    ["two words", CHARSET],
    [" core", CHARSET],
    ["core ", CHARSET],
    ["\tcore", CHARSET],
    ["ĉore", CHARSET],
    ["[core]", CHARSET],
    ["core/x", CHARSET],
  ])("%j gives %s", (name, problem) => {
    expect(repoNameProblem(name, [])).toBe(problem);
  });

  it("leaves empty input to the caller's required-field reason", () => {
    expect(repoNameProblem("", [])).toBeNull();
  });

  it.each(["options", "local"])("refuses the reserved section [%s], as save_repos_in does", (name) => {
    expect(repoNameProblem(name, [])).toBe(`[${name}] is reserved by pacman`);
  });

  it("matches reserved names case-sensitively, as pacman.conf sections do", () => {
    expect(repoNameProblem("Options", [])).toBeNull();
  });

  it("refuses a name already in pacman.conf, enabled or not", () => {
    expect(repoNameProblem("core", ["core", "extra"])).toBe("[core] is already in pacman.conf");
    expect(repoNameProblem("Core", ["core"])).toBeNull();
  });

  it("reports the character set before a reserved or duplicate name", () => {
    expect(repoNameProblem("local ", ["local "])).toBe(CHARSET);
  });
});

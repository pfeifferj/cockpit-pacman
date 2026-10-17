import { describe, it, expect, vi } from "vitest";
import { packageVerbs, type PackageVerb, type PackageVerbId, type PackageVerbState } from "./packageVerbs";
import type { MutationGate } from "../hooks/useMutationGate";

const OPEN: MutationGate = { blocked: false };

function state(over: Partial<PackageVerbState> = {}): PackageVerbState {
  return {
    name: "vim",
    installedVersion: "9.1-1",
    repository: "extra",
    syncVersion: "9.1-1",
    ignored: false,
    reason: "explicit",
    canDowngrade: true,
    gate: () => OPEN,
    on: {
      viewDetails: vi.fn(),
      viewDependencies: vi.fn(),
      viewHistory: vi.fn(),
      setIgnored: vi.fn(),
      setReason: vi.fn(),
      reinstall: vi.fn(),
      downgrade: vi.fn(),
      install: vi.fn(),
      remove: vi.fn(),
    },
    ...over,
  };
}

const runnable = (v: PackageVerb) => !v.gate?.blocked && !v.disabledReason;
const verb = (verbs: PackageVerb[], id: PackageVerbId) => {
  const found = verbs.find((v) => v.id === id);
  if (!found) throw new Error(`no ${id} slot`);
  return found;
};

describe("packageVerbs slots", () => {
  it("orders view verbs, then mutating verbs, then Remove", () => {
    const verbs = packageVerbs(state({ downgradeTo: "9.0-1" }));
    expect(verbs.map((v) => [v.id, v.group, v.label])).toEqual([
      ["details", "view", "View vim details"],
      ["dependencies", "view", "View vim dependencies"],
      ["history", "view", "View vim history"],
      ["ignore", "mutate", "Ignore vim"],
      ["reason", "mutate", "Mark vim as a dependency"],
      ["reinstall", "mutate", "Reinstall vim"],
      ["downgradeTo", "mutate", "Downgrade vim to 9.0-1"],
      ["downgrade", "mutate", "Downgrade vim…"],
      ["remove", "remove", "Remove vim"],
    ]);
    expect(verbs.filter((v) => v.isDanger).map((v) => v.id)).toEqual(["remove"]);
    expect(verbs.every(runnable)).toBe(true);
  });

  it("leaves out view verbs the host does not offer and downgrade slots it cannot open", () => {
    const base = state();
    const verbs = packageVerbs({
      ...base,
      canDowngrade: false,
      downgradeTo: "9.0-1",
      on: { ...base.on, viewDetails: undefined, viewDependencies: undefined, viewHistory: undefined },
    });
    expect(verbs.map((v) => v.id)).toEqual(["ignore", "reason", "reinstall", "remove"]);
  });

  it("gives Downgrade-to a slot only when downgradeTo is defined, even as null", () => {
    expect(packageVerbs(state()).some((v) => v.id === "downgradeTo")).toBe(false);
    const none = verb(packageVerbs(state({ downgradeTo: null })), "downgradeTo");
    expect(none.label).toBe("Downgrade vim to the replaced version");
    expect(none.disabledReason).toBe("This entry did not replace an earlier version of vim");
  });

  it.each([
    ["9.1-1", "9.1-1 is not older than the installed 9.1-1"],
    ["9.2-1", "9.2-1 is not older than the installed 9.1-1"],
    ["9.0-1", undefined],
  ])("Downgrade-to %s is disabled with %s", (to, reason) => {
    const s = state({ downgradeTo: to });
    const v = verb(packageVerbs(s), "downgradeTo");
    expect(v.disabledReason).toBe(reason);
    if (!reason) {
      v.run();
      expect(s.on.downgrade).toHaveBeenCalledWith(to);
    }
  });

  it("offers only the view verbs and Install for a package that is not installed", () => {
    const s = state({ installedVersion: null, syncVersion: "9.1-1", downgradeTo: "9.0-1" });
    const verbs = packageVerbs(s);
    expect(verbs.map((v) => v.id)).toEqual(["details", "dependencies", "history", "install"]);
    const install = verb(verbs, "install");
    expect(install.label).toBe("Install vim");
    expect(runnable(install)).toBe(true);
    install.run();
    expect(s.on.install).toHaveBeenCalled();
  });

  it("keeps the Install slot pending while the repository is checked, and drops it for no repository", () => {
    const checking = verb(packageVerbs(state({ installedVersion: null, repository: undefined })), "install");
    expect(checking.disabledReason).toBe("Checking the repositories for vim…");
    expect(checking.pending).toBe(true);
    expect(packageVerbs(state({ installedVersion: null, repository: null })).map((v) => v.id))
      .toEqual(["details", "dependencies", "history"]);
  });

  it("keeps every installed slot, disabled and pending, while installation is checked", () => {
    const verbs = packageVerbs(state({ installedVersion: undefined, downgradeTo: "9.0-1" }));
    expect(verbs.map((v) => v.id)).toEqual(packageVerbs(state({ downgradeTo: "9.0-1" })).map((v) => v.id));
    for (const v of verbs.filter((x) => x.group !== "view")) {
      expect(v.disabledReason, v.id).toBe("Checking whether vim is installed…");
      expect(v.pending, v.id).toBe(true);
    }
  });

  it("passes each verb's action phrase to the gate, and a blocked gate blocks every mutating verb", () => {
    const gate = vi.fn((action: string): MutationGate => ({ blocked: true, reason: `Turn on administrative access to ${action}` }));
    const verbs = packageVerbs(state({ gate, downgradeTo: "9.0-1" }));
    expect(gate.mock.calls.map(([a]) => a)).toEqual([
      "ignore vim",
      "mark vim as a dependency",
      "reinstall vim",
      "downgrade vim",
      "downgrade vim",
      "remove vim",
    ]);
    expect(verbs.filter(runnable).map((v) => v.id)).toEqual(["details", "dependencies", "history"]);
  });

  it("prefers the host's ignore and remove gates", () => {
    const ignoreGate = { blocked: true, reason: "ignore busy" };
    const removeGate = { blocked: true, reason: "remove busy" };
    const verbs = packageVerbs(state({ ignoreGate, removeGate }));
    expect(verb(verbs, "ignore").gate).toBe(ignoreGate);
    expect(verb(verbs, "remove").gate).toBe(removeGate);
    expect(runnable(verb(verbs, "reinstall"))).toBe(true);
  });
});

describe("packageVerbs ignore and install reason", () => {
  it("offers Unignore for a held package and writes the inverse", () => {
    const s = state({ ignored: true });
    const v = verb(packageVerbs(s), "ignore");
    expect(v.label).toBe("Unignore vim");
    v.run();
    expect(s.on.setIgnored).toHaveBeenCalledWith(false);
  });

  it("keeps Ignore pending while the ignore list is read", () => {
    const v = verb(packageVerbs(state({ ignored: undefined })), "ignore");
    expect(v.disabledReason).toBe("Checking whether vim is ignored…");
    expect(v.pending).toBe(true);
  });

  it.each([
    ["explicit", "Mark vim as a dependency", undefined, "dependency"],
    ["dependency", "Mark vim as explicitly installed", undefined, "explicit"],
    [null, "Change the install reason of vim", "Could not read the install reason of vim", null],
    [undefined, "Change the install reason of vim", "Checking the install reason of vim…", null],
  ] as const)("reason %s reads %s", (reason, label, disabledReason, target) => {
    const s = state({ reason });
    const v = verb(packageVerbs(s), "reason");
    expect(v.label).toBe(label);
    expect(v.disabledReason).toBe(disabledReason);
    expect(v.pending).toBe(reason === undefined);
    v.run();
    if (target) expect(s.on.setReason).toHaveBeenCalledWith(target);
    else expect(s.on.setReason).not.toHaveBeenCalled();
  });

  it("blocks Ignore and the install reason while one of them is written, and nothing else", () => {
    const verbs = packageVerbs(state({ busyReason: "Wait for Ignore to finish" }));
    expect(verb(verbs, "ignore").disabledReason).toBe("Wait for Ignore to finish");
    expect(verb(verbs, "reason").disabledReason).toBe("Wait for Ignore to finish");
    expect(runnable(verb(verbs, "reinstall"))).toBe(true);
    expect(runnable(verb(verbs, "remove"))).toBe(true);
  });
});

describe("packageVerbs Reinstall", () => {
  it.each([
    ["equal", { syncVersion: "9.1-1" }, undefined, false],
    ["equal with epoch", { installedVersion: "1:9.1-1", syncVersion: "1:9.1-1" }, undefined, false],
    ["repository build newer", { syncVersion: "9.2-1" },
      "extra has 9.2-1; reinstalling would upgrade vim alone. Upgrade it from Updates", false],
    ["repository build older", { syncVersion: "9.0-1" },
      "extra has 9.0-1; reinstalling would replace vim 9.1-1 with that older build", false],
    ["repository version unreadable", { syncVersion: null }, "Could not read the extra version of vim", false],
    ["repository version being read", { syncVersion: undefined }, "Checking the repository version…", true],
    ["repositories being checked", { repository: undefined, syncVersion: undefined },
      "Checking the repositories for vim…", true],
    ["in no repository", { repository: null, syncVersion: null },
      "vim is in no configured repository, so there is no build to reinstall", false],
  ] as [string, Partial<PackageVerbState>, string | undefined, boolean][])(
    "%s",
    (_, over, reason, pending) => {
      const v = verb(packageVerbs(state(over)), "reinstall");
      expect(v.disabledReason).toBe(reason);
      expect(v.pending).toBe(pending);
    },
  );

  it("is never runnable unless the repository build equals the installed one", () => {
    const installed = ["9.1-1", "1:9.1-1", undefined];
    const repositories = ["extra", null, undefined];
    const syncs = ["9.1-1", "1:9.1-1", "9.0-1", "9.2-1", "9.1-2", null, undefined];
    const gates: MutationGate[] = [OPEN, { blocked: true, reason: "busy" }];
    for (const installedVersion of installed) {
      for (const repository of repositories) {
        for (const syncVersion of syncs) {
          for (const g of gates) {
            const v = verb(packageVerbs(state({ installedVersion, repository, syncVersion, gate: () => g })), "reinstall");
            const matches = installedVersion !== undefined && !!repository && syncVersion === installedVersion;
            expect(runnable(v), `${installedVersion} ${repository} ${syncVersion} ${g.blocked}`).toBe(matches && !g.blocked);
          }
        }
      }
    }
  });
});

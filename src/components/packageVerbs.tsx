import React from "react";
import { Divider } from "@patternfly/react-core";
import {
  ArrowDownIcon,
  BanIcon,
  HistoryIcon,
  InfoCircleIcon,
  PlusCircleIcon,
  RedoIcon,
  TagIcon,
  TopologyIcon,
  TrashIcon,
} from "@patternfly/react-icons";
import { getSyncPackageInfo, type InstallReason } from "../api";
import type { MutationGate } from "../hooks/useMutationGate";
import { vercmp } from "../vercmp";
import { GatedDropdownItem } from "./GatedButton";

export type PackageVerbId =
  | "details"
  | "dependencies"
  | "history"
  | "ignore"
  | "reason"
  | "reinstall"
  | "downgradeTo"
  | "downgrade"
  | "install"
  | "remove";

export type PackageVerbGroup = "view" | "mutate" | "remove";

export interface PackageVerb {
  id: PackageVerbId;
  group: PackageVerbGroup;
  label: string;
  icon: React.ReactNode;
  gate?: MutationGate;
  disabledReason?: string;
  /** disabledReason is a check still running; the verb may become runnable without user action. */
  pending?: boolean;
  isDanger?: boolean;
  run: () => void;
}

/** Version of `name` in the sync databases (in `repo` when given); null when it cannot be read. */
export async function readSyncVersion(name: string, repo?: string): Promise<string | null> {
  try {
    return (await (repo ? getSyncPackageInfo(name, repo) : getSyncPackageInfo(name))).version;
  } catch {
    return null;
  }
}

export const reasonPhrase = (reason: InstallReason) =>
  reason === "dependency" ? "a dependency" : "explicitly installed";

export interface PackageVerbState {
  name: string;
  /** Installed version; null when not installed, undefined while that is checked. */
  installedVersion: string | null | undefined;
  /** Repository the package is available from; null for none, undefined while checked. */
  repository: string | null | undefined;
  /** Version in `repository`; null when it could not be read, undefined while it is read. */
  syncVersion: string | null | undefined;
  ignored: boolean | undefined;
  /** Install reason of the installed package as the local db reports it; null when unreadable, undefined while it is read. */
  reason: string | null | undefined;
  canDowngrade: boolean;
  /** Defined, even as null, to give "Downgrade <name> to <version>" a slot; null when there is no such version. */
  downgradeTo?: string | null;
  gate: (action: string) => MutationGate;
  ignoreGate?: MutationGate;
  removeGate?: MutationGate;
  busyReason?: string;
  on: {
    viewDetails?: () => void;
    viewDependencies?: () => void;
    viewHistory?: () => void;
    setIgnored: (ignore: boolean) => void;
    setReason: (reason: InstallReason) => void;
    reinstall: () => void;
    downgrade: (preselectVersion?: string) => void;
    install: () => void;
    remove: () => void;
  };
}

function reinstallBlock(s: PackageVerbState, installed: string): string | undefined {
  const { name, repository, syncVersion } = s;
  if (repository === undefined) return `Checking the repositories for ${name}…`;
  if (repository === null) return `${name} is in no configured repository, so there is no build to reinstall`;
  if (syncVersion === undefined) return "Checking the repository version…";
  if (syncVersion === null) return `Could not read the ${repository} version of ${name}`;
  if (syncVersion === installed) return undefined;
  // Installing a different repository build would change this one package outside the system upgrade.
  return vercmp(syncVersion, installed) > 0
    ? `${repository} has ${syncVersion}; reinstalling would upgrade ${name} alone. Upgrade it from Updates`
    : `${repository} has ${syncVersion}; reinstalling would replace ${name} ${installed} with that older build`;
}

/** Package actions in stable order, with pending checks disabled in place. */
export function packageVerbs(s: PackageVerbState): PackageVerb[] {
  const { name, on } = s;
  const verbs: PackageVerb[] = [];
  if (on.viewDetails) {
    verbs.push({ id: "details", group: "view", label: `View ${name} details`, icon: <InfoCircleIcon />, run: on.viewDetails });
  }
  if (on.viewDependencies) {
    verbs.push({ id: "dependencies", group: "view", label: `View ${name} dependencies`, icon: <TopologyIcon />, run: on.viewDependencies });
  }
  if (on.viewHistory) {
    verbs.push({ id: "history", group: "view", label: `View ${name} history`, icon: <HistoryIcon />, run: on.viewHistory });
  }

  if (s.installedVersion === null) {
    if (s.repository !== null) {
      verbs.push({
        id: "install",
        group: "mutate",
        label: `Install ${name}`,
        icon: <PlusCircleIcon />,
        gate: s.gate(`install ${name}`),
        disabledReason: s.repository === undefined ? `Checking the repositories for ${name}…` : undefined,
        pending: s.repository === undefined,
        run: on.install,
      });
    }
    return verbs;
  }

  const checking = s.installedVersion === undefined ? `Checking whether ${name} is installed…` : undefined;
  const installed = s.installedVersion ?? "";

  verbs.push({
    id: "ignore",
    group: "mutate",
    label: `${s.ignored ? "Unignore" : "Ignore"} ${name}`,
    icon: <BanIcon />,
    gate: s.ignoreGate ?? s.gate(`${s.ignored ? "unignore" : "ignore"} ${name}`),
    disabledReason: checking ?? s.busyReason ?? (s.ignored === undefined ? `Checking whether ${name} is ignored…` : undefined),
    pending: !!checking || s.ignored === undefined,
    run: () => on.setIgnored(!s.ignored),
  });

  const target: InstallReason | null = s.reason ? (s.reason === "dependency" ? "explicit" : "dependency") : null;
  verbs.push({
    id: "reason",
    group: "mutate",
    label: target ? `Mark ${name} as ${reasonPhrase(target)}` : `Change the install reason of ${name}`,
    icon: <TagIcon />,
    gate: s.gate(target ? `mark ${name} as ${reasonPhrase(target)}` : `change the install reason of ${name}`),
    disabledReason: checking ?? s.busyReason ?? (s.reason === undefined
      ? `Checking the install reason of ${name}…`
      : s.reason === null ? `Could not read the install reason of ${name}` : undefined),
    pending: !!checking || s.reason === undefined,
    run: () => { if (target) on.setReason(target); },
  });

  verbs.push({
    id: "reinstall",
    group: "mutate",
    label: `Reinstall ${name}`,
    icon: <RedoIcon />,
    gate: s.gate(`reinstall ${name}`),
    disabledReason: checking ?? reinstallBlock(s, installed),
    pending: !!checking || (!!s.repository && s.syncVersion === undefined) || s.repository === undefined,
    run: on.reinstall,
  });

  if (s.canDowngrade && s.downgradeTo !== undefined) {
    const to = s.downgradeTo;
    verbs.push({
      id: "downgradeTo",
      group: "mutate",
      label: to ? `Downgrade ${name} to ${to}` : `Downgrade ${name} to the replaced version`,
      icon: <ArrowDownIcon />,
      gate: s.gate(`downgrade ${name}`),
      disabledReason: checking ?? (!to
        ? `This entry did not replace an earlier version of ${name}`
        : vercmp(to, installed) >= 0 ? `${to} is not older than the installed ${installed}` : undefined),
      pending: !!checking,
      run: () => { if (to) on.downgrade(to); },
    });
  }

  if (s.canDowngrade) {
    verbs.push({
      id: "downgrade",
      group: "mutate",
      label: `Downgrade ${name}…`,
      icon: <ArrowDownIcon />,
      gate: s.gate(`downgrade ${name}`),
      disabledReason: checking,
      pending: !!checking,
      run: () => on.downgrade(),
    });
  }

  verbs.push({
    id: "remove",
    group: "remove",
    label: `Remove ${name}`,
    icon: <TrashIcon />,
    gate: s.removeGate ?? s.gate(`remove ${name}`),
    disabledReason: checking,
    pending: !!checking,
    isDanger: true,
    run: on.remove,
  });
  return verbs;
}

/** Grouped menu actions; data-pending lets command shortcuts wait for checks. */
export const PackageVerbMenuItems: React.FC<{ verbs: PackageVerb[] }> = ({ verbs }) => (
  <>
    {verbs.map((verb, i) => (
      <React.Fragment key={verb.id}>
        {i > 0 && verbs[i - 1].group !== verb.group && <Divider component="li" />}
        <GatedDropdownItem
          gate={verb.gate}
          disabledReason={verb.disabledReason}
          isDanger={verb.isDanger}
          data-pending={verb.pending || undefined}
          icon={verb.icon}
          onClick={verb.run}
        >
          {verb.label}
        </GatedDropdownItem>
      </React.Fragment>
    ))}
  </>
);

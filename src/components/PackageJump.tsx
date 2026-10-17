import React, { useEffect, useRef, useState } from "react";
import {
  Label,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuList,
  Popper,
  SearchInput,
  Spinner,
} from "@patternfly/react-core";
import { listInstalled, searchPackages, type InstallReason } from "../api";
import { useDebouncedValue } from "../hooks/useDebounce";
import { useAdminPermission } from "../hooks/useAdminPermission";
import {
  mutationGate,
  OWNER_ROUTES,
  transactionLabel,
  transactionOwner,
  useActiveTransaction,
  type MutationGate,
} from "../hooks/useMutationGate";
import type { RouteOptions } from "../hooks/useRoute";
import { plural } from "../utils";
import { reasonPhrase } from "./packageVerbs";

export interface JumpTab {
  slug: string;
  title: string;
}

export interface InspectOptions {
  repo?: string;
  trigger?: HTMLElement | null;
}

/** Optional command handlers; each owns its confirmation. */
export interface JumpCommandHandlers {
  onCheckUpdates?: () => void;
  onRankMirrors?: () => void;
  onReinstall?: (name: string, options: InspectOptions) => void;
  onSetInstallReason?: (name: string, reason: InstallReason, options: InspectOptions) => void;
}

interface PackageJumpProps {
  tabs: JumpTab[];
  onNavigate: (slug: string, options?: RouteOptions) => void;
  onInspect: (name: string, options: InspectOptions) => void;
  commands?: JumpCommandHandlers;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export const MIN_QUERY_LENGTH = 2;
export const DEBOUNCE_MS = 200;
const GROUP_LIMIT = 6;
// Backend matches include descriptions; fetch enough rows to find and rank exact names.
const FETCH_WINDOW = 100;
const PACKAGE_COMMAND_LIMIT = 3;

export type JumpVerb = "reinstall" | "mark";
const VERBS: { verb: JumpVerb; title: string }[] = [
  { verb: "reinstall", title: "Reinstall a package" },
  { verb: "mark", title: "Mark a package as dependency or explicitly installed" },
];

type Command =
  | { type: "check" }
  | { type: "rank" }
  | { type: "progress"; slug: string; options?: RouteOptions }
  | { type: "verb"; verb: JumpVerb }
  | { type: "reinstall"; name: string }
  | { type: "reason"; name: string; reason: InstallReason };

type Item =
  | { id: string; kind: "tab"; slug: string; title: string }
  | { id: string; kind: "command"; title: string; description?: string; gate?: MutationGate; command: Command }
  | { id: string; kind: "installed"; name: string; version: string; repo: string | null; reason: string }
  | { id: string; kind: "sync"; name: string; version: string; repo: string };

type PackageItem = Extract<Item, { kind: "installed" }>;

interface Results {
  query: string;
  installed: Item[] | "error";
  sync: Item[] | "error";
}

function rank<T>(items: T[], key: (item: T) => string, query: string): T[] {
  const q = query.toLowerCase();
  const tier = (item: T) => {
    const k = key(item).toLowerCase();
    if (k === q) return 0;
    if (k.startsWith(q)) return 1;
    return 2;
  };
  return items
    .map((item, index) => ({ item, index, tier: tier(item) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ item }) => item);
}

/** Splits an optional command verb from the package query. */
export function parseQuery(query: string): { verb?: JumpVerb; term: string } {
  const match = /^(reinstall|mark)\s+(\S.*)$/i.exec(query);
  if (!match) return { term: query };
  return { verb: match[1].toLowerCase() as JumpVerb, term: match[2].trim() };
}

function matchTabs(tabs: JumpTab[], query: string): Item[] {
  const q = query.toLowerCase();
  return rank(tabs.filter((t) => t.title.toLowerCase().includes(q)), (t) => t.title, query)
    .map((t) => ({ id: `tab:${t.slug}`, kind: "tab", slug: t.slug, title: t.title }));
}

export const PackageJump: React.FC<PackageJumpProps> = ({ tabs, onNavigate, onInspect, commands, inputRef }) => {
  const [value, setValue] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const requestIdRef = useRef(0);
  const ownInputRef = useRef<HTMLInputElement | null>(null);
  const fieldRef = inputRef ?? ownInputRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const permission = useAdminPermission();
  const transaction = useActiveTransaction();

  const query = useDebouncedValue(parseQuery(value.trim()).term, DEBOUNCE_MS);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (query.length < MIN_QUERY_LENGTH) return;

    const controller = new AbortController();
    Promise.allSettled([
      listInstalled({ search: query, limit: FETCH_WINDOW, signal: controller.signal }),
      searchPackages({ query, limit: FETCH_WINDOW, signal: controller.signal }),
    ]).then(([installedRes, syncRes]) => {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      const installed: Item[] | "error" = installedRes.status === "fulfilled"
        ? rank(installedRes.value.packages, (p) => p.name, query)
            .slice(0, GROUP_LIMIT)
            .map((p) => ({ id: `installed:${p.name}`, kind: "installed", name: p.name, version: p.version, repo: p.repository, reason: p.reason }))
        : "error";
      const shown = new Set(installed === "error" ? [] : (installed as PackageItem[]).map((i) => i.name));
      const sync: Item[] | "error" = syncRes.status === "fulfilled"
        ? rank(syncRes.value.results.filter((r) => !shown.has(r.name)), (r) => r.name, query)
            .slice(0, GROUP_LIMIT)
            .map((r) => ({ id: `sync:${r.repository}/${r.name}`, kind: "sync", name: r.name, version: r.version, repo: r.repository }))
        : "error";
      setResults({ query, installed, sync });
    });
    return () => controller.abort();
  }, [query]);

  const trimmed = value.trim();
  const { verb, term } = parseQuery(trimmed);
  const current = results && results.query === term ? results : null;
  const tabItems = trimmed.length >= MIN_QUERY_LENGTH ? matchTabs(tabs, trimmed) : [];

  const commandItems: Item[] = [];
  if (trimmed.length >= MIN_QUERY_LENGTH) {
    const q = trimmed.toLowerCase();
    const matches = (...words: string[]) => words.some((w) => w.toLowerCase().includes(q));
    if (!verb) {
      if (commands?.onCheckUpdates && matches("Check for updates", "sync", "refresh")) {
        commandItems.push({
          id: "command:check",
          kind: "command",
          title: "Check for updates",
          gate: mutationGate("sync the package databases", permission, transaction, "updates"),
          command: { type: "check" },
        });
      }
      if (commands?.onRankMirrors && matches("Rank mirrors", "mirrorlist")) {
        commandItems.push({ id: "command:rank", kind: "command", title: "Rank mirrors", command: { type: "rank" } });
      }
      const owner = transaction ? transactionOwner(transaction.command) : undefined;
      if (transaction && owner && matches("View progress", "transaction", "running")) {
        const route = OWNER_ROUTES[owner];
        commandItems.push({
          id: "command:progress",
          kind: "command",
          title: "View progress",
          description: `${transactionLabel(transaction)} is running`,
          command: { type: "progress", slug: route.slug, options: route.options },
        });
      }
      for (const stub of VERBS) {
        const handled = stub.verb === "reinstall" ? commands?.onReinstall : commands?.onSetInstallReason;
        if (handled && stub.verb.startsWith(q)) {
          commandItems.push({
            id: `command:verb:${stub.verb}`,
            kind: "command",
            title: `${stub.title}…`,
            description: `Type ${stub.verb} and a package name`,
            command: { type: "verb", verb: stub.verb },
          });
        }
      }
    } else if (current && current.installed !== "error") {
      const t = term.toLowerCase();
      const targets = (current.installed as PackageItem[])
        .filter((p) => p.name.toLowerCase().startsWith(t))
        .slice(0, PACKAGE_COMMAND_LIMIT);
      for (const p of targets) {
        if (verb === "reinstall" && commands?.onReinstall && p.repo !== null) {
          commandItems.push({
            id: `command:reinstall:${p.name}`,
            kind: "command",
            title: `Reinstall ${p.name}`,
            description: p.version,
            gate: mutationGate(`reinstall ${p.name}`, permission, transaction),
            command: { type: "reinstall", name: p.name },
          });
        }
        if (verb === "mark" && commands?.onSetInstallReason) {
          const reason: InstallReason = p.reason === "dependency" ? "explicit" : "dependency";
          commandItems.push({
            id: `command:reason:${p.name}`,
            kind: "command",
            title: `Mark ${p.name} as ${reasonPhrase(reason)}`,
            description: p.reason === "dependency" ? "Installed as a dependency" : "Installed explicitly",
            gate: mutationGate(`mark ${p.name} as ${reasonPhrase(reason)}`, permission, transaction),
            command: { type: "reason", name: p.name, reason },
          });
        }
      }
    }
  }

  const items: Item[] = [
    ...tabItems,
    ...commandItems,
    ...(current && current.installed !== "error" ? current.installed : []),
    ...(current && current.sync !== "error" ? current.sync : []),
  ];
  const pending = term.length >= MIN_QUERY_LENGTH && !current;
  const showMenu = isOpen && trimmed.length >= MIN_QUERY_LENGTH;
  const announcement = current
    ? items.length === 0
      ? `No matches for ${current.query}`
      : `${plural(items.length, "match", "matches")} for ${current.query}`
    : "";

  const reset = () => {
    setValue("");
    setIsOpen(false);
    setResults(null);
  };

  const runCommand = (command: Command, trigger: HTMLElement | null) => {
    switch (command.type) {
      case "check": commands?.onCheckUpdates?.(); break;
      case "rank": commands?.onRankMirrors?.(); break;
      case "progress": onNavigate(command.slug, command.options); break;
      case "reinstall": commands?.onReinstall?.(command.name, { trigger }); break;
      case "reason": commands?.onSetInstallReason?.(command.name, command.reason, { trigger }); break;
      case "verb": break;
    }
  };

  const activate = (item: Item) => {
    if (item.kind === "command" && item.gate?.blocked) return;
    const trigger = fieldRef.current;
    trigger?.focus();
    if (item.kind === "command" && item.command.type === "verb") {
      setValue(`${item.command.verb} `);
      setIsOpen(false);
      return;
    }
    reset();
    if (item.kind === "tab") {
      onNavigate(item.slug);
    } else if (item.kind === "command") {
      runCommand(item.command, trigger);
    } else {
      onInspect(item.name, { repo: item.kind === "sync" ? item.repo : undefined, trigger });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const inMenu = event.target instanceof Element && (menuRef.current?.contains(event.target) ?? false);
    if (event.key === "Escape") {
      if (isOpen) {
        event.preventDefault();
        setIsOpen(false);
        fieldRef.current?.focus();
      } else if (!inMenu && value !== "") {
        event.preventDefault();
        reset();
      }
      return;
    }
    if (inMenu) {
      if (event.key === "Tab") setIsOpen(false);
      return;
    }
    if (event.key === "ArrowDown" && items.length > 0) {
      event.preventDefault();
      setIsOpen(true);
      window.requestAnimationFrame(() => {
        menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
      });
    } else if (event.key === "Enter" && showMenu && items.length > 0) {
      event.preventDefault();
      activate(items[0]);
    }
  };

  const byId = new Map(items.map((item) => [item.id, item]));

  const renderCommand = (item: Item) => {
    if (item.kind !== "command") return null;
    const blocked = item.gate?.blocked ?? false;
    return (
      <MenuItem
        key={item.id}
        itemId={item.id}
        isAriaDisabled={blocked}
        description={blocked ? item.gate?.reason : item.description}
      >
        {item.title}
      </MenuItem>
    );
  };

  const renderPackage = (item: Item) => {
    if (item.kind === "tab" || item.kind === "command") return null;
    return (
      <MenuItem
        key={item.id}
        itemId={item.id}
        description={item.version}
      >
        {item.name}{" "}
        <Label isCompact>{item.repo ?? "local"}</Label>
      </MenuItem>
    );
  };

  const renderGroup = (label: string, group: Item[] | "error", errorText: string) => {
    if (group !== "error" && group.length === 0) return null;
    return (
      <MenuGroup label={label} labelHeadingLevel="h3" key={label}>
        <MenuList aria-label={label}>
          {group === "error"
            ? <MenuItem isDisabled itemId={`${label}:error`}>{errorText}</MenuItem>
            : group.map((item) => item.kind === "tab"
              ? <MenuItem key={item.id} itemId={item.id} description="Tab">{item.title}</MenuItem>
              : item.kind === "command" ? renderCommand(item) : renderPackage(item))}
        </MenuList>
      </MenuGroup>
    );
  };

  const menu = (
    <Menu
      ref={menuRef}
      onSelect={(_event, itemId) => {
        const item = byId.get(String(itemId));
        if (item) activate(item);
      }}
      isScrollable
    >
      <MenuContent>
        {pending && items.length === 0 && (
          <MenuList aria-label="Searching">
            <MenuItem isDisabled itemId="pending"><Spinner size="sm" aria-label="Searching" /></MenuItem>
          </MenuList>
        )}
        {current && items.length === 0 && current.installed !== "error" && current.sync !== "error" && (
          <MenuList aria-label="No matches">
            <MenuItem isDisabled itemId="none">No tab or package matches &quot;{current.query}&quot;</MenuItem>
          </MenuList>
        )}
        {renderGroup("Tabs", tabItems, "")}
        {renderGroup("Commands", commandItems, "")}
        {current && renderGroup("Installed", current.installed, "Could not search installed packages")}
        {current && renderGroup("Repositories", current.sync, "Could not search the repositories")}
      </MenuContent>
    </Menu>
  );

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} style={{ width: "100%", maxWidth: "24rem" }}>
      <Popper
        trigger={
          <SearchInput
            ref={fieldRef}
            aria-label="Go to package or tab"
            placeholder="Go to package or tab, e.g. linux-lts (/)"
            value={value}
            onChange={(_event, next) => {
              setValue(next);
              setIsOpen(next.trim().length >= MIN_QUERY_LENGTH);
            }}
            onClear={() => {
              reset();
              fieldRef.current?.focus();
            }}
          />
        }
        triggerRef={containerRef}
        popper={menu}
        popperRef={menuRef}
        isVisible={showMenu}
        appendTo="inline"
        width="trigger"
        onDocumentClick={(event) => {
          const target = event?.target;
          if (!(target instanceof Element) || !containerRef.current?.contains(target)) setIsOpen(false);
        }}
      />
      <div className="pf-v6-screen-reader" aria-live="polite" aria-atomic="true">
        {showMenu ? announcement : ""}
      </div>
    </div>
  );
};

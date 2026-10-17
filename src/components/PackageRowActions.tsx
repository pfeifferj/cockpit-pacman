import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AlertActionCloseButton,
  AlertGroup,
  Dropdown,
  DropdownList,
} from "@patternfly/react-core";
import {
  BackendError,
  addIgnoredPackage,
  getPackageInfo,
  getSyncPackageInfo,
  listIgnoredPackages,
  removeIgnoredPackage,
  setInstallReason,
  type InstallReason,
} from "../api";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { rememberRow, restoreRowFocus, type RowMemo } from "../rowFocus";
import { mutationGate, useActiveTransaction, type MutationGate } from "../hooks/useMutationGate";
import { useDowngrade } from "../contexts/DowngradeContext";
import { useNavigation } from "../contexts/NavigationContext";
import { ignoreNotice } from "../utils";
import { ErrorDetails } from "./ErrorDetails";
import { toLoadFailure, type LoadFailure } from "./LoadErrorState";
import { UndoLink } from "./UndoAlert";
import { kebabToggle } from "./KebabToggle";
import { PackageActionModal, installConfig, reinstallConfig, uninstallConfig } from "./PackageActionModal";
import { PackageVerbMenuItems, packageVerbs, readSyncVersion, reasonPhrase } from "./packageVerbs";

const CONFIGS = { install: installConfig, reinstall: reinstallConfig, remove: uninstallConfig };

type DialogKind = keyof typeof CONFIGS;

interface RowDialog {
  kind: DialogKind;
  name: string;
  version: string;
  repository?: string;
}

interface Toast {
  id: number;
  variant: "success" | "danger";
  title: string;
  body?: string;
  failure?: LoadFailure;
  undo?: () => void;
}

interface RowActionsHost {
  permission: boolean | null;
  /** `anchor` is inside the row the dialog came from; focus goes back to that row on close. */
  openDialog: (dialog: RowDialog, anchor: HTMLElement | null) => void;
  changeIgnore: (name: string, ignore: boolean) => void;
  changeReason: (name: string, reason: InstallReason, onChanged?: ReasonChangeHandler) => void;
  reportError: (title: string, error: unknown) => void;
}

type ReasonChangeHandler = (name: string, reason: InstallReason) => void;

const RowActionsContext = createContext<RowActionsHost | null>(null);

const KEBAB_SELECTOR = 'button[aria-label^="Actions for "]';

async function changeIgnore(name: string, ignore: boolean, isUndo: boolean, push: (toast: Omit<Toast, "id">) => void) {
  try {
    await (ignore ? addIgnoredPackage(name) : removeIgnoredPackage(name));
  } catch (err) {
    push({ variant: "danger", title: ignore ? `Could not ignore ${name}` : `Could not unignore ${name}`, failure: toLoadFailure(err) });
    return;
  }
  push({
    variant: "success",
    title: ignoreNotice(name, ignore),
    undo: isUndo ? undefined : () => void changeIgnore(name, !ignore, true, push),
  });
}

async function changeReason(
  name: string,
  reason: InstallReason,
  isUndo: boolean,
  push: (toast: Omit<Toast, "id">) => void,
  onChanged?: ReasonChangeHandler,
) {
  let result;
  try {
    result = await setInstallReason(name, reason);
  } catch (err) {
    push({ variant: "danger", title: `Could not change the install reason of ${name}`, failure: toLoadFailure(err) });
    return;
  }
  const next = result.reason === "dependency" ? await getPackageInfo(name).catch(() => null) : null;
  const orphan = !!next && next.required_by.length === 0 && next.optional_for.length === 0;
  const previous = result.previous;
  onChanged?.(name, result.reason);
  push({
    variant: "success",
    title: `${name} is now marked as ${reasonPhrase(result.reason)}`,
    body: orphan ? "Nothing requires it, so it is now an orphan." : undefined,
    undo: isUndo ? undefined : () => void changeReason(name, previous, true, push, onChanged),
  });
}

const TOAST_TIMEOUT_MS = 8000;

/** Mount above the list so dialogs and Undo survive row removal and pagination. */
export const PackageRowActionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const permission = useAdminPermission();
  const transaction = useActiveTransaction();
  const undoGate = mutationGate("undo this package change", permission, transaction);
  const announce = useAnnounce();
  const [dialog, setDialog] = useState<RowDialog | null>(null);
  const rowMemo = useRef<RowMemo | null>(null);
  const cancelRestore = useRef<() => void>(() => {});
  useEffect(() => () => cancelRestore.current(), []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);
  const closeToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const value = useMemo<RowActionsHost>(() => ({
    permission,
    openDialog: (next, anchor) => setDialog((current) => {
      if (current) return current;
      rowMemo.current = anchor && rememberRow(anchor, KEBAB_SELECTOR, "aria-label");
      return next;
    }),
    changeIgnore: (name, ignore) => void changeIgnore(name, ignore, false, push),
    changeReason: (name, reason, onChanged) => void changeReason(name, reason, false, push, onChanged),
    reportError: (title, error) => push({ variant: "danger", title, failure: toLoadFailure(error) }),
  }), [permission, push]);

  const closeDialog = () => {
    const memo = rowMemo.current;
    const name = dialog?.name;
    rowMemo.current = null;
    setDialog(null);
    cancelRestore.current();
    if (memo) cancelRestore.current = restoreRowFocus(memo, () => announce(`${name} is no longer in the list`));
  };

  return (
    <RowActionsContext.Provider value={value}>
      {children}
      {dialog && (
        <PackageActionModal
          config={CONFIGS[dialog.kind]}
          packageName={dialog.name}
          packageVersion={dialog.version}
          packageRepository={dialog.repository}
          isOpen
          onClose={closeDialog}
        />
      )}
      <AlertGroup isToast isLiveRegion>
        {toasts.map((t) => (
          <Alert
            key={t.id}
            variant={t.failure?.code === "database_locked" ? "warning" : t.variant}
            title={t.title}
            timeout={t.variant === "danger" ? false : TOAST_TIMEOUT_MS}
            onTimeout={() => closeToast(t.id)}
            actionClose={<AlertActionCloseButton onClose={() => closeToast(t.id)} />}
            actionLinks={t.undo && (
              <UndoLink label="Undo" reason={undoGate.reason} onClick={() => { closeToast(t.id); t.undo?.(); }} />
            )}
          >
            {t.failure?.message ?? t.body}
            <ErrorDetails details={t.failure?.details} />
          </Alert>
        ))}
      </AlertGroup>
    </RowActionsContext.Provider>
  );
};

// React portal events bubble to the row; remember menu clicks to suppress row activation.
const kebabEvents = new WeakSet<Event>();

/** Whether a row click came from a PackageRowActions kebab or its menu. */
export function fromRowActions(event: React.SyntheticEvent | undefined): boolean {
  return !!event && kebabEvents.has(event.nativeEvent);
}

export interface PackageRowActionsProps {
  name: string;
  /** Installed version; null when not installed. Undefined is resolved from the databases when the menu opens. */
  installedVersion?: string | null;
  /** Repository the package is available from; null for a package in no configured repository. */
  repository?: string | null;
  /** Repository version that Install and Reinstall install. Undefined is read from the databases when the menu opens. */
  syncVersion?: string;
  /** Undefined is read from pacman.conf when the menu opens. */
  ignored?: boolean;
  /** Install reason from the local db. Undefined is read from it when the menu opens. */
  reason?: string;
  /** Offers "Downgrade <name> to <version>" with that version preselected; null keeps the slot, disabled. */
  downgradeTo?: string | null;
  onViewDetails?: () => void;
  onViewDependencies?: (name: string) => void;
  onViewHistory?: (name: string) => void;
  /** Replaces the built-in ignore with Undo, for a host that shows its own result. */
  onIgnoreChange?: (ignore: boolean) => void;
  onReasonChange?: ReasonChangeHandler;
  ignoreGate?: MutationGate;
  /** Replaces the remove dialog, for a host with its own removal flow. */
  onRemove?: () => void;
  removeGate?: MutationGate;
}

interface Local {
  installedVersion: string | null;
  repository: string | null;
  reason: string | null;
  syncVersion?: string;
}

async function readLocal(name: string, installedVersion: string | null | undefined, repository: string | null | undefined): Promise<Local> {
  try {
    const local = await getPackageInfo(name);
    return {
      installedVersion: installedVersion ?? local.version,
      repository: repository !== undefined ? repository : local.repository || null,
      reason: local.reason,
    };
  } catch (error) {
    if (!(error instanceof BackendError) || error.code !== "not_found") throw error;
    if (installedVersion) return { installedVersion, repository: repository ?? null, reason: null };
    try {
      const sync = await getSyncPackageInfo(name, repository ?? undefined);
      return { installedVersion: null, repository: sync.repository || null, reason: null, syncVersion: sync.version };
    } catch (error) {
      if (!(error instanceof BackendError) || error.code !== "not_found") throw error;
      return { installedVersion: null, repository: null, reason: null };
    }
  }
}

// Mount only while the menu is open to avoid requests and subscriptions for closed rows.
const RowActionItems: React.FC<PackageRowActionsProps & { host: RowActionsHost; anchor: () => HTMLElement | null }> = ({
  host,
  anchor,
  name,
  installedVersion,
  repository,
  syncVersion,
  ignored: ignoredProp,
  reason: reasonProp,
  downgradeTo,
  onViewDetails,
  onViewDependencies: onViewDependenciesProp,
  onViewHistory: onViewHistoryProp,
  onIgnoreChange,
  onReasonChange,
  ignoreGate,
  onRemove,
  removeGate,
}) => {
  const nav = useNavigation();
  const downgrade = useDowngrade();
  const transaction = useActiveTransaction();
  const onViewDependencies = onViewDependenciesProp ?? nav.onViewDependencies;
  const onViewHistory = onViewHistoryProp ?? nav.onViewHistory;
  const skipLocal = installedVersion === null || (installedVersion !== undefined && repository !== undefined && reasonProp !== undefined);
  const localKey = JSON.stringify({ name, installedVersion, repository, skipLocal });
  const [localRead, setLocalRead] = useState<{ key: string; value?: Local; error?: LoadFailure } | null>(null);
  const local = localRead?.key === localKey ? localRead.value ?? null : null;
  const localError = localRead?.key === localKey ? localRead.error ?? null : null;
  const [fetchedIgnored, setFetchedIgnored] = useState<boolean | undefined>(undefined);
  const [syncRead, setSyncRead] = useState<{ key: string; version: string | null } | null>(null);

  useEffect(() => {
    if (skipLocal) return;
    let cancelled = false;
    readLocal(name, installedVersion, repository).then(
      (value) => { if (!cancelled) setLocalRead({ key: localKey, value }); },
      (error) => {
        if (cancelled) return;
        setLocalRead({ key: localKey, error: toLoadFailure(error) });
        host.reportError(`Could not read ${name}`, error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [skipLocal, name, installedVersion, repository, host, localKey]);

  const shownInstalled = installedVersion !== undefined ? installedVersion : local?.installedVersion;
  const shownRepository = repository !== undefined ? repository : local ? local.repository : undefined;
  const hostSync = syncVersion ?? local?.syncVersion;
  const syncKey = JSON.stringify([name, shownRepository]);
  const fetchedSync = syncRead?.key === syncKey ? syncRead.version : undefined;
  const needsSync = !!shownInstalled && !!shownRepository && hostSync === undefined;
  useEffect(() => {
    if (!needsSync) return;
    let cancelled = false;
    readSyncVersion(name, shownRepository ?? undefined).then((v) => {
      if (!cancelled) setSyncRead({ key: syncKey, version: v });
    });
    return () => {
      cancelled = true;
    };
  }, [needsSync, name, shownRepository, syncKey]);

  const isInstalled = !!shownInstalled;
  useEffect(() => {
    if (ignoredProp !== undefined || !isInstalled) return;
    let cancelled = false;
    listIgnoredPackages().then(
      (r) => { if (!cancelled) setFetchedIgnored((r.packages ?? []).includes(name)); },
      () => { if (!cancelled) setFetchedIgnored(false); },
    );
    return () => {
      cancelled = true;
    };
  }, [ignoredProp, isInstalled, name]);

  const ignored = ignoredProp ?? fetchedIgnored;
  const version = shownInstalled ?? "";
  const verbs = packageVerbs({
    name,
    installedVersion: shownInstalled,
    repository: shownRepository,
    syncVersion: hostSync ?? fetchedSync,
    ignored,
    reason: reasonProp ?? (local ? local.reason : undefined),
    canDowngrade: !!downgrade,
    downgradeTo,
    gate: (action: string) => mutationGate(action, host.permission, transaction),
    ignoreGate,
    removeGate,
    on: {
      viewDetails: onViewDetails,
      viewDependencies: onViewDependencies && (() => onViewDependencies(name)),
      viewHistory: onViewHistory && (() => onViewHistory(name)),
      setIgnored: (ignore) => (onIgnoreChange ? onIgnoreChange(ignore) : host.changeIgnore(name, ignore)),
      setReason: (reason) => host.changeReason(name, reason, onReasonChange),
      reinstall: () => host.openDialog({ kind: "reinstall", name, version, repository: shownRepository ?? undefined }, anchor()),
      downgrade: (preselectVersion) => downgrade?.open({ name, version, preselectVersion }),
      install: () => host.openDialog({ kind: "install", name, version: hostSync ?? fetchedSync ?? "", repository: shownRepository ?? undefined }, anchor()),
      remove: () => (onRemove ? onRemove() : host.openDialog({ kind: "remove", name, version }, anchor())),
    },
  });
  return <PackageVerbMenuItems verbs={localError ? verbs.map((verb) => verb.group === "view" ? verb : {
    ...verb,
    disabledReason: `Could not read ${name}: ${localError.message}`,
    pending: false,
  }) : verbs} />;
};

/** Package actions; blocked items stay focusable to explain their restrictions. */
export const PackageRowActions: React.FC<PackageRowActionsProps> = (props) => {
  const host = useContext(RowActionsContext);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const anchor = useCallback(() => wrapperRef.current, []);
  if (!host) {
    return (
      <PackageRowActionsProvider>
        <PackageRowActions {...props} />
      </PackageRowActionsProvider>
    );
  }
  return (
    <div
      ref={wrapperRef}
      onClick={(event) => kebabEvents.add(event.nativeEvent)}
      // The row consumes Enter/Space, so keep toggle activation inside the menu.
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      <Dropdown
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        onSelect={() => setIsOpen(false)}
        shouldFocusToggleOnSelect
        popperProps={{ position: "right" }}
        toggle={kebabToggle(`Actions for ${props.name}`, isOpen, () => setIsOpen((open) => !open))}
      >
        <DropdownList>
          {isOpen && <RowActionItems {...props} host={host} anchor={anchor} />}
        </DropdownList>
      </Dropdown>
    </div>
  );
};

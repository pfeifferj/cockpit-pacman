import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useTabActive } from "../hooks/useRefreshOnActivate";
import { mutationGate, useActiveTransaction } from "../hooks/useMutationGate";
import { GatedButton } from "./GatedButton";
import { UndoLink } from "./UndoAlert";
import {
	Spinner,
	DescriptionList,
	DescriptionListGroup,
	DescriptionListTerm,
	DescriptionListDescription,
	Title,
	Label,
	LabelGroup,
	Button,
	EmptyState,
	EmptyStateBody,
	EmptyStateFooter,
	EmptyStateActions,
	Alert,
	AlertActionLink,
	AlertGroup,
	List,
	ListItem,
	Dropdown,
	DropdownList,
	MenuToggle,
	Flex,
	FlexItem,
} from '@patternfly/react-core';
import { ArrowLeftIcon, ExclamationCircleIcon, BanIcon } from "@patternfly/react-icons";
import {
  BackendError,
  type ErrorCode,
  PackageDetails,
  SyncPackageDetails,
  SecurityInfoResponse,
  InstallReason,
  formatSize,
  addIgnoredPackage,
  removeIgnoredPackage,
  listIgnoredPackages,
  getSecurityInfo,
  getPackageInfo,
  getSyncPackageInfo,
  setInstallReason,
} from "../api";
import { ErrorDetails } from "./ErrorDetails";
import { ErrorAlert } from "./ErrorAlert";
import { toLoadFailure, type LoadFailure } from "./LoadErrorState";
import { severityColor } from "../severity";
import { TimeAgo } from "./TimeAgo";
import { HelpPopover } from "./HelpPopover";
import { errorText, ignoreNotice, plural, sanitizeUrl, sanitizeErrorMessage } from "../utils";
import { vercmp } from "../vercmp";
import { useDowngrade } from "../contexts/DowngradeContext";
import { PackageActionModal, installConfig, reinstallConfig, uninstallConfig } from "./PackageActionModal";
import { PackageVerbMenuItems, packageVerbs, readSyncVersion, reasonPhrase, type PackageVerb } from "./packageVerbs";
import { useNavigation } from "../contexts/NavigationContext";

type PackageInfo = PackageDetails | SyncPackageDetails;

function isInstalledPackage(pkg: PackageInfo): pkg is PackageDetails {
  return "install_date" in pkg && "reason" in pkg && "validation" in pkg;
}

/** Package name of an optdepends entry such as "python-foo>=1.2: for bar". */
export function optdepName(entry: string): string {
  return entry.split(":")[0].split(/[<>=]/)[0].trim();
}

type Target = { name: string; version: string; repository?: string };

interface Notice {
  name: string;
  title: string;
  undo?: () => void;
  orphan?: boolean;
}

const HIGHLIGHT_MS = 2000;

const SPINNER_DELAY_MS = 1000;

let optdepRequests = 0;

const activePanelId = () =>
  document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')?.id ?? null;

async function readPackage(name: string, repo?: string | null): Promise<PackageInfo> {
  try {
    return await getPackageInfo(name);
  } catch (error) {
    if (!(error instanceof BackendError) || error.code !== "not_found") throw error;
    return await getSyncPackageInfo(name, repo ?? undefined);
  }
}

const PackageSecuritySection: React.FC<{ name: string; headingLevel: "h2" | "h3" }> = ({ name, headingLevel }) => {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [info, setInfo] = useState<SecurityInfoResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSecurityInfo(name)
      .then((r) => { if (!cancelled) { setInfo(r); setState("ready"); } })
      .catch((e) => {
        if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setState("error"); }
      });
    return () => { cancelled = true; };
  }, [name]);

  if (state === "loading") {
    return <Spinner size="md" aria-label="Loading advisories" className="pf-v6-u-mt-md" />;
  }
  if (state === "error") {
    return (
      <p className="pf-v6-u-mt-md pf-v6-u-color-200">
        Could not load security advisories: {sanitizeErrorMessage(err)}
      </p>
    );
  }
  if (!info || info.disabled || (!info.advisories.length && !info.groups.length && !info.issues.length)) {
    return null;
  }

  const section = <T extends { name: string; severity: string }>(
    term: string,
    items: T[],
    label: (item: T) => string,
  ) =>
    items.length > 0 && (
      <DescriptionListGroup>
        <DescriptionListTerm>{term}</DescriptionListTerm>
        <DescriptionListDescription>
          <LabelGroup numLabels={10}>
            {items.map((x) => (
              <Label key={x.name} isCompact color={severityColor(x.severity)}>
                {label(x)}
              </Label>
            ))}
          </LabelGroup>
        </DescriptionListDescription>
      </DescriptionListGroup>
    );

  return (
    <section aria-label="Security advisories" className="pf-v6-u-mt-md">
      <Title headingLevel={headingLevel} size="md" className="pf-v6-u-mb-sm">Security advisories</Title>
      <DescriptionList isCompact>
        {section("Advisories", info.advisories, (a) => `${a.name} (${a.severity}, ${a.date})`)}
        {section("Groups", info.groups, (g) => `${g.name} (${g.status})`)}
        {section("Issues", info.issues, (i) => `${i.name} (${i.issue_type}, ${i.status})`)}
      </DescriptionList>
    </section>
  );
};

export interface PackageDetailsPanelProps {
  packageDetails: PackageInfo | null;
  isLoading: boolean;
  onClose: () => void;
  error?: string | null;
  errorCode?: ErrorCode;
  errorDetails?: string;
  onViewDependencies?: (packageName: string) => void;
  onViewHistory?: (packageName: string) => void;
  onPackageRemoved?: () => void;
  onPackageInstalled?: () => void;
  isIgnored?: boolean;
  onIgnored?: () => void;
  isRemoved?: boolean;
  /** Repository version of the shown package; undefined is read from the sync databases. */
  syncVersion?: string | null;
}

export interface PackageDetailsFrame {
  /** The frame is hidden while an action dialog launched from the panel is open (a modal frame). */
  hidesUnderChild: boolean;
  menuAppendTo: () => HTMLElement;
  actionsAtTop?: boolean;
  onUserClose?: () => void;
  /** One heading level below the frame title. */
  headingLevel: "h2" | "h3";
}

export interface PackageDetailsParts {
  title: React.ReactNode;
  body: React.ReactNode;
  footer: React.ReactNode | null;
  notices: React.ReactNode | null;
  name: string | undefined;
  isBusy: boolean;
  /** Action dialogs; render them outside the frame so they outlive it. */
  overlays: React.ReactNode;
  isRequested: boolean;
  isShown: boolean;
  inOptdep: boolean;
  back: () => void;
  close: () => void;
}

/** Package details and actions shared by modal and drawer frames. */
export function usePackageDetailsPanel({
  packageDetails,
  isLoading,
  onClose,
  error,
  errorCode,
  errorDetails,
  onViewDependencies: onViewDependenciesProp,
  onViewHistory: onViewHistoryProp,
  onPackageRemoved,
  onPackageInstalled,
  isIgnored,
  onIgnored,
  isRemoved,
  syncVersion: syncVersionProp,
}: PackageDetailsPanelProps, { hidesUnderChild, menuAppendTo, actionsAtTop, onUserClose, headingLevel }: PackageDetailsFrame): PackageDetailsParts {
  const nav = useNavigation();
  const downgrade = useDowngrade();
  const onViewDependencies = onViewDependenciesProp ?? nav.onViewDependencies;
  const onViewHistory = onViewHistoryProp ?? nav.onViewHistory;
  const [uninstallTarget, setUninstallTarget] = useState<Target | null>(null);
  const [installTarget, setInstallTarget] = useState<Target | null>(null);
  const [reinstallTarget, setReinstallTarget] = useState<Target | null>(null);
  const [downgradeFrom, setDowngradeFrom] = useState<(Target & { panel: string | null }) | null>(null);
  const [readBack, setReadBack] = useState<(Target & { panel: string | null }) | null>(null);
  const [actionError, setActionError] = useState<(LoadFailure & { name: string; title: string }) | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [highlight, setHighlight] = useState<{ name: string; field: "reason" | "ignore" } | null>(null);
  const [fresh, setFresh] = useState<Record<string, PackageInfo>>({});
  const [localIgnore, setLocalIgnore] = useState<Record<string, boolean>>({});
  const [fetchedIgnore, setFetchedIgnore] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"ignore" | "reason" | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Tie optional-dependency reads to the panel showing that requested them.
  const [optdep, setOptdep] = useState<{ name: string; details: PackageInfo | null; error: string | null; code?: ErrorCode; context?: string; request: number } | null>(null);
  const returnFocusTo = useRef<string | null>(null);
  const backRef = useRef<React.ComponentRef<"button">>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const canAdminister = useAdminPermission();
  const transaction = useActiveTransaction();
  const detailsRequested = packageDetails !== null || isLoading || !!error;
  const childOpen = !!(installTarget || reinstallTarget || uninstallTarget || downgrade?.isOpen);
  const tabActive = useTabActive();
  const isOpen = detailsRequested && tabActive && !(hidesUnderChild && childOpen);
  const reduceMotion = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const sessionKey = detailsRequested ? packageDetails?.name ?? "" : null;
  const [session, setSession] = useState(sessionKey);
  if (session !== sessionKey) {
    setSession(sessionKey);
    // An Undo outlives a switch to another package, so the change can still be reverted from there.
    setNotice((n) => (n?.undo && sessionKey !== null ? n : null));
    setActionError(null);
    setFresh({});
    setLocalIgnore({});
    setHighlight(null);
    setOptdep(null);
    setDowngradeFrom(null);
    setReadBack(null);
  }

  const [syncRead, setSyncRead] = useState<{ key: string; version: string | null } | null>(null);
  const [freshBase, setFreshBase] = useState(packageDetails);
  if (freshBase !== packageDetails) {
    setFreshBase(packageDetails);
    setFresh({});
    setSyncRead(null);
  }

  const [loadGen, setLoadGen] = useState(0);
  const [wasLoading, setWasLoading] = useState(isLoading);
  if (wasLoading !== isLoading) {
    setWasLoading(isLoading);
    if (isLoading) setLoadGen((g) => g + 1);
  }
  const [slowGen, setSlowGen] = useState(-1);
  useEffect(() => {
    if (!isLoading) return;
    const timer = setTimeout(() => setSlowGen(loadGen), SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isLoading, loadGen]);
  const rootSpinner = isLoading && (!packageDetails || slowGen === loadGen);

  const rootName = packageDetails?.name;
  const rootDetails: PackageInfo | null = packageDetails && (fresh[packageDetails.name] ?? packageDetails);
  const details: PackageInfo | null = optdep
    ? optdep.details && (fresh[optdep.details.name] ?? optdep.details)
    : rootDetails;
  const shownLoading = optdep ? !optdep.details && !optdep.error : rootSpinner;
  const isBusy = !optdep && isLoading;
  const shownError = optdep ? optdep.error : error;
  const shownErrorCode = optdep ? optdep.code : errorCode;
  const shownErrorContext = optdep ? optdep.context : errorDetails;
  const isInstalled = details && isInstalledPackage(details);
  const name = details?.name;
  const otherInstalledVersion = details && !isInstalledPackage(details) && details.installed_version !== details.version
    ? details.installed_version
    : undefined;

  const hostKnowsIgnore = optdep === null && isIgnored !== undefined;
  const fetchedForName = name !== undefined ? fetchedIgnore[name] : undefined;
  useEffect(() => {
    if (hostKnowsIgnore || !name || fetchedForName !== undefined) return;
    let cancelled = false;
    listIgnoredPackages()
      .then((r) => { if (!cancelled) setFetchedIgnore((m) => ({ ...m, [name]: (r.packages ?? []).includes(name) })); })
      .catch(() => { if (!cancelled) setFetchedIgnore((m) => ({ ...m, [name]: false })); });
    return () => { cancelled = true; };
  }, [name, hostKnowsIgnore, fetchedForName]);

  const repository = details?.repository || null;
  const hostSync = optdep === null ? syncVersionProp : undefined;
  const syncKey = isInstalled && repository && hostSync === undefined ? `${details.name}\0${repository}` : null;
  const readSync = syncKey !== null && syncRead?.key === syncKey ? syncRead.version : undefined;
  useEffect(() => {
    if (syncKey === null || readSync !== undefined || !name || !repository) return;
    let cancelled = false;
    readSyncVersion(name, repository).then((version) => {
      if (!cancelled) setSyncRead({ key: syncKey, version });
    });
    return () => { cancelled = true; };
  }, [syncKey, readSync, name, repository]);

  const ignored = name === undefined
    ? undefined
    : localIgnore[name] ?? (hostKnowsIgnore ? isIgnored : fetchedForName);
  const ignoredRef = useRef<Record<string, boolean | undefined>>({});
  useEffect(() => {
    if (name !== undefined) ignoredRef.current[name] = ignored;
  });

  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  useEffect(() => {
    if (notice && isOpen) noticeRef.current?.scrollIntoView?.({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }, [notice, isOpen, reduceMotion]);

  const shownOptdep = optdep?.name;
  useEffect(() => {
    if (shownOptdep !== undefined) backRef.current?.focus();
  }, [shownOptdep]);

  useEffect(() => {
    const target = returnFocusTo.current;
    if (optdep !== null || target === null) return;
    returnFocusTo.current = null;
    Array.from(document.querySelectorAll<HTMLElement>("[data-optdep]"))
      .find((el) => el.dataset.optdep === target)
      ?.focus();
  }, [optdep]);

  const gateFor = (action: string) => mutationGate(action, canAdminister, transaction);
  const busyReason = busy === "ignore"
    ? `${ignored ? "Unignoring" : "Ignoring"} ${name}…`
    : busy === "reason" ? `Changing the install reason of ${name}…` : undefined;
  const undoBlockedReason = busy === "ignore"
    ? `Wait for ${ignored ? "unignoring" : "ignoring"} ${name} to finish`
    : busy === "reason" ? `Wait for the install reason change of ${name} to finish` : undefined;

  const refreshAfter = async (pkg: string, title: string) => {
    const reads = [pkg];
    if (packageDetails && packageDetails.name !== pkg) reads.push(packageDetails.name);
    const results = await Promise.all(reads.map((n) =>
      readPackage(n, n === packageDetails?.name ? packageDetails.repository : undefined).catch(() => null)));
    setFresh((m) => {
      const next = { ...m };
      results.forEach((r) => { if (r) next[r.name] = r; });
      return next;
    });
    setNotice({ name: pkg, title });
  };

  const changeReason = async (target: PackageDetails, reason: InstallReason, isUndo: boolean) => {
    setActionError(null);
    setBusy("reason");
    try {
      const result = await setInstallReason(target.name, reason);
      const next = await getPackageInfo(target.name).catch(() => ({ ...target, reason: result.reason }));
      setFresh((m) => ({ ...m, [target.name]: next }));
      setHighlight({ name: target.name, field: "reason" });
      setNotice({
        name: target.name,
        title: `${target.name} is now marked as ${reasonPhrase(result.reason)}`,
        undo: isUndo ? undefined : () => changeReason(next, result.previous, true),
        orphan: result.reason === "dependency" && next.required_by.length === 0 && next.optional_for.length === 0,
      });
    } catch (err) {
      setActionError({ name: target.name, title: `Could not change the install reason of ${target.name}`, ...toLoadFailure(err) });
    } finally {
      setBusy(null);
    }
  };

  const ignoreChanged = (pkg: string, ignore: boolean) => {
    setLocalIgnore((m) => ({ ...m, [pkg]: ignore }));
    setFetchedIgnore((m) => (pkg in m ? { ...m, [pkg]: ignore } : m));
    setHighlight({ name: pkg, field: "ignore" });
    if (pkg === rootName) onIgnored?.();
  };

  const changeIgnore = async (pkg: string, ignore: boolean, isUndo: boolean) => {
    setActionError(null);
    setBusy("ignore");
    try {
      if (ignore) {
        await addIgnoredPackage(pkg);
      } else {
        await removeIgnoredPackage(pkg);
      }
      ignoreChanged(pkg, ignore);
      setNotice({
        name: pkg,
        title: ignoreNotice(pkg, ignore),
        undo: isUndo ? undefined : () => changeIgnore(pkg, !ignore, true),
      });
    } catch (err) {
      setActionError({ name: pkg, title: ignore ? `Could not ignore ${pkg}` : `Could not unignore ${pkg}`, ...toLoadFailure(err) });
    } finally {
      setBusy(null);
    }
  };

  const openOptdep = async (entry: string) => {
    const target = optdepName(entry);
    const request = ++optdepRequests;
    if (!optdep) returnFocusTo.current = target;
    setOptdep({ name: target, details: null, error: null, request });
    let result: { details: PackageInfo | null; error: string | null; code?: ErrorCode; context?: string };
    try {
      result = { details: await readPackage(target), error: null };
    } catch (err) {
      result = { details: null, error: errorText(err), code: err instanceof BackendError ? err.code : undefined, context: err instanceof BackendError ? err.details : undefined };
    }
    setOptdep((current) => (current?.request === request ? { ...current, ...result } : current));
  };

  const backToRoot = () => {
    setOptdep(null);
  };

  const leaveAll = () => {
    setOptdep(null);
    onClose();
  };

  const shownTarget = (): Target | null => (details ? { name: details.name, version: details.version, repository: details.repository ?? undefined } : null);

  const handleDowngrade = () => {
    if (!details || !isInstalledPackage(details) || !downgrade || downgrade.isOpen) return;
    const from = { name: details.name, version: details.version, repository: details.repository ?? undefined };
    setDowngradeFrom({ ...from, panel: activePanelId() });
    downgrade.open(from);
  };

  const downgradeOpen = downgrade?.isOpen ?? false;
  const [wasDowngradeOpen, setWasDowngradeOpen] = useState(downgradeOpen);
  if (wasDowngradeOpen !== downgradeOpen) {
    setWasDowngradeOpen(downgradeOpen);
    if (!downgradeOpen && downgradeFrom) {
      setReadBack(downgradeFrom);
      setDowngradeFrom(null);
    }
  }
  useLayoutEffect(() => {
    if (!readBack || activePanelId() !== readBack.panel) return;
    let cancelled = false;
    Promise.all([getPackageInfo(readBack.name), listIgnoredPackages().catch(() => null)]).then(
      ([next, ignoredList]) => {
        if (cancelled) return;
        setReadBack(null);
        setFresh((m) => ({ ...m, [next.name]: next }));
        const nowIgnored = ignoredList?.packages?.includes(readBack.name);
        if (nowIgnored !== undefined && nowIgnored !== ignoredRef.current[readBack.name]) ignoreChanged(readBack.name, nowIgnored);
        if (next.version !== readBack.version) {
          const verb = vercmp(next.version, readBack.version) < 0 ? "downgraded" : "upgraded";
          setNotice({ name: readBack.name, title: `${readBack.name} ${verb} to ${next.version}` });
        }
      },
      () => {
        if (!cancelled) setReadBack(null);
      },
    );
    return () => {
      cancelled = true;
    };
    // ignoreChanged is recreated every render; the read runs once per closed dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readBack]);

  const handleUninstall = () => {
    if (!details) return;
    setUninstallTarget(shownTarget());
    leaveAll();
  };

  const handleReinstall = () => setReinstallTarget(shownTarget());
  const handleInstall = () => setInstallTarget(shownTarget());

  const verbs: PackageVerb[] = details ? packageVerbs({
    name: details.name,
    installedVersion: isInstalled ? details.version : null,
    repository,
    syncVersion: hostSync !== undefined ? hostSync : readSync,
    ignored,
    reason: isInstalled ? details.reason : null,
    canDowngrade: !!downgrade,
    gate: gateFor,
    busyReason,
    on: {
      viewDependencies: onViewDependencies && (() => {
        onViewDependencies(details.name);
        leaveAll();
      }),
      viewHistory: onViewHistory && (() => {
        onViewHistory(details.name);
        leaveAll();
      }),
      setIgnored: (ignore) => changeIgnore(details.name, ignore, false),
      setReason: (reason) => { if (isInstalled) changeReason(details, reason, false); },
      reinstall: handleReinstall,
      downgrade: handleDowngrade,
      install: handleInstall,
      remove: handleUninstall,
    },
  }) : [];
  const viewVerbs = verbs.filter((v) => v.group === "view");
  const menuVerbs = verbs.filter((v) => v.group === "mutate" && v.id !== "install");
  const installVerb = verbs.find((v) => v.id === "install");
  const removeVerb = verbs.find((v) => v.id === "remove");

  const highlightStyle = (on: boolean): React.CSSProperties => ({
    display: "inline-block",
    borderRadius: "var(--pf-t--global--border--radius--small)",
    outline: "2px solid",
    outlineOffset: "2px",
    outlineColor: on ? "var(--pf-t--global--border--color--status--warning--default)" : "transparent",
    transition: reduceMotion ? undefined : "outline-color 0.3s ease-in-out",
  });
  const highlighted = (field: "reason" | "ignore") => highlight !== null && highlight.name === name && highlight.field === field;
  const title = (
        details
          ? <>{details.name} <Label isCompact variant="outline">{details.version}</Label> <Label isCompact color="grey">{details.repository || "user"}</Label>{otherInstalledVersion && <> <Label isCompact variant="outline" color="blue">Installed: {otherInstalledVersion}</Label></>}{isInstalled && !details.repository && " "}{isInstalled && !details.repository && (
              <HelpPopover
                label="user package"
                header="User package"
                body="This package is not from an official repository. It may have been installed from the AUR, built manually with makepkg, or installed from a local PKGBUILD."
              />
            )}</>
          : (shownError ? "Package details" : "Loading…")
  );

  const body = (
      <>
        {optdep && rootName && (
          <Button
            ref={backRef}
            variant="link"
            isInline
            icon={<ArrowLeftIcon />}
            aria-label={`Back to ${rootName}`}
            onClick={backToRoot}
            className="pf-v6-u-mb-md"
          >
            {rootName}
          </Button>
        )}
        {shownLoading ? (
          <Spinner />
        ) : shownError && isRemoved && !optdep ? (
          <EmptyState headingLevel={headingLevel} icon={ExclamationCircleIcon} titleText={shownError}>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={onUserClose ?? leaveAll}>Close</Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : shownError && !details ? (
          <EmptyState headingLevel={headingLevel} icon={ExclamationCircleIcon} titleText={shownErrorCode === "not_found" ? "Package not found" : "Could not load package details"}>
            <EmptyStateBody>
              {sanitizeErrorMessage(shownError)}
              <ErrorDetails details={shownErrorContext} />
            </EmptyStateBody>
          </EmptyState>
        ) : details ? (
          <>
          {shownError && (
            <Alert component={headingLevel} variant="warning" isInline title="Could not refresh package details" className="pf-v6-u-mb-md">
              {sanitizeErrorMessage(shownError)}
              <ErrorDetails details={shownErrorContext} />
            </Alert>
          )}
          {viewVerbs.length > 0 && (
            <Flex className="pf-v6-u-mb-md">
              {viewVerbs.map((verb) => (
                <FlexItem key={verb.id}>
                  <Button variant="link" isInline icon={verb.icon} onClick={verb.run}>
                    {verb.label}
                  </Button>
                </FlexItem>
              ))}
            </Flex>
          )}
          <DescriptionList>


          <DescriptionListGroup>
            <DescriptionListTerm>Description</DescriptionListTerm>
            <DescriptionListDescription>
              {details.description || "-"}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {(() => {
            const safeUrl = sanitizeUrl(details.url);
            return safeUrl ? (
              <DescriptionListGroup>
                <DescriptionListTerm>URL</DescriptionListTerm>
                <DescriptionListDescription>
                  <a href={safeUrl} target="_blank" rel="noopener noreferrer">
                    {safeUrl}
                  </a>
                </DescriptionListDescription>
              </DescriptionListGroup>
            ) : null;
          })()}

          {details.repository && ["core", "extra", "multilib"].includes(details.repository) && (
            <DescriptionListGroup>
              <DescriptionListTerm>Package source</DescriptionListTerm>
              <DescriptionListDescription>
                <a
                  href={`https://gitlab.archlinux.org/archlinux/packaging/packages/${encodeURIComponent(details.name)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Arch GitLab
                </a>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {details.licenses.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Licenses</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup>
                  {details.licenses.map((license: string) => (
                    <Label
                      key={license}
                      render={({ className, content, componentRef }) => (
                        <a
                          ref={componentRef}
                          className={className}
                          href={`https://spdx.org/licenses/${encodeURIComponent(license)}.html`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {content}
                        </a>
                      )}
                    >
                      {license}
                    </Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {details.groups.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>
                Groups{" "}
                <HelpPopover
                  label="package groups"
                  header="Package groups"
                  body="Named collections of related packages. Installing a group (e.g. 'base-devel') installs all its members at once. Membership is defined by the packager, not by dependencies."
                />
              </DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup>
                  {details.groups.map((g: string) => (
                    <Label key={g} color="teal">{g}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          <DescriptionListGroup>
            <DescriptionListTerm>
              Architecture{" "}
              <HelpPopover
                label="package architecture"
                header="Package architecture"
                body="The CPU architecture this package was built for. 'x86_64' is compiled native code. 'any' means the package is architecture-independent (scripts, data, fonts, etc.)."
              />
            </DescriptionListTerm>
            <DescriptionListDescription>
              {details.architecture || "any"}
            </DescriptionListDescription>
          </DescriptionListGroup>


          {!isInstalled && "download_size" in details && (
            <DescriptionListGroup>
              <DescriptionListTerm>Download size</DescriptionListTerm>
              <DescriptionListDescription>
                {formatSize(details.download_size)}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          <DescriptionListGroup>
            <DescriptionListTerm>Installed size</DescriptionListTerm>
            <DescriptionListDescription>
              {formatSize(details.installed_size)}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {ignored !== undefined && (
            <DescriptionListGroup>
              <DescriptionListTerm>Upgrades</DescriptionListTerm>
              <DescriptionListDescription>
                <span style={highlightStyle(highlighted("ignore"))} data-highlighted={highlighted("ignore") || undefined}>
                  {ignored
                    ? <Label color="orange" icon={<BanIcon />}>Ignored</Label>
                    : <Label variant="outline">Included</Label>}
                </span>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          <DescriptionListGroup>
            <DescriptionListTerm>Build date</DescriptionListTerm>
            <DescriptionListDescription>
              <TimeAgo timestamp={details.build_date} />
            </DescriptionListDescription>
          </DescriptionListGroup>

          {isInstalled && (
            <>
              <DescriptionListGroup>
                <DescriptionListTerm>Install date</DescriptionListTerm>
                <DescriptionListDescription>
                  <TimeAgo timestamp={details.install_date} />
                </DescriptionListDescription>
              </DescriptionListGroup>

              <DescriptionListGroup>
                <DescriptionListTerm>
                  Install reason{" "}
                  <HelpPopover
                    label="install reason"
                    header="Install reason"
                    body="'Explicit' means you installed this package directly. 'Dependency' means it was pulled in as a requirement of another package. Dependencies no longer required by anything become orphans."
                  />
                </DescriptionListTerm>
                <DescriptionListDescription>
                  <span style={highlightStyle(highlighted("reason"))} data-highlighted={highlighted("reason") || undefined}>
                    <Label color={details.reason === "explicit" ? "blue" : "grey"}>
                      {details.reason}
                    </Label>
                  </span>
                </DescriptionListDescription>
              </DescriptionListGroup>
            </>
          )}


          {isInstalled && details.update_stats && (
            <>
              <DescriptionListGroup>
                <DescriptionListTerm>Updates</DescriptionListTerm>
                <DescriptionListDescription>
                  {details.update_stats.update_count === 0
                    ? "Never updated"
                    : plural(details.update_stats.update_count, "update")}
                  {details.update_stats.avg_days_between_updates !== null && (
                    <> (avg. every {details.update_stats.avg_days_between_updates.toFixed(0)} days)</>
                  )}
                </DescriptionListDescription>
              </DescriptionListGroup>

              {details.update_stats.first_installed && (
                <DescriptionListGroup>
                  <DescriptionListTerm>First installed</DescriptionListTerm>
                  <DescriptionListDescription>
                    <TimeAgo timestamp={details.update_stats.first_installed} />
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}

              {details.update_stats.last_updated && (
                <DescriptionListGroup>
                  <DescriptionListTerm>Last updated</DescriptionListTerm>
                  <DescriptionListDescription>
                    <TimeAgo timestamp={details.update_stats.last_updated} />
                  </DescriptionListDescription>
                </DescriptionListGroup>
              )}
            </>
          )}


          {details.depends.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Dependencies</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {details.depends.map((dep: string) => (
                    <Label key={dep} variant="outline">{dep}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {details.optdepends.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Optional dependencies</DescriptionListTerm>
              <DescriptionListDescription>
                <List isPlain>
                  {details.optdepends.map((dep: string) => {
                    const depName = optdepName(dep);
                    const rest = dep.slice(dep.indexOf(depName) + depName.length);
                    return (
                      <ListItem key={dep}>
                        <Button variant="link" isInline data-optdep={depName} onClick={() => openOptdep(dep)}>
                          {depName}
                        </Button>
                        {rest}
                        {details.installed_optdepends?.includes(depName) && (
                          <>{" "}<Label isCompact color="green">installed</Label></>
                        )}
                      </ListItem>
                    );
                  })}
                </List>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {details.provides.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>
                Provides{" "}
                <HelpPopover
                  label="virtual packages"
                  header="Virtual packages"
                  body="Other package names that this package satisfies. If another package depends on a name listed here, this package fulfills that dependency."
                />
              </DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {details.provides.map((p: string) => (
                    <Label key={p} variant="outline" color="green">{p}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {details.conflicts.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>
                Conflicts{" "}
                <HelpPopover
                  label="package conflicts"
                  header="Package conflicts"
                  body="Packages that cannot be installed alongside this one. Pacman will refuse to install both simultaneously and will prompt you to remove the conflicting package."
                />
              </DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {details.conflicts.map((c: string) => (
                    <Label key={c} variant="outline" color="orange">{c}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {details.replaces.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>
                Replaces{" "}
                <HelpPopover
                  label="package replacement"
                  header="Package replacement"
                  body="Packages that this one supersedes. During a system upgrade, pacman will automatically remove the listed packages and install this one instead."
                />
              </DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {details.replaces.map((r: string) => (
                    <Label key={r} variant="outline" color="orange">{r}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {isInstalled && details.required_by.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Required by</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {details.required_by.map((r: string) => (
                    <Label key={r} variant="outline" color="purple">{r}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {isInstalled && details.optional_for.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Optional for</DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup numLabels={10}>
                  {details.optional_for.map((o: string) => (
                    <Label key={o} variant="outline" color="grey">{o}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}


          {isInstalled && details.packager && (
            <DescriptionListGroup>
              <DescriptionListTerm>Packager</DescriptionListTerm>
              <DescriptionListDescription>
                {details.packager}{" "}
                {details.packager === "Unknown Packager" && (
                  <HelpPopover
                    label="unknown packager"
                    header="Unknown packager"
                    body={'This package was built locally without a PACKAGER configured in makepkg.conf. This is common for AUR packages. To set your packager identity, add PACKAGER="Your Name <email>" to ~/.makepkg.conf'}
                  />
                )}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {isInstalled && details.validation.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>
                Validation{" "}
                <HelpPopover
                  label="package validation"
                  header="Package validation"
                  body="How this package was verified at install time. PGP means its signature was checked against the pacman keyring. SHA256 means file integrity was verified via hash. 'none' means no verification was performed."
                />
              </DescriptionListTerm>
              <DescriptionListDescription>
                <LabelGroup>
                  {details.validation.map((v: string) => (
                    <Label key={v} variant="outline">{v}</Label>
                  ))}
                </LabelGroup>
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}

          </DescriptionList>
          <PackageSecuritySection key={details.name} name={details.name} headingLevel={headingLevel} />
          </>
        ) : null}
      </>
  );

  const notices = details && !shownLoading ? (
    <div ref={noticeRef}>
      {actionError?.name === details.name && (
        <ErrorAlert
          headingLevel={headingLevel}
          isInline
          title={actionError.title}
          error={sanitizeErrorMessage(actionError.message)}
          code={actionError.code}
          details={actionError.details}
          className="pf-v6-u-mt-md"
        />
      )}
      <AlertGroup isLiveRegion className="pf-v6-u-mt-md">
        {notice && (notice.name === details.name || notice.undo) && (
          <Alert
            component={headingLevel}
            variant="success"
            isInline
            title={notice.title}
            actionLinks={(notice.undo || (notice.orphan && nav.onViewOrphans)) && (
              <>
                {notice.undo && (
                  <UndoLink label="Undo" reason={undoBlockedReason} onClick={notice.undo} />
                )}
                {notice.orphan && nav.onViewOrphans && (
                  <AlertActionLink
                    onClick={() => {
                      nav.onViewOrphans?.();
                      leaveAll();
                    }}
                  >
                    View orphans
                  </AlertActionLink>
                )}
              </>
            )}
          >
            {notice.orphan && "Nothing requires it, so it is now an orphan."}
          </Alert>
        )}
      </AlertGroup>
    </div>
  ) : null;

  const footer = details && !shownLoading ? (
        <>
          {installVerb && (
            <GatedButton
              gate={installVerb.gate}
              disabledReason={installVerb.disabledReason}
              variant="primary"
              icon={installVerb.icon}
              onClick={installVerb.run}
            >
              {installVerb.label}
            </GatedButton>
          )}
          {menuVerbs.length > 0 && (
            <Dropdown
              isOpen={actionsOpen}
              onOpenChange={setActionsOpen}
              onSelect={() => setActionsOpen(false)}
              shouldFocusToggleOnSelect
              popperProps={{ direction: actionsAtTop ? "down" : "up", appendTo: menuAppendTo }}
              toggle={(toggleRef) => (
                <MenuToggle
                  ref={toggleRef}
                  onClick={() => setActionsOpen((open) => !open)}
                  isExpanded={actionsOpen}
                  aria-busy={busy !== null || undefined}
                  icon={busy !== null ? <span aria-hidden="true"><Spinner size="sm" /></span> : undefined}
                >
                  Actions
                </MenuToggle>
              )}
            >
              <DropdownList>
                <PackageVerbMenuItems verbs={menuVerbs} />
              </DropdownList>
            </Dropdown>
          )}
          {removeVerb && (
            <div className="pf-v6-u-ml-auto">
              <GatedButton
                gate={removeVerb.gate}
                disabledReason={removeVerb.disabledReason}
                variant="secondary"
                isDanger
                icon={removeVerb.icon}
                onClick={removeVerb.run}
              >
                {removeVerb.label}
              </GatedButton>
            </div>
          )}
        </>
  ) : null;

  const overlays = (
    <>
    {uninstallTarget && (
      <PackageActionModal
        config={uninstallConfig}
        packageName={uninstallTarget.name}
        packageVersion={uninstallTarget.version}
        isOpen={true}
        onClose={() => setUninstallTarget(null)}
        onSuccess={onPackageRemoved}
      />
    )}
    {reinstallTarget && (
      <PackageActionModal
        config={reinstallConfig}
        packageName={reinstallTarget.name}
        packageVersion={reinstallTarget.version}
        packageRepository={reinstallTarget.repository}
        isOpen={true}
        onClose={() => setReinstallTarget(null)}
        onSuccess={() => {
          onPackageInstalled?.();
          void refreshAfter(reinstallTarget.name, `${reinstallTarget.name} reinstalled`);
        }}
      />
    )}
    {installTarget && (
      <PackageActionModal
        config={installConfig}
        packageName={installTarget.name}
        packageVersion={installTarget.version}
        packageRepository={installTarget.repository}
        isOpen={true}
        onClose={() => setInstallTarget(null)}
        onSuccess={() => {
          onPackageInstalled?.();
          void refreshAfter(installTarget.name, `${installTarget.name} installed`);
        }}
      />
    )}
    </>
  );

  return {
    title,
    body,
    footer,
    notices,
    name: details?.name,
    isBusy,
    overlays,
    isRequested: detailsRequested,
    isShown: isOpen,
    inOptdep: optdep !== null,
    back: backToRoot,
    close: leaveAll,
  };
}

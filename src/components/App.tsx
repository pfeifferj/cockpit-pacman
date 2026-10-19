import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Alert,
  AlertActionLink,
  Badge,
  Flex,
  FlexItem,
  Page,
  PageSection,
  Tabs,
  Tab,
  TabTitleText,
} from "@patternfly/react-core";
import { ExclamationTriangleIcon } from "@patternfly/react-icons";
import { UpdatesView, type UpdateStatus } from "./UpdatesView";
import { PackageList } from "./PackageList";
import { SearchView } from "./SearchView";
import { KeyringView } from "./KeyringView";
import { CacheView, type UpgradeSpaceNeed } from "./CacheView";
import { HistoryView } from "./HistoryView";
import { MirrorsView } from "./MirrorsView";
import { RepositoriesView } from "./RepositoriesView";
import { SignoffsView } from "./SignoffsView";
import { ErrorBoundary } from "./ErrorBoundary";
import { PackageJump, type InspectOptions, type JumpCommandHandlers, type JumpTab } from "./PackageJump";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { TransactionBanner, useTransactionAnnouncements } from "./TransactionBanner";
import { TransactionHost, TransactionHostProvider } from "./TransactionHost";
import { PackageDetailsModal } from "./PackageDetailsModal";
import { reasonPhrase } from "./packageVerbs";
import { usePackageDetails } from "../hooks/usePackageDetails";
import { useShortcuts } from "../hooks/useShortcuts";
import { useExternalLockWatch, useOwnTransactionRunning } from "../hooks/useMutationGate";
import { TabActiveContext } from "../hooks/useRefreshOnActivate";
import type { InstallReason, KeyringCredentials } from "../api";
import { CredentialError, getCredentials, type CredentialErrorReason } from "../keyring";
import { NavigationProvider, type CacheContext, type KeyringContext } from "../contexts/NavigationContext";
import { DowngradeProvider } from "../contexts/DowngradeContext";
import { bundleVersion, mismatchedBackendVersion } from "../version";
import { onActiveTransactionChanged, onSystemChanged } from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { currentTab, useRoute, type RouteOptions } from "../hooks/useRoute";

export type SignoffAvailability =
  | { state: "hidden" }
  | { state: "available"; credentials: KeyringCredentials }
  | { state: "unavailable"; reason: CredentialErrorReason; message: string };

const TABS: (JumpTab & { key: number })[] = [
  { key: 0, slug: "updates", title: "Updates" },
  { key: 1, slug: "installed", title: "Installed packages" },
  { key: 2, slug: "search", title: "Search packages" },
  { key: 3, slug: "history", title: "History" },
  { key: 4, slug: "cache", title: "Cache" },
  { key: 5, slug: "keyring", title: "Keyring" },
  { key: 6, slug: "mirrors", title: "Mirrors" },
  { key: 8, slug: "repositories", title: "Repositories" },
  { key: 7, slug: "signoffs", title: "Signoffs" },
];

const TABS_ID = "cockpit-pacman-tabs";

const VIEW_DETAILS_TABS = new Set(["updates", "installed", "search", "history", "cache", "signoffs"]);

const JUMP_WAIT_MS = 10_000;

type SpaceReturn = CacheContext & UpgradeSpaceNeed;

const ENDS_SPACE_RETURN = new Set(["sync-database", "upgrade"]);

const textOf = (el: Element) => el.textContent?.trim() ?? "";

function tabPanel(key: number): HTMLElement | null {
  const panel = document.getElementById(`pf-tab-section-${key}-${TABS_ID}`);
  return panel && !panel.hidden ? panel : null;
}

function findButton(root: Element | null, matches: (text: string) => boolean): HTMLElement | null {
  if (!root) return null;
  return Array.from(root.querySelectorAll<HTMLElement>("button")).find((b) => matches(textOf(b))) ?? null;
}

function detailsFor(name: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-details-for]"))
    .find((el) => el.getAttribute("data-details-for") === name && !el.closest("[hidden]")) ?? null;
}

function findMenuItem(label: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((item) => textOf(item).startsWith(label) && !item.closest("li")?.hasAttribute("data-pending")) ?? null;
}

// Use view controls so jump commands obey their gates and confirmations.
// Programmatic click() emits neither keydown nor pointerdown, which stop the sequence.
function pressInOrder(steps: (() => HTMLElement | null)[], onTimeout?: (missing: number) => void): () => void {
  let next = 0;
  const observer = new MutationObserver(() => advance());
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    document.removeEventListener("keydown", stop, true);
    document.removeEventListener("pointerdown", stop, true);
  };
  const advance = () => {
    while (next < steps.length) {
      const el = steps[next]();
      if (!el) return;
      next++;
      if (next === steps.length) {
        stop();
        el.focus();
      }
      el.click();
    }
  };
  const timer = setTimeout(() => {
    stop();
    onTimeout?.(next);
  }, JUMP_WAIT_MS);
  document.addEventListener("keydown", stop, true);
  document.addEventListener("pointerdown", stop, true);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "aria-disabled"] });
  advance();
  return stop;
}

const UPDATES_CHECK_LABELS = new Set(["Refresh", "Check for updates", "Check again"]);

const withoutDetails = ({ pkg: _pkg, repo: _repo, ...rest }: RouteOptions): RouteOptions => rest;

export const App: React.FC = () => {
  const route = useRoute();
  const { navigate, setOptions } = route;
  const [signoffs, setSignoffs] = useState<SignoffAvailability>({ state: "hidden" });
  const [credentialsSettled, setCredentialsSettled] = useState(false);
  const [toSignOff, setToSignOff] = useState<number | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ count: null, security: 0, failed: false });
  // SignoffsView reloads after every sign-off; the Updates load only seeds the count.
  const seedToSignOff = useCallback((count: number) => setToSignOff((prev) => prev ?? count), []);
  const signoffAvailable = signoffs.state === "available";
  const signoffTabShown = signoffs.state !== "hidden";
  const signoffCredentials = signoffs.state === "available" ? signoffs.credentials : null;
  const [staleBundle, setStaleBundle] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const jumpInputRef = useRef<HTMLInputElement | null>(null);
  const announce = useAnnounce();
  const { selectedPackage, detailsLoading, detailsError, detailsErrorCode, detailsErrorContext, fetchDetails, clearDetails } = usePackageDetails();

  const routedSlug = TABS.some((t) => t.slug === route.tab) ? route.tab : "updates";
  const signoffsBlocked = routedSlug === "signoffs" && !signoffTabShown;
  const activeSlug = signoffsBlocked ? "updates" : routedSlug;
  const activeTab = TABS.find((t) => t.slug === activeSlug)!.key;
  const routeOptionsFor = (slug: string) => (slug === activeSlug ? route.options : undefined);

  const lastOptionsRef = useRef<Record<string, RouteOptions>>({});
  useEffect(() => {
    lastOptionsRef.current[activeSlug] = withoutDetails(route.options);
  }, [activeSlug, route.options]);

  const goTab = useCallback(
    (slug: string, options?: RouteOptions) => navigate(slug, options ?? lastOptionsRef.current[slug]),
    [navigate],
  );

  // A late write from a view whose tab was just left must not land on the new tab.
  const routeChangeHandlers = useMemo(() => {
    const handlers: Record<string, (options: RouteOptions) => void> = {};
    for (const { slug } of TABS) {
      handlers[slug] = (options) => {
        if (currentTab() === slug) setOptions(options);
      };
    }
    return handlers;
  }, [setOptions]);

  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<number>>(() => new Set([activeTab]));
  if (!visitedTabs.has(activeTab)) {
    setVisitedTabs(new Set(visitedTabs).add(activeTab));
  }

  // Focus follows a tab change made by anything other than the tab itself;
  // a view that already focused something in its panel keeps it.
  const tabClickedRef = useRef(false);
  const focusedTabRef = useRef(activeTab);
  useEffect(() => {
    if (focusedTabRef.current === activeTab) return;
    focusedTabRef.current = activeTab;
    if (tabClickedRef.current) {
      tabClickedRef.current = false;
      return;
    }
    const focusPanel = () => {
      const panel = tabPanel(activeTab);
      if (!panel) return false;
      if (!panel.contains(document.activeElement)) panel.focus();
      return true;
    };
    if (focusPanel()) return;
    const observer = new MutationObserver(() => {
      if (focusPanel()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, [activeTab]);

  const handleTabSelect = (key: string | number) => {
    const tab = TABS.find((t) => t.key === key);
    if (!tab) return;
    if (key !== activeTab) tabClickedRef.current = true;
    goTab(tab.slug);
  };

  const appDetailsName = VIEW_DETAILS_TABS.has(activeSlug) ? "" : route.options.pkg ?? "";
  const appDetailsRepo = appDetailsName ? route.options.repo ?? "" : "";
  useEffect(() => {
    if (appDetailsName) {
      fetchDetails(appDetailsName, appDetailsRepo ? { strategy: "sync", repo: appDetailsRepo } : { strategy: "local" });
    } else {
      clearDetails();
    }
  }, [appDetailsName, appDetailsRepo, fetchDetails, clearDetails]);

  const closeAppDetails = () => setOptions(withoutDetails(route.options));

  const jumpTabs = useMemo(
    () => TABS.filter((t) => t.slug !== "signoffs" || signoffTabShown),
    [signoffTabShown],
  );

  const handleJumpNavigate = useCallback((slug: string) => goTab(slug), [goTab]);

  const handleJumpInspect = useCallback((name: string, options: InspectOptions) => {
    setOptions({ ...withoutDetails(route.options), pkg: name, repo: options.repo });
  }, [setOptions, route.options]);

  const stopJumpCommandRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopJumpCommandRef.current?.(), []);
  const runJumpCommand = useCallback((steps: (() => HTMLElement | null)[], onTimeout?: (missing: number) => void) => {
    stopJumpCommandRef.current?.();
    stopJumpCommandRef.current = pressInOrder(steps, onTimeout);
  }, []);

  const jumpCommands = useMemo<JumpCommandHandlers>(() => {
    const inDetails = (name: string, item: string) => {
      handleJumpInspect(name, {});
      runJumpCommand([
        () => findButton(detailsFor(name), (text) => text === "Actions"),
        () => findMenuItem(item),
      ], (missing) => announce(missing === 0 ? `Could not open Actions for ${name}` : `${item} is not available for ${name}`));
    };
    return {
      onCheckUpdates: () => {
        goTab("updates");
        runJumpCommand([() => findButton(tabPanel(0), (text) => UPDATES_CHECK_LABELS.has(text))]);
      },
      onRankMirrors: () => {
        goTab("mirrors");
        runJumpCommand([() => findButton(tabPanel(6), (text) => text.startsWith("Rank mirrors"))]);
      },
      onReinstall: (name) => inDetails(name, `Reinstall ${name}`),
      onSetInstallReason: (name, reason: InstallReason) => inDetails(name, `Mark ${name} as ${reasonPhrase(reason)}`),
    };
  }, [goTab, handleJumpInspect, runJumpCommand, announce]);

  useShortcuts({
    onFocusJump: () => jumpInputRef.current?.focus(),
    onToggleHelp: () => setShortcutsOpen((open) => !open),
  });

  useExternalLockWatch(activeTab);

  const transactionRunning = useOwnTransactionRunning();
  useEffect(() => {
    if (!transactionRunning) return;
    const warn = (event: Event) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [transactionRunning]);

  // The plugin can upgrade itself in a transaction, so the check repeats after each one.
  useEffect(() => {
    const check = () =>
      mismatchedBackendVersion()
        .then(setStaleBundle)
        .catch(() => setStaleBundle(null));
    check();
    return onSystemChanged(check, ["system"]);
  }, []);

  const loadCredentials = useCallback(
    (hideWhenAbsent: boolean) =>
      getCredentials()
        .then((credentials) => setSignoffs({ state: "available", credentials }))
        .catch((err: unknown) => {
          const reason = err instanceof CredentialError ? err.reason : "failed";
          const message = err instanceof Error ? err.message : String(err);
          // Keep retry failures in the tab that requested them.
          if (reason === "absent" && hideWhenAbsent) {
            setSignoffs({ state: "hidden" });
          } else {
            setSignoffs({ state: "unavailable", reason, message });
          }
        })
        .finally(() => setCredentialsSettled(true)),
    [],
  );

  useEffect(() => {
    loadCredentials(true);
  }, [loadCredentials]);

  const retryCredentials = useCallback(() => loadCredentials(false), [loadCredentials]);

  const [keyringReturn, setKeyringReturn] = useState<{ context: KeyringContext; slug: string } | null>(null);
  const [cacheReturn, setCacheReturn] = useState<SpaceReturn | null>(null);
  const activeSlugRef = useRef(activeSlug);
  useEffect(() => {
    if (activeSlugRef.current === "keyring" && activeSlug !== "keyring") setKeyringReturn(null);
    if (activeSlugRef.current === "cache" && activeSlug !== "cache") {
      setCacheReturn((current) => (current?.resume ? current : null));
    }
    activeSlugRef.current = activeSlug;
  }, [activeSlug]);
  useEffect(() => onActiveTransactionChanged((transaction) => {
    if (transaction && ENDS_SPACE_RETURN.has(transaction.command)) setCacheReturn(null);
  }), []);

  const viewKeyring = useCallback((context?: KeyringContext) => {
    // Plain click handlers pass their event here.
    setKeyringReturn(context?.origin ? { context, slug: activeSlugRef.current } : null);
    goTab("keyring");
  }, [goTab]);

  const retryFromKeyring = () => {
    if (!keyringReturn) return;
    setKeyringReturn(null);
    goTab(keyringReturn.slug);
    keyringReturn.context.retry?.();
  };

  const viewCache = useCallback((context?: CacheContext) => {
    // Plain click handlers pass their event here. TransactionRisks offers Open
    // Cache only for a shortfall on the filesystem that holds the cache.
    setCacheReturn(context?.mount ? { ...context, holds_cache: true } : null);
    goTab("cache");
  }, [goTab]);

  const backToUpgrade = () => {
    if (!cacheReturn) return;
    setCacheReturn(null);
    goTab("updates");
    cacheReturn.resume?.();
  };

  const dismissCacheReturn = () => setCacheReturn(null);

  const upgradeWaiting = cacheReturn?.resume ? cacheReturn : null;
  useTransactionAnnouncements(activeSlug, route.options, upgradeWaiting);

  const handleSearchInstalled = (query: string) => goTab("installed", { q: query });

  const handleSearchRepositories = (query: string) => goTab("search", { q: query });

  const navHandlers = useMemo(
    () => ({
      onViewUpdates: () => goTab("updates"),
      onViewDependencies: (packageName: string) => goTab("installed", { graph: packageName }),
      onViewHistory: (packageName: string) => goTab("history", { q: packageName }),
      onViewOrphans: () => goTab("installed", { filter: "orphan" }),
      onViewCache: viewCache,
      onViewKeyring: viewKeyring,
      onViewSignoffs: signoffAvailable
        ? (filter?: string) => goTab("signoffs", filter ? { filter } : undefined)
        : undefined,
    }),
    [signoffAvailable, goTab, viewKeyring, viewCache],
  );

  // Inside the active panel, below the tab bar, so the bar does not move when it appears.
  const transactionBanner = (
    <TransactionBanner
      activeSlug={activeSlug}
      activeOptions={route.options}
      onNavigate={goTab}
      upgradeWaiting={upgradeWaiting}
      onBackToUpgrade={backToUpgrade}
      onDismissUpgradeWaiting={dismissCacheReturn}
    />
  );

  return (
    <NavigationProvider value={navHandlers}>
    <TransactionHostProvider>
    <DowngradeProvider>
    <Page className="no-masthead-sidebar pf-m-no-sidebar">
      <PageSection hasBodyWrapper={false} >
        {staleBundle !== null && (
          <Alert
            variant="warning"
            isInline
            title="Reload to finish updating this page"
            className="pf-v6-u-mb-md"
            actionLinks={
              <AlertActionLink onClick={() => window.location.reload()}>Reload page</AlertActionLink>
            }
          >
            This page was loaded from version {bundleVersion} of cockpit-pacman
            but is talking to version {staleBundle}. Reload the page to pick up
            the new version; the current tab and search are kept.
          </Alert>
        )}
        {signoffsBlocked && credentialsSettled && (
          <Alert variant="info" isInline title="Signoffs are not available" className="pf-v6-u-mb-md">
            No ArchWeb credentials were found in the login keyring, so the
            Signoffs tab is hidden. Showing Updates instead.
          </Alert>
        )}
        <Flex
          justifyContent={{ default: "justifyContentFlexEnd" }}
          alignItems={{ default: "alignItemsCenter" }}
          flexWrap={{ default: "nowrap" }}
          spaceItems={{ default: "spaceItemsSm" }}
          className="pf-v6-u-mb-sm"
        >
          <FlexItem grow={{ default: "grow" }} style={{ display: "flex", justifyContent: "flex-end" }}>
            <PackageJump
              tabs={jumpTabs}
              onNavigate={handleJumpNavigate}
              onInspect={handleJumpInspect}
              commands={jumpCommands}
              inputRef={jumpInputRef}
            />
          </FlexItem>
          <FlexItem>
            <ShortcutsHelp isOpen={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          </FlexItem>
        </Flex>
        <TransactionHost />
        <Tabs
          mountOnEnter
          id={TABS_ID}
          activeKey={activeTab}
          onSelect={(_event, tabIndex) => handleTabSelect(tabIndex)}
          isOverflowHorizontal
        >
          <Tab
            eventKey={0}
            title={
              <TabTitleText>
                Updates
                {updateStatus.failed ? (
                  <>
                    {" "}
                    <Badge isRead screenReaderText="Update check failed">
                      <ExclamationTriangleIcon aria-hidden="true" color="var(--pf-t--global--icon--color--status--warning--default)" />
                    </Badge>
                  </>
                ) : !!updateStatus.count && (
                  <>
                    {" "}
                    <Badge
                      isRead={updateStatus.security === 0}
                      screenReaderText={updateStatus.security > 0
                        ? `updates available, ${updateStatus.security} security`
                        : "updates available"}
                    >
                      {updateStatus.count}
                    </Badge>
                  </>
                )}
              </TabTitleText>
            }
          >
            <TabActiveContext.Provider value={activeTab === 0}>
              {activeTab === 0 && transactionBanner}
              <ErrorBoundary fallbackTitle="Error loading updates">
                <UpdatesView
                  signoffCredentials={signoffCredentials}
                  toSignOff={toSignOff}
                  onToSignOffCount={seedToSignOff}
                  onUpdateStatus={setUpdateStatus}
                  routeOptions={routeOptionsFor("updates")}
                  onRouteChange={routeChangeHandlers.updates}
                />
              </ErrorBoundary>
            </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={1} title={<TabTitleText>Installed packages</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 1}>
              {activeTab === 1 && transactionBanner}
              <ErrorBoundary fallbackTitle="Error loading packages">
                <PackageList
                  routeOptions={routeOptionsFor("installed")}
                  onRouteChange={routeChangeHandlers.installed}
                  onSearchRepositories={handleSearchRepositories}
                />
              </ErrorBoundary>
            </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={2} title={<TabTitleText>Search packages</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 2}>
              {activeTab === 2 && transactionBanner}
              <ErrorBoundary fallbackTitle="Error loading search">
                <SearchView
                  routeOptions={routeOptionsFor("search")}
                  onRouteChange={routeChangeHandlers.search}
                  onSearchInstalled={handleSearchInstalled}
                />
              </ErrorBoundary>
            </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={3} title={<TabTitleText>History</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 3}>
              {activeTab === 3 && transactionBanner}
              <ErrorBoundary fallbackTitle="Error loading history">
                <HistoryView routeOptions={routeOptionsFor("history")} onRouteChange={routeChangeHandlers.history} />
              </ErrorBoundary>
            </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={4} title={<TabTitleText>Cache</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 4}>
              {activeTab === 4 && transactionBanner}
              <ErrorBoundary fallbackTitle="Error loading cache">
                <CacheView
                  routeOptions={routeOptionsFor("cache")}
                  onRouteChange={routeChangeHandlers.cache}
                  upgradeNeed={cacheReturn}
                  onBackToUpgrade={cacheReturn?.resume ? backToUpgrade : undefined}
                  onDismissUpgradeNeed={dismissCacheReturn}
                />
              </ErrorBoundary>
            </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={5} title={<TabTitleText>Keyring</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 5}>
              {activeTab === 5 && transactionBanner}
              <ErrorBoundary fallbackTitle="Error loading keyring">
                <KeyringView
                  signatureFailure={keyringReturn?.context}
                  onRetryFailed={retryFromKeyring}
                  onDismissFailure={() => setKeyringReturn(null)}
                />
              </ErrorBoundary>
            </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={6} title={<TabTitleText>Mirrors</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 6}>
              {activeTab === 6 && transactionBanner}
              {visitedTabs.has(6) && (
                <ErrorBoundary fallbackTitle="Error loading mirrors">
                  <MirrorsView />
                </ErrorBoundary>
              )}
            </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={8} title={<TabTitleText>Repositories</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 8}>
              {activeTab === 8 && transactionBanner}
              <ErrorBoundary fallbackTitle="Error loading repositories">
                <RepositoriesView />
              </ErrorBoundary>
            </TabActiveContext.Provider>
          </Tab>
          {signoffTabShown && (
            <Tab
              eventKey={7}
              title={
                <TabTitleText>
                  Signoffs
                  {signoffAvailable && !!toSignOff && (
                    <>
                      {" "}
                      <Badge isRead screenReaderText="to sign off">{toSignOff}</Badge>
                    </>
                  )}
                </TabTitleText>
              }
            >
              <TabActiveContext.Provider value={activeTab === 7}>
                {activeTab === 7 && transactionBanner}
                {visitedTabs.has(7) && (
                  <ErrorBoundary fallbackTitle="Error loading signoffs">
                    <SignoffsView
                      key={signoffs.state}
                      credentials={signoffCredentials}
                      unavailable={signoffs.state === "unavailable" ? signoffs : undefined}
                      onRetryCredentials={retryCredentials}
                      routeOptions={routeOptionsFor("signoffs")}
                      onRouteChange={routeChangeHandlers.signoffs}
                      onToSignOffCount={setToSignOff}
                    />
                  </ErrorBoundary>
                )}
              </TabActiveContext.Provider>
            </Tab>
          )}
        </Tabs>
        <PackageDetailsModal
          packageDetails={selectedPackage}
          isLoading={detailsLoading}
          onClose={closeAppDetails}
          error={detailsError}
          errorCode={detailsErrorCode}
          errorDetails={detailsErrorContext}
        />
      </PageSection>
    </Page>
    </DowngradeProvider>
    </TransactionHostProvider>
    </NavigationProvider>
  );
};

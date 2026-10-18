import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  Alert,
  Page,
  PageSection,
  Tabs,
  Tab,
  TabTitleText,
} from "@patternfly/react-core";
import { AnnouncerProvider } from "../contexts/AnnouncerContext";
import { TransactionHost, TransactionHostProvider } from "./TransactionHost";
import { TransactionBanner, useTransactionAnnouncements } from "./TransactionBanner";
import { useExternalLockWatch } from "../hooks/useMutationGate";
import { TabActiveContext } from "../hooks/useRefreshOnActivate";
import { UpdatesView } from "./UpdatesView";
import { PackageList } from "./PackageList";
import { SearchView } from "./SearchView";
import { KeyringView } from "./KeyringView";
import { CacheView } from "./CacheView";
import { HistoryView } from "./HistoryView";
import { MirrorsView } from "./MirrorsView";
import { RepositoriesView } from "./RepositoriesView";
import { SignoffsView } from "./SignoffsView";
import { ErrorBoundary } from "./ErrorBoundary";
import type { KeyringCredentials } from "../api";
import { getCredentials } from "../keyring";
import { NavigationProvider } from "../contexts/NavigationContext";
import { bundleVersion, mismatchedBackendVersion } from "../version";

const TAB_SLUGS = ["updates", "installed", "search", "history", "cache", "keyring", "mirrors", "signoffs", "repositories"];

export const App: React.FC = () => (
  <AnnouncerProvider>
    <TransactionHostProvider><AppContent /></TransactionHostProvider>
  </AnnouncerProvider>
);

const AppContent: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string | number>(0);
  const [graphPackage, setGraphPackage] = useState<string | undefined>(undefined);
  const [historySearch, setHistorySearch] = useState<{ query: string; key: number } | undefined>(undefined);
  const historyKeyRef = useRef(0);
  const [orphanFilter, setOrphanFilter] = useState<{ filter: "orphan"; key: number } | undefined>(undefined);
  const orphanKeyRef = useRef(0);
  const [signoffAvailable, setSignoffAvailable] = useState(false);
  const [signoffCredentials, setSignoffCredentials] = useState<KeyringCredentials | null>(null);
  const [staleBundle, setStaleBundle] = useState<string | null>(null);

  useEffect(() => {
    mismatchedBackendVersion()
      .then(setStaleBundle)
      .catch(() => setStaleBundle(null));
  }, []);

  useEffect(() => {
    getCredentials()
      .then((creds) => {
        setSignoffAvailable(true);
        setSignoffCredentials(creds);
      })
      .catch(() => {
        setSignoffAvailable(false);
      });
  }, []);

  const handleViewDependencies = (packageName: string) => {
    setGraphPackage(packageName);
    setActiveTab(1);
  };

  const handleViewOrphans = () => {
    setOrphanFilter({ filter: "orphan", key: ++orphanKeyRef.current });
    setActiveTab(1);
  };

  const handleViewCache = () => {
    setActiveTab(4);
  };

  const handleViewUpdates = () => {
    setActiveTab(0);
  };

  const handleViewSignoffs = () => {
    setActiveTab(7);
  };

  const handleViewKeyring = () => {
    setActiveTab(5);
  };

  const handleViewHistory = (packageName: string) => {
    setHistorySearch({ query: packageName, key: ++historyKeyRef.current });
    setActiveTab(3);
  };

  const activeSlug = TAB_SLUGS[Number(activeTab)] ?? "updates";
  const activeOptions: Record<string, string> = orphanFilter ? { filter: "orphan" } : {};
  useTransactionAnnouncements(activeSlug, activeOptions);
  useExternalLockWatch(activeTab);

  const navHandlers = useMemo(
    () => ({
      onViewUpdates: handleViewUpdates,
      onViewDependencies: handleViewDependencies,
      onViewHistory: handleViewHistory,
      onViewOrphans: handleViewOrphans,
      onViewCache: handleViewCache,
      onViewKeyring: handleViewKeyring,
      onViewSignoffs: signoffAvailable ? handleViewSignoffs : undefined,
    }),
    [signoffAvailable],
  );

  return (
    <NavigationProvider value={navHandlers}>
    <Page className="no-masthead-sidebar pf-m-no-sidebar">
      <PageSection hasBodyWrapper={false} >
        {staleBundle !== null && (
          <Alert
            variant="warning"
            isInline
            title="Reload to finish updating this page"
            className="pf-v6-u-mb-md"
          >
            This page was loaded from version {bundleVersion} of cockpit-pacman
            but is talking to version {staleBundle}. Reload the browser to pick
            up the new version.
          </Alert>
        )}
        <TransactionBanner
          activeSlug={activeSlug}
          activeOptions={activeOptions}
          onNavigate={(slug, options) => {
            if (slug === "installed" && options?.filter === "orphan") handleViewOrphans();
            else {
              const index = TAB_SLUGS.indexOf(slug);
              if (index >= 0) setActiveTab(index);
            }
          }}
        />
        <TransactionHost />
        <Tabs
          mountOnEnter
          activeKey={activeTab}
          onSelect={(_event, tabIndex) => setActiveTab(tabIndex)}
        >
          <Tab eventKey={0} title={<TabTitleText>Updates</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 0}>
            <ErrorBoundary fallbackTitle="Error loading updates">
              <UpdatesView signoffCredentials={signoffCredentials} />
            </ErrorBoundary>
                      </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={1} title={<TabTitleText>Installed Packages</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 1}>
            <ErrorBoundary fallbackTitle="Error loading packages">
              <PackageList graphPackage={graphPackage} initialFilter={orphanFilter} onGraphPackageChange={setGraphPackage} />
            </ErrorBoundary>
                      </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={2} title={<TabTitleText>Search Packages</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 2}>
            <ErrorBoundary fallbackTitle="Error loading search">
              <SearchView />
            </ErrorBoundary>
                      </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={3} title={<TabTitleText>History</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 3}>
            <ErrorBoundary fallbackTitle="Error loading history">
              <HistoryView initialSearch={historySearch} />
            </ErrorBoundary>
                      </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={4} title={<TabTitleText>Cache</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 4}>
            <ErrorBoundary fallbackTitle="Error loading cache">
              <CacheView />
            </ErrorBoundary>
                      </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={5} title={<TabTitleText>Keyring</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 5}>
            <ErrorBoundary fallbackTitle="Error loading keyring">
              <KeyringView />
            </ErrorBoundary>
                      </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={6} title={<TabTitleText>Mirrors</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 6}>
            <ErrorBoundary fallbackTitle="Error loading mirrors">
              <MirrorsView />
            </ErrorBoundary>
                      </TabActiveContext.Provider>
          </Tab>
          <Tab eventKey={8} title={<TabTitleText>Repositories</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 8}>
            <ErrorBoundary fallbackTitle="Error loading repositories">
              <RepositoriesView />
            </ErrorBoundary>
                      </TabActiveContext.Provider>
          </Tab>
          {signoffAvailable && (
            <Tab eventKey={7} title={<TabTitleText>Signoffs</TabTitleText>}>
            <TabActiveContext.Provider value={activeTab === 7}>
              <ErrorBoundary fallbackTitle="Error loading signoffs">
                <SignoffsView credentials={signoffCredentials!} />
              </ErrorBoundary>
                        </TabActiveContext.Provider>
          </Tab>
          )}
        </Tabs>
      </PageSection>
    </Page>
    </NavigationProvider>
  );
};

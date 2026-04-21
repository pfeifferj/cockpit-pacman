import React, { useState, useRef, useEffect } from "react";
import {
  Page,
  PageSection,
  Tabs,
  Tab,
  TabTitleText,
} from "@patternfly/react-core";
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

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string | number>(0);
  const [graphPackage, setGraphPackage] = useState<string | undefined>(undefined);
  const [historySearch, setHistorySearch] = useState<{ query: string; key: number } | undefined>(undefined);
  const historyKeyRef = useRef(0);
  const [orphanFilter, setOrphanFilter] = useState<{ filter: "orphan"; key: number } | undefined>(undefined);
  const orphanKeyRef = useRef(0);
  const [signoffAvailable, setSignoffAvailable] = useState(false);
  const [signoffCredentials, setSignoffCredentials] = useState<KeyringCredentials | null>(null);

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

  const navHandlers = {
    onViewDependencies: handleViewDependencies,
    onViewHistory: handleViewHistory,
    onViewOrphans: handleViewOrphans,
    onViewCache: handleViewCache,
    onViewKeyring: handleViewKeyring,
    onViewSignoffs: signoffAvailable ? handleViewSignoffs : undefined,
  };

  return (
    <NavigationProvider value={navHandlers}>
    <Page className="no-masthead-sidebar pf-m-no-sidebar">
      <PageSection hasBodyWrapper={false} >
        <Tabs
          activeKey={activeTab}
          onSelect={(_event, tabIndex) => setActiveTab(tabIndex)}
        >
          <Tab eventKey={0} title={<TabTitleText>Updates</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading updates">
              <UpdatesView signoffCredentials={signoffCredentials} />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={1} title={<TabTitleText>Installed Packages</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading packages">
              <PackageList graphPackage={graphPackage} initialFilter={orphanFilter} onGraphPackageChange={setGraphPackage} />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={2} title={<TabTitleText>Search Packages</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading search">
              <SearchView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={3} title={<TabTitleText>History</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading history">
              <HistoryView initialSearch={historySearch} />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={4} title={<TabTitleText>Cache</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading cache">
              <CacheView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={5} title={<TabTitleText>Keyring</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading keyring">
              <KeyringView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={6} title={<TabTitleText>Mirrors</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading mirrors">
              <MirrorsView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={8} title={<TabTitleText>Repositories</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading repositories">
              <RepositoriesView />
            </ErrorBoundary>
          </Tab>
          {signoffAvailable && (
            <Tab eventKey={7} title={<TabTitleText>Signoffs</TabTitleText>}>
              <ErrorBoundary fallbackTitle="Error loading signoffs">
                <SignoffsView credentials={signoffCredentials!} />
              </ErrorBoundary>
            </Tab>
          )}
        </Tabs>
      </PageSection>
    </Page>
    </NavigationProvider>
  );
};

import React, { useState, useRef } from "react";
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
import { ErrorBoundary } from "./ErrorBoundary";

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string | number>(0);
  const [graphPackage, setGraphPackage] = useState<string | undefined>(undefined);
  const [historySearch, setHistorySearch] = useState<{ query: string; key: number } | undefined>(undefined);
  const historyKeyRef = useRef(0);

  const handleViewDependencies = (packageName: string) => {
    setGraphPackage(packageName);
    setActiveTab(1);
  };

  const handleViewHistory = (packageName: string) => {
    setHistorySearch({ query: packageName, key: ++historyKeyRef.current });
    setActiveTab(3);
  };

  return (
    <Page className="no-masthead-sidebar pf-m-no-sidebar">
      <PageSection hasBodyWrapper={false} >
        <Tabs
          activeKey={activeTab}
          onSelect={(_event, tabIndex) => setActiveTab(tabIndex)}
        >
          <Tab eventKey={0} title={<TabTitleText>Updates</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading updates">
              <UpdatesView onViewDependencies={handleViewDependencies} onViewHistory={handleViewHistory} />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={1} title={<TabTitleText>Installed Packages</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading packages">
              <PackageList graphPackage={graphPackage} onGraphPackageChange={setGraphPackage} onViewHistory={handleViewHistory} />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={2} title={<TabTitleText>Search Packages</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading search">
              <SearchView onViewDependencies={handleViewDependencies} onViewHistory={handleViewHistory} />
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
        </Tabs>
      </PageSection>
    </Page>
  );
};

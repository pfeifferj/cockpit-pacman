import React, { useState } from "react";
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
import { OrphansView } from "./OrphansView";
import { CacheView } from "./CacheView";
import { HistoryView } from "./HistoryView";
import { MirrorsView } from "./MirrorsView";
import { DependencyView } from "./DependencyView";
import { ErrorBoundary } from "./ErrorBoundary";

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string | number>(0);

  return (
    <Page className="no-masthead-sidebar pf-m-no-sidebar">
      <PageSection hasBodyWrapper={false} >
        <Tabs
          activeKey={activeTab}
          onSelect={(_event, tabIndex) => setActiveTab(tabIndex)}
        >
          <Tab eventKey={0} title={<TabTitleText>Updates</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading updates">
              <UpdatesView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={1} title={<TabTitleText>Installed Packages</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading packages">
              <PackageList />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={2} title={<TabTitleText>Search Packages</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading search">
              <SearchView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={3} title={<TabTitleText>History</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading history">
              <HistoryView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={4} title={<TabTitleText>Orphans</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading orphans">
              <OrphansView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={5} title={<TabTitleText>Cache</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading cache">
              <CacheView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={6} title={<TabTitleText>Keyring</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading keyring">
              <KeyringView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={7} title={<TabTitleText>Mirrors</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading mirrors">
              <MirrorsView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={8} title={<TabTitleText>Dependencies</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading dependencies">
              <DependencyView />
            </ErrorBoundary>
          </Tab>
        </Tabs>
      </PageSection>
    </Page>
  );
};

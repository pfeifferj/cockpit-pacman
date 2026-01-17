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
          <Tab eventKey={3} title={<TabTitleText>Keyring</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading keyring">
              <KeyringView />
            </ErrorBoundary>
          </Tab>
          <Tab eventKey={4} title={<TabTitleText>Orphans</TabTitleText>}>
            <ErrorBoundary fallbackTitle="Error loading orphans">
              <OrphansView />
            </ErrorBoundary>
          </Tab>
        </Tabs>
      </PageSection>
    </Page>
  );
};

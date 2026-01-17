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
            <UpdatesView />
          </Tab>
          <Tab eventKey={1} title={<TabTitleText>Installed Packages</TabTitleText>}>
            <PackageList />
          </Tab>
          <Tab eventKey={2} title={<TabTitleText>Search Packages</TabTitleText>}>
            <SearchView />
          </Tab>
          <Tab eventKey={3} title={<TabTitleText>Keyring</TabTitleText>}>
            <KeyringView />
          </Tab>
        </Tabs>
      </PageSection>
    </Page>
  );
};

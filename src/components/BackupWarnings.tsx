import React from "react";
import { Alert } from "@patternfly/react-core";

export const BackupWarnings: React.FC<{ warnings: string[] }> = ({ warnings }) => {
  if (warnings.length === 0) return null;
  return (
    <Alert variant="warning" isInline title="Backup warnings" className="pf-v6-u-mb-md">
      <ul>
        {Array.from(new Set(warnings)).map(warning => <li key={warning}>{warning}</li>)}
      </ul>
    </Alert>
  );
};

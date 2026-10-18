import React, { useEffect, useState } from "react";
import { Alert } from "@patternfly/react-core";
import { useAnnounce } from "../contexts/AnnouncerContext";
import type { ProgressPhase } from "../progress";

export const CANCEL_WAIT_NOTICE_MS = 20_000;

export const CancellationNotice: React.FC<{
  delayMs?: number;
  lastEventAt?: number;
  phase?: ProgressPhase;
}> = ({ delayMs = CANCEL_WAIT_NOTICE_MS, lastEventAt, phase }) => {
  const [offered, setOffered] = useState(false);
  const announce = useAnnounce();
  useEffect(() => {
    if (offered) return;
    const wait = lastEventAt === undefined ? delayMs : Math.max(0, lastEventAt + delayMs - Date.now());
    const timer = setTimeout(() => {
      setOffered(true);
      announce("Cancellation is taking longer than expected. Waiting for package changes and hooks to finish.");
    }, wait);
    return () => clearTimeout(timer);
  }, [offered, lastEventAt, delayMs, announce]);
  if (!offered) return null;
  const writing = phase === "transaction" || phase === "hooks";
  return (
    <Alert component="h2"
      variant="warning"
      isInline
      title="Cancelling is taking longer than expected"
      className="pf-v6-u-mb-md"
    >
      {writing
        ? "Package changes and hooks are still running. This transaction will finish before cancellation is acknowledged."
        : "Waiting for the backend to stop safely. A transaction that has started committing will finish its package changes and hooks."}
    </Alert>
  );
};

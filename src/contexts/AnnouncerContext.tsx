import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface AnnounceOptions {
  assertive?: boolean;
}

export type Announce = (message: string, options?: AnnounceOptions) => void;

interface Region {
  text: string;
  id: number;
}

const emptyRegion: Region = { text: "", id: 0 };

const noop: Announce = () => {};

const AnnouncerContext = createContext<Announce>(noop);

/**
 * Renders one polite and one assertive visually hidden live region and
 * exposes announce() to descendants. Announcing never moves focus.
 */
export const AnnouncerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [polite, setPolite] = useState<Region>(emptyRegion);
  const [assertive, setAssertive] = useState<Region>(emptyRegion);
  const seq = useRef(0);
  const [host] = useState(() => document.createElement("div"));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // An open PF Modal sets aria-hidden on every other child of <body>, which
  // would silence announcements made while a dialog is up. The host only
  // holds the hidden regions, so it is kept exposed.
  useEffect(() => {
    document.body.appendChild(host);
    const observer = new MutationObserver(() => {
      if (host.hasAttribute("aria-hidden")) host.removeAttribute("aria-hidden");
    });
    observer.observe(host, { attributes: true, attributeFilter: ["aria-hidden"] });
    return () => {
      observer.disconnect();
      host.remove();
    };
  }, [host]);

  const announce = useCallback<Announce>((message, options) => {
    const set = options?.assertive ? setAssertive : setPolite;
    // React batches the clear and the re-set into one render outside a
    // discrete event; the per-call key still replaces the text node, so a
    // repeated message is a DOM change and screen readers read it again.
    const id = ++seq.current;
    set({ text: "", id });
    Promise.resolve().then(() => {
      if (mounted.current) set({ text: message, id });
    });
  }, []);

  const value = useMemo(() => announce, [announce]);

  return (
    <AnnouncerContext.Provider value={value}>
      {children}
      {createPortal(
        <>
          <div className="pf-v6-screen-reader" role="status" aria-live="polite" aria-atomic="true">
            <span key={polite.id}>{polite.text}</span>
          </div>
          <div className="pf-v6-screen-reader" role="alert" aria-live="assertive" aria-atomic="true">
            <span key={assertive.id}>{assertive.text}</span>
          </div>
        </>,
        host,
      )}
    </AnnouncerContext.Provider>
  );
};

/** Returns announce(message, { assertive? }); a no-op outside AnnouncerProvider. */
export function useAnnounce(): Announce {
  return useContext(AnnouncerContext);
}

/**
 * Announces `message` politely when `resultKey` changes to a value other
 * than the last one announced. The key at mount counts as announced, so an
 * initial load is silent. Callers change the key only once the result it
 * names is on screen. A null key means "nothing settled" and forgets the
 * last key, so the next settled result is announced even if it repeats.
 */
export function useResultAnnouncement(message: string | null, resultKey: string | null): void {
  const announce = useAnnounce();
  const lastKey = useRef(resultKey);
  useEffect(() => {
    if (resultKey === null) {
      lastKey.current = null;
      return;
    }
    if (message === null || resultKey === lastKey.current) return;
    lastKey.current = resultKey;
    announce(message);
  }, [announce, message, resultKey]);
}

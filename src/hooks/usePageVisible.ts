import { useEffect, useState } from "react";

function isVisible(): boolean {
  return cockpit.hidden !== true;
}

/**
 * Whether the plugin frame is shown. Cockpit loads some frames hidden (at login
 * and for manifest preloads); `cockpit.hidden` covers both the browser tab and
 * the shell hiding this iframe.
 * @returns `visible` now, and `hasBeenVisible`, which stays true once set
 */
export function usePageVisible(): { visible: boolean; hasBeenVisible: boolean } {
  const [visible, setVisible] = useState(isVisible);
  const [hasBeenVisible, setHasBeenVisible] = useState(visible);

  useEffect(() => {
    const onChange = () => {
      const now = isVisible();
      setVisible(now);
      if (now) setHasBeenVisible(true);
    };
    cockpit.addEventListener("visibilitychange", onChange);
    // The frame can be shown between the first render and this subscription.
    onChange();
    return () => cockpit.removeEventListener("visibilitychange", onChange);
  }, []);

  return { visible, hasBeenVisible };
}

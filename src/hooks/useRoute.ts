import { useCallback, useEffect, useRef, useState } from "react";

/** Single-valued route options; empty values are dropped when written. */
export type RouteOptions = Record<string, string>;
export type RouteOptionsInput = Record<string, string | undefined>;

export interface Route {
  /** First path segment, or "updates" for the empty path. */
  tab: string;
  options: RouteOptions;
  /** Navigate to a tab, adding a history entry. */
  navigate: (tab: string, options?: RouteOptionsInput) => void;
  /** Replace the options of the current location without a history entry. */
  setOptions: (options: RouteOptionsInput) => void;
}

const DEFAULT_TAB = "updates";

export function cleanOptions(options: RouteOptionsInput | undefined): RouteOptions {
  const result: RouteOptions = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined && value !== "") result[key] = value;
  }
  return result;
}

/** Order-independent identity of a set of options. */
export function optionsKey(options: RouteOptionsInput): string {
  const clean = cleanOptions(options);
  return JSON.stringify(Object.keys(clean).sort().map((key) => [key, clean[key]]));
}

/** The tab of the location as it is right now, which may be ahead of a rendered route. */
export function currentTab(): string {
  return cockpit.location.path[0] || DEFAULT_TAB;
}

function tabPath(tab: string): string[] {
  return tab === DEFAULT_TAB ? [] : [tab];
}

// Cockpit gives a repeated option as an array; only the first value is meaningful here.
function readOptions(): RouteOptions {
  const result: RouteOptions = {};
  for (const [key, value] of Object.entries(cockpit.location.options)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first !== "") result[key] = first;
  }
  return result;
}

function readRoute(): { tab: string; options: RouteOptions; href: string } {
  return { tab: currentTab(), options: readOptions(), href: cockpit.location.href };
}

export function useRoute(): Route {
  const [state, setState] = useState(readRoute);

  useEffect(() => {
    const update = () => setState((prev) => (prev.href === cockpit.location.href ? prev : readRoute()));
    cockpit.addEventListener("locationchanged", update);
    // A change between the first render and subscribing would otherwise be missed.
    update();
    return () => cockpit.removeEventListener("locationchanged", update);
  }, []);

  const navigate = useCallback((tab: string, options?: RouteOptionsInput) => {
    const clean = cleanOptions(options);
    if (Object.keys(clean).length > 0) {
      cockpit.location.go(tabPath(tab), clean);
    } else {
      cockpit.location.go(tabPath(tab));
    }
  }, []);

  const setOptions = useCallback((options: RouteOptionsInput) => {
    cockpit.location.replace(cockpit.location.path, cleanOptions(options));
  }, []);

  return { tab: state.tab, options: state.options, navigate, setOptions };
}

/**
 * Two-way binding between a view's state and the route options of its tab.
 *
 * `routeOptions` is undefined while the tab is not the routed one; nothing is
 * read or written then. `state` is the view's current state in option form.
 * `parse` turns route options into canonical state, falling back on invalid
 * values; `apply` makes the view match canonical options. A location written
 * from outside is applied; a state change is written back through `onChange`.
 * Route options that parse differently from how they read are rewritten.
 */
export function useRouteOptionsSync(
  routeOptions: RouteOptions | undefined,
  onChange: ((options: RouteOptions) => void) | undefined,
  state: RouteOptionsInput,
  parse: (options: RouteOptions) => RouteOptions,
  apply: (options: RouteOptions) => void,
): void {
  const stateKey = optionsKey(state);
  const routeKey = routeOptions ? optionsKey(routeOptions) : null;
  // Effects read the other key from here: a state change alone must not
  // re-apply the route, and a route change alone must not write state back.
  const latest = useRef({ routeOptions, onChange, state, parse, apply, stateKey, routeKey });
  useEffect(() => {
    latest.current = { routeOptions, onChange, state, parse, apply, stateKey, routeKey };
  });
  const lastRouteKey = useRef<string | null>(null);
  const lastStateKey = useRef(stateKey);

  useEffect(() => {
    const previous = lastRouteKey.current;
    lastRouteKey.current = routeKey;
    if (routeKey === null || routeKey === previous) return;
    const { routeOptions: options, parse: parseOptions, apply: applyOptions, onChange: write } = latest.current;
    const canonical = parseOptions(options!);
    const canonicalKey = optionsKey(canonical);
    if (canonicalKey !== latest.current.stateKey) applyOptions(canonical);
    if (canonicalKey !== routeKey) write?.(cleanOptions(canonical));
  }, [routeKey]);

  useEffect(() => {
    if (stateKey === lastStateKey.current) return;
    lastStateKey.current = stateKey;
    const { routeKey: current, onChange: write, state: currentState } = latest.current;
    if (current !== null && current !== stateKey) write?.(cleanOptions(currentState));
  }, [stateKey]);
}

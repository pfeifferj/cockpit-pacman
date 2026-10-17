/** Remembers a row for focus restoration after it leaves the list. */
export interface RowMemo {
  list: HTMLElement;
  /** Searched for the list's controls when `list` has been replaced; also the last fallback. */
  scope: HTMLElement;
  selector: string;
  keyAttr: string;
  key: string | null;
  index: number;
  control: HTMLElement;
}

export const ROW_LEAVE_WATCH_MS = 10_000;

const visibleControls = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.closest("[hidden]"));

function scopeOf(el: HTMLElement): HTMLElement {
  return el.closest<HTMLElement>('[role="tabpanel"]')
    ?? el.closest<HTMLElement>('[role="region"], section')
    ?? el.closest<HTMLElement>("table")?.parentElement
    ?? el;
}

/** Records a visible row control and its index; null outside a row. */
export function rememberRow(el: HTMLElement, selector: string, keyAttr: string): RowMemo | null {
  const control = el.matches(selector) ? el : (el.closest<HTMLElement>("tr") ?? el).querySelector<HTMLElement>(selector);
  if (!control) return null;
  const list = control.closest<HTMLElement>("table") ?? control.parentElement;
  if (!list) return null;
  const index = visibleControls(list, selector).indexOf(control);
  if (index < 0) return null;
  return { list, scope: scopeOf(list), selector, keyAttr, key: control.getAttribute(keyAttr), index, control };
}

function focusLost(memo: RowMemo): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected
    || (active === memo.control && !memo.control.isConnected);
}

/** Focuses the remembered row or nearest remaining control; true when the row is gone. */
export function focusRow(memo: RowMemo): boolean {
  const list = memo.list.isConnected ? memo.list : memo.scope;
  const controls = memo.scope.isConnected || memo.list.isConnected ? visibleControls(list, memo.selector) : [];
  const same = memo.key !== null && controls.find((el) => el.getAttribute(memo.keyAttr) === memo.key);
  if (same) {
    same.focus();
    return false;
  }
  const target = controls[Math.min(memo.index, controls.length - 1)];
  if (target) {
    target.focus();
  } else if (memo.scope.isConnected) {
    if (!memo.scope.hasAttribute("tabindex")) memo.scope.tabIndex = -1;
    memo.scope.focus();
  }
  return true;
}

const afterPaint = (fn: () => void): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof window.requestAnimationFrame !== "function") {
    timer = setTimeout(fn, 0);
    return () => clearTimeout(timer);
  }
  const frame = window.requestAnimationFrame(() => { timer = setTimeout(fn, 0); });
  return () => {
    window.cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
};

/** Restores lost focus after a row disappears; returns a cancel function. */
export function restoreRowFocus(memo: RowMemo, onGone?: () => void): () => void {
  let observer: MutationObserver | undefined;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    observer?.disconnect();
    observer = undefined;
    clearTimeout(watchTimer);
  };
  const restore = () => {
    if (focusRow(memo)) onGone?.();
  };
  const cancelPaint = afterPaint(() => {
    if (focusLost(memo)) {
      restore();
      return;
    }
    const kept = document.activeElement as HTMLElement | null;
    const row = memo.control.closest("tr") ?? memo.control;
    if (!kept || !row.isConnected || !row.contains(kept)) return;
    observer = new MutationObserver(() => {
      if (kept.isConnected && document.activeElement === kept) return;
      stop();
      if (focusLost(memo)) restore();
    });
    const root = memo.scope.isConnected ? memo.scope : document.body;
    observer.observe(root, { childList: true, subtree: true });
    watchTimer = setTimeout(stop, ROW_LEAVE_WATCH_MS);
  });
  return () => {
    cancelPaint();
    stop();
  };
}

/** Returns focus from a details panel to its visible row control. */
export function returnFocusToRow(key: string | null, attr: string) {
  if (key === null || !document.activeElement?.closest("[data-details-for]")) return;
  Array.from(document.querySelectorAll<HTMLElement>(`[${attr}]`))
    .find((el) => el.getAttribute(attr) === key && !el.closest("[hidden]"))
    ?.focus();
}

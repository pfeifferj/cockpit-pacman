// Port of libalpm's alpm_pkg_vercmp (lib/libalpm/version.c): parseEVR splits
// epoch:version-release, then rpmvercmp compares each part segment by segment.
// Character classes are ASCII-only, matching isalnum/isdigit in the C locale.

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isAlpha = (c: string | undefined) => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isAlnum = (c: string | undefined) => isDigit(c) || isAlpha(c);

function rpmvercmp(a: string, b: string): number {
  if (a === b) return 0;

  let one = 0;
  let two = 0;
  let ptr1 = 0;
  let ptr2 = 0;

  while (one < a.length && two < b.length) {
    while (one < a.length && !isAlnum(a[one])) one++;
    while (two < b.length && !isAlnum(b[two])) two++;

    if (!(one < a.length && two < b.length)) break;

    if (one - ptr1 !== two - ptr2) {
      return one - ptr1 < two - ptr2 ? -1 : 1;
    }

    ptr1 = one;
    ptr2 = two;

    const isNum = isDigit(a[ptr1]);
    const inSegment = isNum ? isDigit : isAlpha;
    while (ptr1 < a.length && inSegment(a[ptr1])) ptr1++;
    while (ptr2 < b.length && inSegment(b[ptr2])) ptr2++;

    // Numeric segments are always newer than alpha segments.
    if (two === ptr2) return isNum ? 1 : -1;

    let seg1 = a.slice(one, ptr1);
    let seg2 = b.slice(two, ptr2);
    if (isNum) {
      seg1 = seg1.replace(/^0+/, "");
      seg2 = seg2.replace(/^0+/, "");
      if (seg1.length !== seg2.length) return seg1.length > seg2.length ? 1 : -1;
    }
    if (seg1 !== seg2) return seg1 < seg2 ? -1 : 1;

    one = ptr1;
    two = ptr2;
  }

  const restOne = one < a.length;
  const restTwo = two < b.length;
  if (!restOne && !restTwo) return 0;

  // A remaining alpha segment never beats an empty string: 1.0rc < 1.0 < 1.0.1.
  if ((!restOne && !isAlpha(b[two])) || isAlpha(a[one])) return -1;
  return 1;
}

function parseEVR(evr: string): { epoch: string; version: string; release: string | null } {
  let s = 0;
  while (s < evr.length && isDigit(evr[s])) s++;
  const dash = evr.lastIndexOf("-");
  const se = dash >= s ? dash : -1;

  let epoch = "0";
  let versionStart = 0;
  if (evr[s] === ":") {
    epoch = evr.slice(0, s) || "0";
    versionStart = s + 1;
  }
  const version = se >= 0 ? evr.slice(versionStart, se) : evr.slice(versionStart);
  const release = se >= 0 ? evr.slice(se + 1) : null;
  return { epoch, version, release };
}

/** Compare two pacman version strings like vercmp(8). Returns -1, 0 or 1. */
export function vercmp(a: string, b: string): number {
  if (a === b) return 0;
  const x = parseEVR(a);
  const y = parseEVR(b);
  let ret = rpmvercmp(x.epoch, y.epoch);
  if (ret === 0) {
    ret = rpmvercmp(x.version, y.version);
    if (ret === 0 && x.release !== null && y.release !== null) {
      ret = rpmvercmp(x.release, y.release);
    }
  }
  return ret;
}

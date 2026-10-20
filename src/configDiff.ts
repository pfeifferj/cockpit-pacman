export interface ConfigDiffLine {
  kind: "context" | "removed" | "added";
  text: string;
}

export function configurationDiff(current: string, pending: string): { lines: ConfigDiffLine[]; truncated: boolean } {
  if (current === pending) return { lines: [], truncated: false };
  const before = current.split("\n");
  const after = pending.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start &&
    before[before.length - end - 1] === after[after.length - end - 1]) end++;
  const old = before.slice(start, before.length - end);
  const next = after.slice(start, after.length - end);
  if (old.length + next.length > 2000) return { lines: [], truncated: true };
  const changed: ConfigDiffLine[] = [];
  const width = next.length + 1;
  const lengths = new Uint16Array((old.length + 1) * width);
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      lengths[i * width + j] = old[i] === next[j]
        ? 1 + lengths[(i + 1) * width + j + 1]
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < old.length || j < next.length) {
    if (i < old.length && j < next.length && old[i] === next[j]) {
      changed.push({ kind: "context", text: old[i++] });
      j++;
    } else if (i < old.length && (j === next.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      changed.push({ kind: "removed", text: old[i++] });
    } else {
      changed.push({ kind: "added", text: next[j++] });
    }
  }
  const truncated = changed.length > 1000;
  return {
    lines: [
      ...before.slice(Math.max(0, start - 3), start).map(text => ({ kind: "context" as const, text })),
      ...changed.slice(0, 1000),
      ...before.slice(before.length - end, before.length - end + 3).map(text => ({ kind: "context" as const, text })),
    ],
    truncated,
  };
}

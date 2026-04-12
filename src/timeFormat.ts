const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const THRESHOLDS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [3600, "minute"],
  [86400, "hour"],
  [2592000, "day"],
  [31536000, "month"],
  [Infinity, "year"],
];

export function parseTimestamp(input: string | number | null | undefined): Date | null {
  if (input === null || input === undefined) return null;

  if (typeof input === "number") {
    return new Date(input * 1000);
  }

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Systemd format: "Wed 2026-01-21 22:03:15 CET"
  const systemdMatch = trimmed.match(/^\w+\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (systemdMatch) {
    const date = new Date(`${systemdMatch[1]}T${systemdMatch[2]}`);
    if (!isNaN(date.getTime())) return date;
  }

  // ISO 8601 with compact offset (+0100 -> +01:00)
  const normalized = trimmed.replace(/([+-])(\d{2})(\d{2})$/, "$1$2:$3");
  const date = new Date(normalized);
  if (!isNaN(date.getTime())) return date;

  return null;
}

export function formatRelativeTime(date: Date): string {
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absDiff = Math.abs(diffSeconds);

  for (const [threshold, unit] of THRESHOLDS) {
    if (absDiff < threshold) {
      const divisor = unit === "second" ? 1
        : unit === "minute" ? 60
        : unit === "hour" ? 3600
        : unit === "day" ? 86400
        : unit === "month" ? 2592000
        : 31536000;
      const value = Math.round(diffSeconds / divisor);
      return rtf.format(value, unit);
    }
  }

  return rtf.format(Math.round(diffSeconds / 31536000), "year");
}

export function formatFullTimestamp(date: Date): string {
  return date.toLocaleString();
}

export function formatFullDate(date: Date): string {
  return date.toLocaleDateString();
}

const subscribers = new Set<() => void>();
let intervalId: number | null = null;

export function subscribeToTick(callback: () => void): () => void {
  subscribers.add(callback);
  if (!intervalId) {
    intervalId = window.setInterval(() => subscribers.forEach(cb => cb()), 60_000);
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0 && intervalId) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };
}

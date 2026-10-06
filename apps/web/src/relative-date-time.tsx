import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function refreshClock() {
  if (document.visibilityState === "hidden") return;
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(refreshClock, 30_000);
    document.addEventListener("visibilitychange", refreshClock);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", refreshClock);
    }
  };
}

function clockSnapshot() {
  return now;
}

function serverClockSnapshot() {
  return 0;
}

export function useCurrentTime() {
  return (
    useSyncExternalStore(subscribe, clockSnapshot, serverClockSnapshot) ||
    Date.now()
  );
}

export function relativeDate(value: number, current: number) {
  const difference = value - current;
  const seconds = Math.abs(difference) / 1000;
  if (seconds < 30) return difference < 0 ? "Just now" : "In a moment";
  const [unit, duration] =
    seconds < 60
      ? (["second", 1] as const)
      : seconds < 3600
        ? (["minute", 60] as const)
        : seconds < 86400
          ? (["hour", 3600] as const)
          : seconds < 604800
            ? (["day", 86400] as const)
            : seconds < 2629800
              ? (["week", 604800] as const)
              : seconds < 31557600
                ? (["month", 2629800] as const)
                : (["year", 31557600] as const);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "always" }).format(
    Math.round(difference / (duration * 1000)),
    unit,
  );
}

function absoluteDate(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function AbsoluteDateTime({
  value,
  timeZone,
  label,
  className = "",
}: {
  value: string;
  timeZone: string;
  label?: string;
  className?: string;
}) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>—</span>;
  const absolute = absoluteDate(date, timeZone);
  return (
    <time
      dateTime={value}
      title={absolute}
      aria-label={`${label ? `${label}: ` : ""}${absolute}`}
      className={`text-xs/4 font-normal tabular-nums ${className}`}
    >
      {absolute}
    </time>
  );
}

export function RelativeDateTime({
  value,
  timeZone,
  label,
  prefix,
  compact = false,
  inline = false,
  showAbsolute = true,
  className = "",
}: {
  value: string;
  timeZone: string;
  label?: string;
  prefix?: string;
  compact?: boolean;
  inline?: boolean;
  showAbsolute?: boolean;
  className?: string;
}) {
  const current = useCurrentTime();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>—</span>;
  const absolute = absoluteDate(date, timeZone);
  const relative = relativeDate(date.getTime(), current || Date.now());
  return (
    <time
      dateTime={value}
      title={absolute}
      aria-label={`${label ? `${label}: ` : ""}${relative}${showAbsolute ? `, ${absolute}` : ""}`}
      className={`${inline ? "inline-flex items-baseline gap-2 whitespace-nowrap" : "grid min-w-0 gap-0.5"} font-normal tabular-nums ${className}`}
    >
      <span className={compact ? "text-xs/4" : "text-sm/5"}>
        {prefix ? `${prefix} ${relative}` : relative}
      </span>
      {showAbsolute && <span className="text-xs/4 text-muted">{absolute}</span>}
    </time>
  );
}

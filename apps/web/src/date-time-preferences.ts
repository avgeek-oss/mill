import {
  dateFormatOptions,
  timeFormatOptions,
  defaultDateTimePreferences,
} from "@avgeek-oss/design-system/utilities/date-time-preferences";
import type {
  DateTimePreferenceOptions,
  DateTimePreferences,
} from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";

export const dateTimePreferenceOptions: DateTimePreferenceOptions = {
  dateFormats: dateFormatOptions,
  timeFormats: timeFormatOptions,
  timeZones: availableTimeZones(),
};

export function isTimeZone(value: string) {
  if (!value || value.length > 100 || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function availableTimeZones() {
  return [
    ...new Set(
      [
        "UTC",
        ...Intl.supportedValuesOf("timeZone"),
        "Asia/Kolkata",
        "Asia/Kathmandu",
        "Asia/Yangon",
        "Europe/Kyiv",
        "America/Nuuk",
        "Pacific/Kanton",
      ].filter(isTimeZone),
    ),
  ].sort((left, right) =>
    left === "UTC" ? -1 : right === "UTC" ? 1 : left.localeCompare(right),
  );
}

function dateTimeParts(value: Date | string, timeZone: string) {
  const calendarDate =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (
    typeof value === "string" &&
    !calendarDate &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return;
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) return;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
  } catch {
    return;
  }
  if (typeof value === "string") {
    const inputDate = value.slice(0, 10);
    const calendarInstant = new Date(`${inputDate}T00:00:00Z`);
    if (
      !Number.isFinite(calendarInstant.getTime()) ||
      calendarInstant.toISOString().slice(0, 10) !== inputDate
    )
      return;
  }
  const displayTimeZone = calendarDate ? "UTC" : timeZone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: displayTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  if (calendarDate) {
    [parts.year, parts.month, parts.day] = value.split("-");
  }
  const shortMonth = new Intl.DateTimeFormat("en-GB", {
    timeZone: displayTimeZone,
    month: "short",
  }).format(instant);
  return { parts, shortMonth, calendarDate };
}

function dateLabel(
  { parts, shortMonth }: NonNullable<ReturnType<typeof dateTimeParts>>,
  dateFormat: string,
) {
  const dates: Record<string, string> = {
    "day-short-month-year": `${Number(parts.day)} ${shortMonth} ${parts.year}`,
    "short-month-day-year": `${shortMonth} ${Number(parts.day)}, ${parts.year}`,
    "year-month-day": `${parts.year}-${parts.month}-${parts.day}`,
    "day-month-year": `${parts.day}/${parts.month}/${parts.year}`,
    "month-day-year": `${parts.month}/${parts.day}/${parts.year}`,
  };
  return dates[dateFormat] ?? dates[defaultDateTimePreferences.dateFormat];
}

export function formatDate(
  value: Date | string,
  {
    timeZone = defaultDateTimePreferences.timeZone,
    dateFormat = defaultDateTimePreferences.dateFormat,
  }: Partial<DateTimePreferences> = {},
) {
  const display = dateTimeParts(value, timeZone);
  return display ? dateLabel(display, dateFormat) : "—";
}

export function formatDateTime(
  value: Date | string,
  {
    timeZone = defaultDateTimePreferences.timeZone,
    dateFormat = defaultDateTimePreferences.dateFormat,
    timeFormat = defaultDateTimePreferences.timeFormat,
  }: Partial<DateTimePreferences> = {},
) {
  const display = dateTimeParts(value, timeZone);
  if (!display) return "—";
  const date = dateLabel(display, dateFormat);
  if (display.calendarDate) return date;
  const { parts } = display;
  const twelveHour = timeFormat.startsWith("12");
  const seconds = timeFormat.endsWith("seconds") ? `:${parts.second}` : "";
  const hour = Number(parts.hour);
  const time = `${twelveHour ? hour % 12 || 12 : parts.hour}:${parts.minute}${seconds}${twelveHour ? (hour < 12 ? " AM" : " PM") : ""}`;
  return `${time}, ${date}`;
}

export function dateTimePreview(
  value: DateTimePreferences,
  instant = new Date(),
) {
  return formatDateTime(instant, value);
}

import type {
  DateTimePreferenceOptions,
  DateTimePreferences,
} from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";

export const dateTimePreferenceOptions: DateTimePreferenceOptions = {
  dateFormats: [
    { id: "day-short-month-year", label: "6 Oct 2026" },
    { id: "day-month-year", label: "06/10/2026" },
    { id: "month-day-year", label: "10/06/2026" },
    { id: "year-month-day", label: "2026-10-06" },
  ],
  timeFormats: [
    { id: "24-hour", label: "24-hour (14:30)" },
    { id: "12-hour", label: "12-hour (2:30 PM)" },
  ],
  timeZones: ["UTC", ...Intl.supportedValuesOf("timeZone")],
};

export function dateTimePreview(value: DateTimePreferences) {
  const instant = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: value.timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const day = part("day");
  const month = part("month");
  const year = part("year");
  const date =
    value.dateFormat === "year-month-day"
      ? `${year}-${month}-${day}`
      : value.dateFormat === "month-day-year"
        ? `${month}/${day}/${year}`
        : value.dateFormat === "day-month-year"
          ? `${day}/${month}/${year}`
          : new Intl.DateTimeFormat("en-GB", {
              timeZone: value.timeZone,
              day: "numeric",
              month: "short",
              year: "numeric",
            }).format(instant);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: value.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: value.timeFormat === "12-hour",
  }).format(instant);
  return `${date}, ${time}`;
}

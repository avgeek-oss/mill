import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableTimeZones,
  dateTimePreferenceOptions,
  formatDate,
  formatDateTime,
  isTimeZone,
} from "../apps/web/src/date-time-preferences.js";

const example = new Date("2026-09-16T14:30:45.000Z");

test("all displayed preference examples format the same fixed instant", () => {
  assert.deepEqual(
    dateTimePreferenceOptions.dateFormats.map(({ id }) => id),
    [
      "day-short-month-year",
      "short-month-day-year",
      "year-month-day",
      "day-month-year",
      "month-day-year",
    ],
  );
  assert.deepEqual(
    dateTimePreferenceOptions.timeFormats.map(({ id }) => id),
    ["24-hour", "12-hour", "24-hour-seconds", "12-hour-seconds"],
  );
  for (const date of dateTimePreferenceOptions.dateFormats) {
    for (const time of dateTimePreferenceOptions.timeFormats) {
      const preferences = {
        dateFormat: date.id,
        timeFormat: time.id,
        timeZone: "UTC",
      };
      const expected = `${time.label}, ${date.label}`;
      assert.equal(formatDateTime(example, preferences), expected);
    }
  }
});

test("optional preferences keep the common defaults and stable stored IDs", () => {
  assert.equal(formatDateTime(example), "14:30, 16 Sept 2026");
  assert.equal(
    formatDateTime(example, { dateFormat: "month-day-year" }),
    "14:30, 09/16/2026",
  );
  assert.equal(
    formatDateTime(example, { timeFormat: "12-hour" }),
    "2:30 PM, 16 Sept 2026",
  );
  assert.equal(dateTimePreferenceOptions.timeZones[0], "UTC");
  assert.equal(formatDateTime(new Date("invalid")), "—");
});

test("12-hour noon and midnight and 24-hour midnight have exact semantics", () => {
  for (const [instant, expected12, expected24] of [
    ["2026-09-16T00:05:09Z", "12:05:09 AM", "00:05:09"],
    ["2026-09-16T12:05:09Z", "12:05:09 PM", "12:05:09"],
    ["2026-09-16T23:05:09Z", "11:05:09 PM", "23:05:09"],
  ]) {
    assert.equal(
      formatDateTime(new Date(instant), { timeFormat: "12-hour-seconds" }),
      `${expected12}, 16 Sept 2026`,
    );
    assert.equal(
      formatDateTime(new Date(instant), { timeFormat: "24-hour-seconds" }),
      `${expected24}, 16 Sept 2026`,
    );
  }
});

test("timezone date rollover, fractional offsets and daylight saving stay coherent", () => {
  assert.equal(
    formatDateTime(new Date("2026-09-16T00:05:09Z"), {
      timeZone: "America/Los_Angeles",
      dateFormat: "short-month-day-year",
      timeFormat: "12-hour-seconds",
    }),
    "5:05:09 PM, Sept 15, 2026",
  );
  assert.equal(
    formatDateTime(new Date("2026-12-31T23:45:09Z"), {
      timeZone: "Asia/Kathmandu",
      dateFormat: "year-month-day",
      timeFormat: "24-hour-seconds",
    }),
    "05:30:09, 2027-01-01",
  );
  assert.equal(
    formatDateTime(new Date("2026-03-08T06:59:59Z"), {
      timeZone: "America/New_York",
      timeFormat: "12-hour-seconds",
    }),
    "1:59:59 AM, 8 Mar 2026",
  );
  assert.equal(
    formatDateTime(new Date("2026-03-08T07:00:00Z"), {
      timeZone: "America/New_York",
      timeFormat: "12-hour-seconds",
    }),
    "3:00:00 AM, 8 Mar 2026",
  );
});

test("calendar dates keep their literal day across every display format and timezone", () => {
  for (const date of dateTimePreferenceOptions.dateFormats) {
    for (const timeZone of [
      "UTC",
      "America/Los_Angeles",
      "Pacific/Kiritimati",
    ]) {
      const preferences = { dateFormat: date.id, timeZone };
      assert.equal(formatDate("2026-09-16", preferences), date.label);
      assert.equal(formatDateTime("2026-09-16", preferences), date.label);
    }
  }
  assert.equal(formatDate("2024-02-29"), "29 Feb 2024");
  assert.equal(formatDate("2026-09-16"), "16 Sept 2026");
  for (const invalid of [
    "",
    "invalid",
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-00-16",
    "2026-13-16",
    "2026-09-00",
    "2026-09-32",
    "2026-9-16",
    "2026-09-16T00:00:00",
    "2026-02-30T00:00:00Z",
  ]) {
    assert.equal(formatDate(invalid), "—", invalid);
    assert.equal(formatDateTime(invalid), "—", invalid);
  }
});

test("date-only timestamp presentation honors timezone and date preference", () => {
  const timestamp = "2026-09-16T00:05:09Z";
  assert.equal(formatDate(timestamp), "16 Sept 2026");
  assert.equal(
    formatDate(timestamp, {
      timeZone: "America/Los_Angeles",
      dateFormat: "short-month-day-year",
    }),
    "Sept 15, 2026",
  );
  assert.equal(
    formatDate(new Date("2026-12-31T23:45:09Z"), {
      timeZone: "Asia/Kathmandu",
      dateFormat: "year-month-day",
    }),
    "2027-01-01",
  );
});

test("timezones include supported current aliases once, sorted after UTC", () => {
  const timeZones = availableTimeZones();
  assert.equal(timeZones[0], "UTC");
  assert.equal(new Set(timeZones).size, timeZones.length);
  assert.deepEqual(
    timeZones.slice(1),
    timeZones.slice(1).sort((left, right) => left.localeCompare(right)),
  );
  for (const alias of [
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Asia/Yangon",
    "Europe/Kyiv",
    "America/Nuuk",
    "Pacific/Kanton",
  ]) {
    assert.equal(isTimeZone(alias), true, alias);
    assert.equal(timeZones.filter((zone) => zone === alias).length, 1, alias);
  }
  assert.equal(isTimeZone("Asia/Calcutta"), true);
  assert.equal(isTimeZone("UTC"), true);
  for (const invalid of [
    "",
    "x".repeat(101),
    "+05:30",
    "-08:00",
    "No/Such_Zone",
  ]) {
    assert.equal(isTimeZone(invalid), false, invalid);
  }
  assert.deepEqual(dateTimePreferenceOptions.timeZones, timeZones);
});

test("stored legacy offset timezones and aliases remain displayable", () => {
  const timestamp = "2026-09-16T22:45:09Z";
  assert.equal(formatDate(timestamp, { timeZone: "+05:30" }), "17 Sept 2026");
  assert.equal(
    formatDateTime(timestamp, { timeZone: "+05:30" }),
    "04:15, 17 Sept 2026",
  );
  assert.equal(
    formatDateTime(timestamp, { timeZone: "-03:00" }),
    "19:45, 16 Sept 2026",
  );
  assert.equal(
    formatDate(timestamp, { timeZone: "Asia/Calcutta" }),
    "17 Sept 2026",
  );
  assert.equal(
    formatDateTime(timestamp, { timeZone: "Asia/Calcutta" }),
    "04:15, 17 Sept 2026",
  );
  assert.equal(formatDate(timestamp, { timeZone: "No/Such_Zone" }), "—");
  assert.equal(formatDateTime(timestamp, { timeZone: "No/Such_Zone" }), "—");
  assert.equal(isTimeZone("+05:30"), false);
  assert.equal(isTimeZone("-03:00"), false);
  assert.equal(availableTimeZones().includes("+05:30"), false);
});

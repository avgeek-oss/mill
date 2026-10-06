import assert from "node:assert/strict";
import test from "node:test";
import { timeZoneOffset } from "../apps/web/src/time-zone.js";

test("time zone offsets retain signs and fractional hours without a prefix", () => {
  const date = new Date("2026-01-15T12:00:00Z");
  assert.equal(timeZoneOffset("UTC", date), "+00:00");
  assert.equal(timeZoneOffset("Asia/Kolkata", date), "+05:30");
  assert.equal(timeZoneOffset("Asia/Kathmandu", date), "+05:45");
  assert.equal(timeZoneOffset("America/St_Johns", date), "−03:30");
});

test("time zone offsets reflect daylight saving at the supplied date", () => {
  assert.equal(
    timeZoneOffset("America/New_York", new Date("2026-01-15T12:00:00Z")),
    "−05:00",
  );
  assert.equal(
    timeZoneOffset("America/New_York", new Date("2026-07-15T12:00:00Z")),
    "−04:00",
  );
});

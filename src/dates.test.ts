import { afterEach, beforeEach, expect, test } from "bun:test";
import { formatDate, isCalendarDate } from "./dates.ts";

let zone: string | undefined;
beforeEach(() => {
  zone = process.env.TZ;
  // Behind UTC, where midnight UTC is still the day before.
  process.env.TZ = "America/Los_Angeles";
});
afterEach(() => {
  process.env.TZ = zone;
});

test("a calendar date shows as that day, even where midnight UTC is still the day before", () => {
  expect(formatDate("2026-03-04", "en-GB")).toBe("4 Mar 2026");
});

test("a moment shows as the day it was where the reader is", () => {
  expect(formatDate("2026-01-02T03:04:05.000Z", "en-GB")).toBe("1 Jan 2026");
});

test.each([
  ["2026-03-04", true],
  ["2024-02-29", true],
  ["2026-02-29", false],
  ["2026-13-01", false],
  ["2026-03", false],
  ["4 March 2026", false],
  [null, false],
])("isCalendarDate(%p) is %p", (value, expected) => {
  expect(isCalendarDate(value)).toBe(expected);
});

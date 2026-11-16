/**
 * Calendar dates as Zayla keeps them: `yyyy-mm-dd`, a day with no time and no
 * time zone. Shared by the server, which checks the dates it is given, and the
 * browser, which shows them.
 */

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date as a reader would write it: a calendar date as that very day, and a
 * moment (an ISO timestamp) as the day it was where the reader is. A calendar
 * date is not read as midnight UTC, which behind UTC is the day before.
 */
export function formatDate(value: string, locale?: string): string {
  const m = CALENDAR_DATE.exec(value);
  const day = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(value);
  return day.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Whether `value` is a day that exists, written `yyyy-mm-dd`. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = CALENDAR_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return (
    day.getUTCFullYear() === y &&
    day.getUTCMonth() === mo - 1 &&
    day.getUTCDate() === d
  );
}

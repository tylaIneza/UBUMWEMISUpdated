/**
 * Date-only values (contract dates, billing periods, due dates) are represented as a
 * JS Date at 00:00:00 UTC, which is how Prisma maps DATE columns. All helpers here are
 * pure UTC arithmetic so results never depend on the server's local time zone.
 */

const DAY_MS = 86_400_000;

export function parseDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Invalid date: ${iso}`);
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`Invalid date: ${iso}`);
  return d;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

export function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

export function addMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
}

/** Every billing period (first-of-month) from the month of `from` to the month of `to`, inclusive. */
export function monthsBetween(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let m = startOfMonth(from); m.getTime() <= startOfMonth(to).getTime(); m = addMonths(m, 1)) out.push(m);
  return out;
}

/** The given day-of-month within the period's month, clamped to the month's length (e.g. 31 → 28 Feb). */
export function dayInMonth(period: Date, day: number): Date {
  const last = endOfMonth(period).getUTCDate();
  return new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), Math.min(Math.max(day, 1), last)));
}

/** Today's calendar date in the organization's time zone, as a UTC-midnight Date. */
export function businessDate(timezone: string, at: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return parseDate(parts);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "March 2026" */
export function periodLabel(period: Date): string {
  return `${MONTHS[period.getUTCMonth()]} ${period.getUTCFullYear()}`;
}

/** "01 October 2026" */
export function longDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

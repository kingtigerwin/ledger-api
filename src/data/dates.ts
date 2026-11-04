// Calendar dates as the API writes them, YYYY-MM-DD, with no time zone: the customer's own day.

/**
 * How far back the rules that read a whole range go: a little over a year, so a yearly bill shows up
 * twice. It also bounds what one purchase search reads.
 */
export const LOOKBACK_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

export const parseDate = (date: string) => new Date(`${date}T00:00:00Z`);
export const formatDate = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => formatDate(new Date(parseDate(date).getTime() + days * DAY_MS));
export const daysBetween = (from: string, to: string) => Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);

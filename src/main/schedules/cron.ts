// Five-field cron expressions (minute hour day-of-month month day-of-week) in local time.
// Next-run search walks local calendar days and builds each candidate from local fields, so daylight-saving
// changes come out right: a wall-clock time that does not exist that day is skipped, and one that occurs twice
// is only ever built once (the runtime resolves it to a single instant), so it fires once.

import { ScheduleError } from './errors';

export interface CronSpec {
  expr: string;
  minutes: number[];
  hours: number[];
  /** 1–31 */
  days: number[];
  /** 1–12 */
  months: number[];
  /** 0–6, Sunday = 0 */
  weekdays: number[];
  /** A field written starting with '*' counts as unrestricted for the day-of-month / day-of-week rule (as in Vixie cron) */
  domStar: boolean;
  dowStar: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** The longest a month can be (February counts 29, so a 29 Feb schedule is valid) */
const MONTH_MAX = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Recurring schedules may not fire more often than this */
export const MIN_INTERVAL_MINUTES = 5;
/** How far ahead a next run is searched; 29 Feb on a given weekday can be years away, never more than this */
const HORIZON_DAYS = 366 * 9;

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a name's index (months are 1-based) */
  nameBase?: number;
}

const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  // 7 is accepted as Sunday and folded to 0 below
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

function bad(expr: string, why: string): never {
  throw new ScheduleError('bad_cron', `"${expr}" is not a valid cron expression: ${why}. Use five fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5".`);
}

function value(expr: string, f: FieldDef, token: string): number {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    if (n < f.min || n > f.max) bad(expr, `${f.name} ${n} is outside ${f.min}-${f.max}`);
    return n;
  }
  const i = f.names ? f.names.indexOf(token.toLowerCase()) : -1;
  if (i < 0) bad(expr, `"${token}" is not a valid ${f.name}`);
  return i + (f.nameBase ?? 0);
}

function parseField(expr: string, f: FieldDef, text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    if (!part) bad(expr, `empty item in the ${f.name} field`);
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) bad(expr, `"${part}" is not a valid ${f.name}`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) bad(expr, `step 0 in the ${f.name} field`);
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = f.min;
      hi = f.max;
    } else if (m[1].includes('-')) {
      const [a, b, extra] = m[1].split('-');
      if (extra !== undefined || !a || !b) bad(expr, `"${m[1]}" is not a valid range`);
      lo = value(expr, f, a);
      hi = value(expr, f, b);
      if (lo > hi) bad(expr, `range ${m[1]} runs backwards`);
    } else {
      lo = value(expr, f, m[1]);
      // "5/15" means from 5 to the end, every 15
      hi = m[2] === undefined ? lo : f.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parses and checks an expression; throws ScheduleError bad_cron / frequency_too_high. */
export function parseCron(input: string): CronSpec {
  const expr = String(input ?? '').trim().replace(/\s+/g, ' ');
  const parts = expr ? expr.split(' ') : [];
  if (parts.length !== 5) bad(expr, `it has ${parts.length} field${parts.length === 1 ? '' : 's'}, not 5`);
  const [minutes, hours, days, months, rawWeekdays] = parts.map((p, i) => parseField(expr, FIELDS[i], p));
  const weekdays = [...new Set(rawWeekdays.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  const spec: CronSpec = { expr, minutes, hours, days, months, weekdays, domStar: parts[2].startsWith('*'), dowStar: parts[4].startsWith('*') };
  if (neverFires(spec)) bad(expr, 'it can never fire (no month has that day)');
  const gap = minGapMinutes(spec);
  if (gap < MIN_INTERVAL_MINUTES) {
    throw new ScheduleError('frequency_too_high', `"${expr}" would run every ${gap} minute${gap === 1 ? '' : 's'}; schedules may run at most every ${MIN_INTERVAL_MINUTES} minutes.`);
  }
  return spec;
}

/** Only a day-of-month list that fits none of the chosen months (with the weekday field left open) can never match. */
function neverFires(s: CronSpec): boolean {
  if (s.domStar || !s.dowStar) return false;
  return !s.months.some((m) => s.days.some((d) => d <= MONTH_MAX[m - 1]));
}

/**
 * The shortest wall-clock gap between two firings. Within one hour that is the smallest step between listed minutes;
 * across the hour boundary it applies only when two consecutive hours (or 23 and 0) can both fire.
 */
function minGapMinutes(s: CronSpec): number {
  const ms = s.minutes;
  let gap = Infinity;
  for (let i = 1; i < ms.length; i++) gap = Math.min(gap, ms[i] - ms[i - 1]);
  const hs = new Set(s.hours);
  const consecutive = s.hours.some((h) => hs.has((h + 1) % 24));
  if (consecutive) gap = Math.min(gap, 60 - ms[ms.length - 1] + ms[0]);
  return gap;
}

function dayMatches(s: CronSpec, date: number, weekday: number): boolean {
  const dom = s.days.includes(date);
  const dow = s.weekdays.includes(weekday);
  // Standard cron: when both day fields are restricted, either one matching is enough
  if (!s.domStar && !s.dowStar) return dom || dow;
  return dom && dow;
}

/** The first firing strictly after `after` (Unix ms), or null when none is found within the horizon. */
export function nextCron(s: CronSpec, after: number): number | null {
  const start = new Date(after);
  let y = start.getFullYear();
  let mo = start.getMonth();
  let d = start.getDate();
  for (let i = 0; i < HORIZON_DAYS; i++) {
    // Noon exists on every day in every zone, unlike midnight
    const noon = new Date(y, mo, d, 12);
    y = noon.getFullYear();
    mo = noon.getMonth();
    d = noon.getDate();
    if (s.months.includes(mo + 1) && dayMatches(s, d, noon.getDay())) {
      for (const h of s.hours) {
        for (const mi of s.minutes) {
          const t = new Date(y, mo, d, h, mi);
          // A wall-clock time skipped by a spring-forward change comes back shifted: it does not exist, skip it
          if (t.getDate() !== d || t.getHours() !== h || t.getMinutes() !== mi) continue;
          if (t.getTime() > after) return t.getTime();
        }
      }
    }
    d += 1;
  }
  return null;
}

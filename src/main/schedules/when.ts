// The three rhythms (once at a time, every N minutes, cron): validation, next-run computation and the short
// human phrase shown in the window, the tools and the approval card.

import type { ScheduleWhen } from '../../shared/schedules';
import { MIN_INTERVAL_MINUTES, nextCron, parseCron, type CronSpec } from './cron';
import { ScheduleError } from './errors';

const MINUTE = 60_000;
/** Longest `every` interval accepted: a year */
const MAX_EVERY_MINUTES = 366 * 24 * 60;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_PLURALS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
// An explicit offset or Z is required: a bare local time is ambiguous for a model that may not know the user's zone
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** Unix ms of an ISO date-time with an offset; throws bad_time. */
export function parseAt(at: string): number {
  const m = ISO_WITH_OFFSET.exec(String(at ?? '').trim());
  if (!m) throw new ScheduleError('bad_time', `"${at}" is not an ISO date-time with an offset, e.g. "2026-11-06T09:00:00-05:00" or "2026-11-06T14:00:00Z".`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  const monthDays = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > monthDays || h > 23 || mi > 59 || s > 59) throw new ScheduleError('bad_time', `"${at}" is not a real date and time.`);
  const t = Date.parse(m[0].replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(t)) throw new ScheduleError('bad_time', `"${at}" could not be read as a date-time.`);
  return t;
}

/** Checks a rhythm and normalises it (trimmed cron, integer minutes). Throws ScheduleError. */
export function normalizeWhen(when: ScheduleWhen, now: number): ScheduleWhen {
  if (!when || typeof when !== 'object') throw new ScheduleError('bad_time', 'when is missing: give at, every or cron.');
  if (when.kind === 'at') {
    const t = parseAt(when.at);
    if (t <= now) throw new ScheduleError('not_future', `${when.at} is in the past (it is now ${new Date(now).toISOString()}).`);
    return { kind: 'at', at: String(when.at).trim() };
  }
  if (when.kind === 'every') {
    const n = Number(when.minutes);
    if (!Number.isFinite(n) || n <= 0) throw new ScheduleError('bad_time', `every needs a positive number of minutes, not ${when.minutes}.`);
    if (n < MIN_INTERVAL_MINUTES) throw new ScheduleError('frequency_too_high', `every ${n} minutes is too often; schedules may run at most every ${MIN_INTERVAL_MINUTES} minutes.`);
    if (n > MAX_EVERY_MINUTES) throw new ScheduleError('bad_time', `every ${n} minutes is longer than a year; use cron or a one-off time instead.`);
    return { kind: 'every', minutes: Math.round(n) };
  }
  if (when.kind === 'cron') return { kind: 'cron', expr: parseCron(when.expr).expr };
  throw new ScheduleError('bad_time', 'when.kind must be at, every or cron.');
}

const specCache = new Map<string, CronSpec>();
function spec(expr: string): CronSpec {
  let s = specCache.get(expr);
  if (!s) {
    s = parseCron(expr);
    if (specCache.size > 200) specCache.clear();
    specCache.set(expr, s);
  }
  return s;
}

export const isRecurring = (when: ScheduleWhen) => when.kind !== 'at';

/** The first run of a (valid) rhythm created or changed at `now`. */
export function firstRun(when: ScheduleWhen, now: number): number | null {
  if (when.kind === 'at') return parseAt(when.at);
  if (when.kind === 'every') return now + when.minutes * MINUTE;
  return nextCron(spec(when.expr), now);
}

/**
 * The next run of a recurring rhythm after `now`. `every` keeps its phase: it steps from the run that was due
 * rather than from the moment it happened to fire, so a schedule set for :00/:30 stays on :00/:30.
 */
export function nextAfter(when: ScheduleWhen, due: number, now: number): number | null {
  if (when.kind === 'at') return null;
  if (when.kind === 'every') {
    const step = when.minutes * MINUTE;
    if (due > now) return due;
    return due + (Math.floor((now - due) / step) + 1) * step;
  }
  return nextCron(spec(when.expr), now);
}

/** Whether a recurring rhythm had an occurrence in (from, to]. `due` is a known occurrence at or before `to`. */
export function occursBetween(when: ScheduleWhen, due: number, from: number, to: number): boolean {
  if (when.kind === 'at') return due > from && due <= to;
  if (when.kind === 'every') {
    const step = when.minutes * MINUTE;
    const newest = due + Math.floor((to - due) / step) * step;
    return newest > from && newest <= to;
  }
  const t = nextCron(spec(when.expr), from);
  return t !== null && t <= to;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/** "Fri Nov 6 09:00", in local time; the year is added when it is not the current one. */
export function formatLocal(t: number, now = Date.now()): string {
  const d = new Date(t);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}${year} ${hhmm(d.getHours(), d.getMinutes())}`;
}

function plural(n: number, unit: string): string {
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
}

function describeCron(expr: string): string {
  const [mi, h, dom, mon, dow] = expr.split(' ');
  const num = (f: string) => /^\d+$/.test(f);
  const list = (f: string) => /^\d+(,\d+)*$/.test(f);
  const step = /^\*\/(\d+)$/;
  if (dom === '*' && mon === '*') {
    if (dow === '*' && h === '*' && step.test(mi) && 60 % Number(step.exec(mi)![1]) === 0) return plural(Number(step.exec(mi)![1]), 'minute');
    if (dow === '*' && h === '*' && num(mi)) return `every hour at :${pad(Number(mi))}`;
    if (dow === '*' && step.test(h) && num(mi) && 24 % Number(step.exec(h)![1]) === 0) return `${plural(Number(step.exec(h)![1]), 'hour')} at :${pad(Number(mi))}`;
    if (num(mi) && list(h) && h.split(',').length <= 4) {
      const at = joinWords(h.split(',').map((x) => hhmm(Number(x), Number(mi))));
      if (dow === '*') return `every day at ${at}`;
      const days = spec(expr).weekdays;
      const key = days.join(',');
      if (key === '1,2,3,4,5') return `weekdays at ${at}`;
      if (key === '0,6') return `weekends at ${at}`;
      if (days.length <= 3) return `${joinWords(days.map((d) => DAY_PLURALS[d]))} at ${at}`;
    }
  }
  if (num(mi) && num(h) && num(dom) && mon === '*' && dow === '*') return `monthly on the ${ordinal(Number(dom))} at ${hhmm(Number(h), Number(mi))}`;
  return expr;
}

/** "every 30 minutes", "every day at 09:00", "weekdays at 09:00", "once on Nov 6 at 09:00"; unusual cron stays raw. */
export function describeWhen(when: ScheduleWhen, now = Date.now()): string {
  if (when.kind === 'at') {
    const d = new Date(parseAt(when.at));
    const year = d.getFullYear() !== new Date(now).getFullYear() ? `, ${d.getFullYear()}` : '';
    return `once on ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}${year} at ${hhmm(d.getHours(), d.getMinutes())}`;
  }
  if (when.kind === 'every') {
    const n = when.minutes;
    if (n % 1440 === 0) return plural(n / 1440, 'day');
    if (n % 60 === 0) return plural(n / 60, 'hour');
    return plural(n, 'minute');
  }
  return describeCron(when.expr);
}

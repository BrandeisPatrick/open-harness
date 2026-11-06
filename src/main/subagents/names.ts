// Finding a session by what the user calls it: an id, the start of an id, or its name written loosely ("tcg fork",
// "TCG (fork)" and tcg-fork all name a session titled "tcg (fork)"). Pure functions; the Subagents service applies
// them to every session not in the trash (service.ts, find/matches).

/**
 * How a query matched a session, best first; the first tier with a hit wins. 'exact name' is the name as written,
 * 'name' the same ignoring case, quotes, punctuation and spacing.
 */
export const TIERS = ['id', 'id prefix', 'exact name', 'name', 'name prefix', 'all words', 'spelling'] as const;
export type Tier = (typeof TIERS)[number];

/** The shortest id prefix taken as an id */
export const MIN_ID_PREFIX = 6;

const QUOTES = /^["'`“”‘’«»]+|["'`“”‘’«»]+$/g;

/** The query without surrounding space and quotes */
export function unquote(s: string): string {
  return String(s ?? '').trim().replace(QUOTES, '').trim();
}

/** A name for comparing: lower case, punctuation and runs of spaces as one space. */
export function normName(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Edit distance (insert, delete, change, swap two neighbours) between two strings, or `max + 1` as soon as it is
 * known to be over `max`.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[y.length];
}

/** How many edits still count as a misspelling of a name this long: none under 4 characters, 1 under 8, else 2. */
export function spellingSlack(name: string): number {
  const n = Array.from(name).length;
  return n < 4 ? 0 : n < 8 ? 1 : 2;
}

/** The best tier at which `query` names the session, or null. */
export function matchTier(query: string, s: { id: string; title: string }): Tier | null {
  const key = unquote(query);
  if (!key) return null;
  if (s.id === key) return 'id';
  if (key.length >= MIN_ID_PREFIX && s.id.toLowerCase().startsWith(key.toLowerCase())) return 'id prefix';
  if (s.title === key) return 'exact name';
  const q = normName(key);
  if (!q) return null;
  const t = normName(s.title);
  if (t === q) return 'name';
  if (t.startsWith(q)) return 'name prefix';
  if (q.split(' ').every((w) => t.includes(w))) return 'all words';
  if (editDistance(q, t, spellingSlack(q)) <= spellingSlack(q)) return 'spelling';
  return null;
}

/** How far a name is from the query, for "closest names" when nothing matched. */
export function nameDistance(query: string, title: string): number {
  const q = normName(unquote(query));
  const t = normName(title);
  // The start of a long title counts as much as the whole of it: "deploy scrpt" is near "deploy script for staging"
  return Math.min(editDistance(q, t), editDistance(q, Array.from(t).slice(0, Array.from(q).length).join('')) + 1);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

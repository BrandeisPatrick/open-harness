// Mod stylesheets on the app's own page: a small top-level splitter, and what the app does with a mod's CSS before
// the window gets it. A look's CSS is wrapped in `@scope (<region root>) { … }` so its selectors reach only that
// region; the at-rules that cannot live inside @scope (@keyframes, @font-face, …) are hoisted out of it; @import is
// dropped (a stylesheet a mod adds may not pull in others); relative url()s point at the mod's own files.
//
// The splitter is not a CSS parser. It knows just enough to find where each top-level statement ends: strings,
// comments, escapes, url(…) and nested braces. It also repairs what could otherwise let a look out of its scope: a
// stray "}" is dropped, an unclosed block, string or comment is closed, and comments are removed, so the "}" the
// app adds after a look always closes the app's own @scope.

export interface CssStatement {
  /** rule: a style rule (or anything that is not an at-rule). at: an at-rule. */
  kind: 'rule' | 'at';
  /** at: the at-keyword in lower case, without "@" ("media", "keyframes", "-webkit-keyframes"); rule: "" */
  name: string;
  /** The statement as written (without comments), from its first character to its closing "}" or ";" */
  text: string;
  /** at with a block: what comes before "{" ("@media (width > 600px)"); otherwise "" */
  prelude: string;
  /** at with a block: what is between the braces; otherwise "" */
  body: string;
}

export interface CssOptions {
  /** Rewrites the address in a url(…); null leaves it as it is */
  url?: (address: string) => string | null;
}

/** At-rules that are invalid inside @scope (or mean nothing there) and are kept by moving them in front of it. */
export const HOISTED_AT_RULES: readonly string[] = ['keyframes', '-webkit-keyframes', 'font-face', 'property', 'counter-style', 'font-feature-values', 'font-palette-values'];
/** At-rules a mod's stylesheet may not use at all: they would load more CSS or reach outside the page's styling. */
export const DROPPED_AT_RULES: readonly string[] = ['import', 'charset', 'namespace', 'page'];
/** Grouping at-rules whose bodies are split again, so a @keyframes inside @media is hoisted too. */
const GROUPING_AT_RULES: readonly string[] = ['media', 'supports', 'layer', 'container'];
const MAX_DEPTH = 8;

/** An identifier with its CSS escapes resolved ("\\75 rl" → "url") */
function unescapeIdent(ident: string): string {
  return ident.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16)) || 0xfffd) : (ch ?? '')));
}

/** Reads a string starting at css[i] (a quote) and returns it closed, and the index after it. A newline ends it, as in CSS. */
function readString(css: string, i: number): { text: string; end: number; value: string } {
  const q = css[i];
  let j = i + 1;
  let value = '';
  while (j < css.length) {
    const c = css[j];
    if (c === '\\') {
      value += css.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (c === q) return { text: q + value + q, end: j + 1, value };
    if (c === '\n' || c === '\r' || c === '\f') break;
    value += c;
    j++;
  }
  return { text: q + value + q, end: j, value }; // unterminated: closed here
}

/**
 * Splits CSS into its top-level statements. Comments are removed; an unclosed block, string, comment or url( is
 * closed; a "}" that closes nothing is dropped; empty statements are left out.
 */
export function splitCss(css: string, opts: CssOptions = {}): CssStatement[] {
  const src = String(css ?? '').replace(/^﻿/, '');
  const out: CssStatement[] = [];
  let buf = '';
  let depth = 0;
  const push = () => {
    let text = buf.trim();
    buf = '';
    if (!text) return;
    if (depth > 0) text += '}'.repeat(depth);
    depth = 0;
    out.push(describe(text));
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 2;
      buf += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      const s = readString(src, i);
      buf += s.text;
      i = s.end;
      continue;
    }
    if (c === '\\') {
      // A backslash at the very end escapes nothing; dropped, so it cannot escape the "}" that closes the statement.
      if (i + 1 < src.length) buf += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '(') {
      // "url(" (in any case, with escapes like "\\75 rl(" too: the browser reads those as url( as well) starts a url token
      const ident = /(?:[\w-]|\\[0-9a-fA-F]{1,6}\s?|\\[^\n0-9a-fA-F])+$/.exec(buf)?.[0] ?? '';
      if (ident && unescapeIdent(ident).toLowerCase() === 'url') {
        buf = buf.slice(0, buf.length - ident.length);
        const u = readUrl(src, i + 1);
        const rewritten = opts.url ? opts.url(u.value) : null;
        buf += rewritten !== null && rewritten !== undefined ? `url(${JSON.stringify(rewritten)})` : u.text;
        i = u.end;
        continue;
      }
    }
    if (c === '{') {
      depth++;
      buf += c;
      i++;
      continue;
    }
    if (c === '}') {
      i++;
      if (depth === 0) continue; // closes nothing: dropped, so it cannot close a block the app opened
      depth--;
      buf += c;
      if (depth === 0) push();
      continue;
    }
    if (c === ';' && depth === 0) {
      buf += c;
      i++;
      push();
      continue;
    }
    buf += c;
    i++;
  }
  push();
  return out;
}

/** Reads what follows "url(" at i: the address (quoted or not) and the closed url(…) text. */
function readUrl(css: string, i: number): { text: string; end: number; value: string } {
  let j = i;
  while (j < css.length && /\s/.test(css[j])) j++;
  if (css[j] === '"' || css[j] === "'") {
    const s = readString(css, j);
    j = s.end;
    let k = j;
    while (k < css.length && /\s/.test(css[k])) k++;
    // Closed by its ")", or closed here: whatever else follows is read by the splitter as ordinary text.
    if (css[k] === ')') j = k + 1;
    return { text: `url(${s.text})`, end: j, value: s.value };
  }
  let value = '';
  while (j < css.length && css[j] !== ')') {
    if (css[j] === '\\') {
      value += css.slice(j, j + 2);
      j += 2;
      continue;
    }
    value += css[j++];
  }
  if (css[j] === ')') j++;
  return { text: `url(${value})`, end: j, value: value.trim() };
}

function describe(text: string): CssStatement {
  if (text[0] !== '@') return { kind: 'rule', name: '', text, prelude: '', body: '' };
  const name = (/^@(-?[A-Za-z][\w-]*)/.exec(text)?.[1] ?? '').toLowerCase();
  if (!text.endsWith('}')) return { kind: 'at', name, text, prelude: '', body: '' };
  const open = blockStart(text);
  if (open < 0) return { kind: 'at', name, text, prelude: '', body: '' };
  return { kind: 'at', name, text, prelude: text.slice(0, open).trim(), body: text.slice(open + 1, -1) };
}

/** The index of the "{" that opens a statement's block (outside strings). */
function blockStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '"' || c === "'") i = readString(text, i).end - 1;
    else if (c === '{') return i;
  }
  return -1;
}

/** Separates what must sit outside @scope from what goes inside it; dropped at-rules go nowhere. */
function partition(statements: CssStatement[], depth: number): { hoisted: string[]; scoped: string[] } {
  const hoisted: string[] = [];
  const scoped: string[] = [];
  for (const s of statements) {
    if (s.kind === 'at' && DROPPED_AT_RULES.includes(s.name)) continue;
    if (s.kind === 'at' && HOISTED_AT_RULES.includes(s.name)) {
      hoisted.push(s.text);
      continue;
    }
    if (s.kind === 'at' && s.prelude && GROUPING_AT_RULES.includes(s.name) && depth < MAX_DEPTH) {
      const inner = partition(splitCss(s.body), depth + 1);
      if (inner.hoisted.length) hoisted.push(`${s.prelude} {\n${inner.hoisted.join('\n')}\n}`);
      if (inner.scoped.length) scoped.push(`${s.prelude} {\n${inner.scoped.join('\n')}\n}`);
      continue;
    }
    scoped.push(s.text);
  }
  return { hoisted, scoped };
}

/**
 * A look's CSS for the window: everything inside `@scope (<root>) { … }`, the at-rules that cannot be inside it in
 * front, @import and the other dropped at-rules removed. Inside, `:scope` is the region's root element.
 */
export function scopeCss(css: string, root: string, opts: CssOptions = {}): string {
  const { hoisted, scoped } = partition(splitCss(css, opts), 0);
  const parts = [...hoisted];
  if (scoped.length) parts.push(`@scope (${root}) {\n${scoped.join('\n')}\n}`);
  return parts.join('\n');
}

/** A theme's CSS (contributes.styles) for the window: the same splitting, without a scope. @import and the other dropped at-rules are removed. */
export function cleanCss(css: string, opts: CssOptions = {}): string {
  return splitCss(css, opts)
    .filter((s) => !(s.kind === 'at' && DROPPED_AT_RULES.includes(s.name)))
    .map((s) => s.text)
    .join('\n');
}

/**
 * A url() rewriter for a stylesheet at `file` (a path in the mod, "looks/holo.css") served from `origin`: relative
 * addresses resolve against the stylesheet's folder in the mod; absolute ones (https:, data:, mod:, #fragment) stay.
 */
export function modUrlRewriter(origin: string, file: string): (address: string) => string | null {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const base = `${origin}/${dir.split('/').map(encodeURIComponent).join('/')}`;
  return (address) => {
    const a = address.trim();
    if (!a || a.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(a)) return null;
    try {
      return new URL(a.startsWith('/') ? `${origin}${a}` : a, base).href;
    } catch {
      return null;
    }
  };
}

/** The element a look for `target` is scoped to. */
export const LOOK_ROOTS = { conversation: '#messages', composer: '#chatbar' } as const;

// Which hooks an occurrence fires: the group's matcher (names, a |/, list, or a regular expression) and a
// handler's `if` rule (Claude Code's permission rule syntax: "Bash(git *)", "Edit(*.ts)"). Pure functions.

import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code's matcher rules: "*", "" or none match all; only letters, digits, _, -, spaces, "," and "|" is an
 * exact name or a list of names; anything else is an unanchored JavaScript regular expression. `values` are the names
 * the occurrence goes by (a tool's Claude Code name and this app's name): any of them may match.
 */
export function matcherMatches(matcher: string | undefined | null, values: readonly string[]): boolean {
  if (!matcher || matcher === '*') return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    const names = matcher.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    return values.some((v) => names.includes(v));
  }
  try {
    const re = new RegExp(matcher);
    return values.some((v) => re.test(v));
  } catch {
    return false;
  }
}

/** A glob with * (any run of characters) and ? (one character) matched against the whole string. */
function wildcard(pattern: string, value: string): boolean {
  let re = '';
  for (const c of pattern) re += c === '*' ? '[\\s\\S]*' : c === '?' ? '[\\s\\S]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${re}$`).test(value);
}

/** gitignore-style path glob: ** crosses folders, * and ? stay within one. */
function pathGlob(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        i++;
        re += '(?:[^]*/)?';
      } else re += '[^]*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// ---------- Bash commands ----------

/**
 * Splits a shell command line into the simple commands it runs: at ;, &&, ||, |, & and newlines outside quotes, with
 * the commands inside $( … ) and backticks as commands of their own. Leading VAR=value assignments are dropped.
 * Returns null when the line cannot be read (an unclosed quote or parenthesis): the hook then runs regardless.
 */
export function bashSubcommands(line: string): string[] | null {
  const out: string[] = [];
  const parse = (src: string): boolean => {
    let cur = '';
    let groups = 0;
    let quote: '"' | "'" | null = null;
    const push = () => {
      const t = stripAssignments(cur.trim());
      if (t) out.push(t);
      cur = '';
    };
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quote === "'") {
        cur += c;
        if (c === "'") quote = null;
        continue;
      }
      if (c === '\\') {
        cur += c + (src[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '$' && src[i + 1] === '(') {
        // A command substitution (inside double quotes too): its body is a command line of its own.
        let depth = 1;
        let j = i + 2;
        let q: string | null = null;
        for (; j < src.length && depth > 0; j++) {
          const d = src[j];
          if (q) {
            if (d === q) q = null;
            else if (d === '\\') j++;
            continue;
          }
          if (d === "'" || d === '"') q = d;
          else if (d === '\\') j++;
          else if (d === '(') depth++;
          else if (d === ')') depth--;
        }
        if (depth !== 0) return false;
        if (!parse(src.slice(i + 2, j - 1))) return false;
        cur += src.slice(i, j);
        i = j - 1;
        continue;
      }
      if (c === '`') {
        const end = src.indexOf('`', i + 1);
        if (end < 0) return false;
        if (!parse(src.slice(i + 1, end))) return false;
        cur += src.slice(i, end + 1);
        i = end;
        continue;
      }
      if (quote === '"') {
        cur += c;
        if (c === '"') quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        cur += c;
        continue;
      }
      if (c === ';' || c === '\n' || c === '|' || c === '&') {
        push();
        if ((c === '|' || c === '&') && src[i + 1] === c) i++;
        continue;
      }
      // Subshells and groups at the start of a command: their insides are commands like any other.
      if ((c === '(' || c === '{') && !cur.trim()) {
        groups++;
        cur = '';
        continue;
      }
      if ((c === ')' || c === '}') && groups > 0) {
        groups--;
        push();
        continue;
      }
      cur += c;
    }
    if (quote) return false;
    push();
    return true;
  };
  return parse(line) ? out : null;
}

function stripAssignments(cmd: string): string {
  let rest = cmd;
  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]*)\s+/.exec(rest);
    if (!m) return rest;
    rest = rest.slice(m[0].length);
  }
}

/** Whether one simple command matches a Bash rule pattern ("git *", "npm run test:*", "ls"). */
function bashPatternMatches(pattern: string, cmd: string): boolean {
  const p = pattern.trim();
  if (p.endsWith(':*')) {
    const prefix = p.slice(0, -2);
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }
  // "ls *" also matches a bare "ls" (the space keeps it from matching lsof)
  if (p.endsWith(' *') && cmd === p.slice(0, -2)) return true;
  return wildcard(p, cmd);
}

/** A Bash rule pattern names more than the program: "git push *" does, "rm *" and "rm" do not. */
function namesMoreThanProgram(pattern: string): boolean {
  return !/^\S+( \*|:\*)?$/.test(pattern.trim());
}

/** Whether a Bash command line matches a rule pattern, by the rules of Claude Code's `if` field. */
export function bashRuleMatches(pattern: string, command: string): boolean {
  const p = pattern.trim();
  if (!p || p === '*') return true;
  const subs = bashSubcommands(command);
  if (subs === null) return true; // cannot tell what it runs
  if (namesMoreThanProgram(p) && /\$\(|`|\$[A-Za-z_{]/.test(command)) return true;
  return subs.some((c) => bashPatternMatches(p, c));
}

/**
 * Whether a file path matches a file rule pattern. "//x" is an absolute path, "~/x" is under the home folder, "/x"
 * and "./x" (or any pattern with a "/") are relative to the session's folder, and a pattern without "/" matches the
 * file's name in any folder, as in a .gitignore.
 */
export function pathRuleMatches(pattern: string, file: string, cwd: string): boolean {
  const p = pattern.trim();
  if (!p || p === '*' || p === '**') return true;
  const abs = path.resolve(cwd, file.replace(/^~(?=$|\/)/, os.homedir()));
  let base: string;
  let glob: string;
  if (p.startsWith('//')) {
    base = '/';
    glob = p.slice(2);
  } else if (p.startsWith('~/')) {
    base = os.homedir();
    glob = p.slice(2);
  } else if (p.startsWith('/')) {
    base = cwd;
    glob = p.slice(1);
  } else if (p.startsWith('./')) {
    base = cwd;
    glob = p.slice(2);
  } else if (p.includes('/')) {
    base = cwd;
    glob = p;
  } else {
    return pathGlob(p).test(path.basename(abs));
  }
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // A folder pattern ("src/") or "src/**" covers what is inside
  const g = glob.endsWith('/') ? `${glob}**` : glob;
  return pathGlob(g).test(rel.split(path.sep).join('/'));
}

/** The tools whose rule pattern is a path, by Claude Code name. */
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'LS']);

/**
 * Whether a tool call matches an `if` rule: "Tool" or "Tool(pattern)". `names` are the tool's names (Claude Code's
 * and this app's), `input` is the Claude Code-shaped input. Bash patterns go by subcommand; file tools by path; any
 * other tool's pattern is matched against its first string argument.
 */
export function ifRuleMatches(rule: string, names: readonly string[], input: Record<string, unknown>, cwd: string): boolean {
  const m = /^([A-Za-z0-9_.\-]+)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const [, tool, pattern] = m;
  if (!names.includes(tool)) return false;
  if (pattern === undefined || pattern === '' || pattern === '*') return true;
  if (tool === 'Bash' || tool === 'terminal_run') {
    return typeof input.command === 'string' ? bashRuleMatches(pattern, input.command) : true;
  }
  if (PATH_TOOLS.has(tool) || typeof input.file_path === 'string') {
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '';
    return file ? pathRuleMatches(pattern, file, cwd) : false;
  }
  const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
  return first !== undefined && wildcard(pattern, first);
}

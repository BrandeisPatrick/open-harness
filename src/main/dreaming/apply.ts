// Proposals as files: checking what a dream proposes, applying it, and putting back what applying replaced. The app
// does all of it, never the model. A proposal writes only into the two skill folders, the two mod folders and the
// two instructions files; anything else is refused. Nothing is overwritten silently: a proposal that changes what
// exists must say so, and applying refuses when the target changed since the proposal was made.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryProposal, ModProposal, ProposalScope, SkillProposal } from '../../shared/dreaming';
import { INSTRUCTION_FILES, USER_INSTRUCTION_NAMES, userInstructionsFile } from '../instructions';
import { OLD_PROJECT_DIR_NAME, PROJECT_DIR_NAME, projectConfigDir } from '../paths';
import { isInside, readManifest, MOD_ID_RE } from '../mods/manifest';
import type { Replaced } from './store';

/** A refusal the model (or the window) can act on */
export class DreamError extends Error {}

export interface Roots {
  /** The dream's project folder */
  cwd: string;
  /** ~/.silo-harness (or SILO_HARNESS_CONFIG_DIR) */
  configDir: string;
  /** The app's own folder, with the bundled skills/ and mods/ */
  appRoot: string;
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const MAX_SKILL_BODY = 20_000;
const MAX_LINE = 400;
const MAX_LINES = 12;
const MAX_MOD_FILES = 24;
const MAX_MOD_FILE = 100_000;
const MAX_MOD_FOLDER_FILES = 200;

export function skillsDir(scope: ProposalScope, r: Roots): string {
  return scope === 'project' ? path.join(projectConfigDir(r.cwd), 'skills') : path.join(r.configDir, 'skills');
}

export function modsDir(scope: ProposalScope, r: Roots): string {
  return scope === 'project' ? path.join(projectConfigDir(r.cwd), 'mods') : path.join(r.configDir, 'mods');
}

/** The instructions file a memory proposal writes: the project's first existing one (else SILOHARNESS.md), or the user's. */
export function instructionsFile(scope: ProposalScope, r: Roots): { path: string; label: string } {
  if (scope === 'user') return userInstructionsFile(r.configDir);
  const name = INSTRUCTION_FILES.find((n) => isFile(path.join(r.cwd, n))) ?? INSTRUCTION_FILES[0];
  return { path: path.join(r.cwd, name), label: name };
}

/** Where a path really is once links are followed: its deepest existing ancestor resolved, plus what does not exist yet. */
function realPath(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/**
 * Whether `target` is somewhere a proposal may write: inside a skill or mod folder, or one of the instructions files,
 * and really there. A project can ship `.silo-harness/mods` (or `.open-harness/mods`) or its instructions file as a link to anywhere on the
 * disk; a dream does not write (or delete) through one that leaves the project, or the config folder for the user's.
 */
export function allowedTarget(target: string, r: Roots): boolean {
  const abs = path.resolve(target);
  // The project folder under its new name and its old one (.silo-harness, .open-harness), whichever is in use
  const project = [PROJECT_DIR_NAME, OLD_PROJECT_DIR_NAME].flatMap((n) => ['skills', 'mods'].map((d) => path.join(r.cwd, n, d)));
  const dirs = [...project, skillsDir('user', r), modsDir('user', r)].map((d) => path.resolve(d));
  const files = [...INSTRUCTION_FILES.map((n) => path.join(r.cwd, n)), ...USER_INSTRUCTION_NAMES.map((n) => path.join(r.configDir, n))].map((f) => path.resolve(f));
  if (!dirs.some((d) => abs !== d && isInside(d, abs)) && !files.includes(abs)) return false;
  const config = path.resolve(r.configDir);
  const root = isInside(config, abs) ? config : path.resolve(r.cwd);
  return isInside(realPath(root), realPath(abs));
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

const scopeOf = (v: unknown): ProposalScope => {
  if (v === 'project' || v === 'user') return v;
  throw new DreamError(`scope must be "project" (this project only) or "user" (every project), not ${JSON.stringify(v)}.`);
};

// ---------- Secrets ----------

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/, 'an API key (sk-…)'],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i, 'a key, token or password'],
  [/:\/\/[^/\s:@]+:[^/\s@]+@/, 'a URL with a password in it'],
];

/** What secret a text seems to hold, or null. `known` are values that must never leave the app (configured keys). */
export function secretIn(text: string, known: string[] = []): string | null {
  for (const k of known) if (k && k.length >= 8 && text.includes(k)) return 'a key from your settings';
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return null;
}

function noSecrets(parts: string[], known: string[]): void {
  for (const p of parts) {
    const what = secretIn(p, known);
    if (what) throw new DreamError(`this seems to contain ${what}. Never copy secrets out of the logs into a skill, a mod or memory; leave it out, or describe where the user keeps it.`);
  }
}

// ---------- Skills ----------

export interface SkillInput {
  name: unknown;
  description: unknown;
  body: unknown;
  scope: unknown;
  changes_existing?: unknown;
}

export interface KnownSkill {
  name: string;
  description: string;
  path: string;
  source: 'project' | 'user' | 'bundled';
}

export function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

/** The fields of a skill proposal (validated), or a DreamError. `skills`: the skills the project sees now. */
export function checkSkill(input: SkillInput, r: Roots, skills: KnownSkill[], known: string[]): Pick<SkillProposal, 'name' | 'description' | 'body' | 'content' | 'current' | 'scope' | 'target' | 'changesExisting' | 'title'> {
  const name = String(input.name ?? '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(name)) throw new DreamError(`name "${name}" must be 2 to 48 lower-case letters, digits and -, starting with a letter or digit (it becomes the folder name and /${name || 'name'}).`);
  const description = String(input.description ?? '').replace(/\s+/g, ' ').trim();
  if (!description) throw new DreamError('give the skill a description: one line that says when to use it.');
  if (description.length > 300) throw new DreamError(`the description is ${description.length} characters; keep it under 300.`);
  const body = String(input.body ?? '').trim();
  if (!body) throw new DreamError('the body is empty: write the procedure, step by step.');
  if (body.length > MAX_SKILL_BODY) throw new DreamError(`the body is ${body.length} characters; the limit is ${MAX_SKILL_BODY}.`);
  const scope = scopeOf(input.scope);
  noSecrets([description, body], known);
  const target = path.join(skillsDir(scope, r), name, 'SKILL.md');
  if (!allowedTarget(target, r)) throw new DreamError(`${target} is outside the skill folders.`);
  const change = input.changes_existing === true;
  const same = skills.filter((s) => s.name === name);
  const current = readOrNull(target) ?? undefined;
  if ((same.length || current !== undefined) && !change) {
    const where = same.map((s) => `${s.source} (${s.path})`).join(', ') || target;
    throw new DreamError(`a skill named "${name}" exists already: ${where}. To change it, set changes_existing to true and say in why what changes; otherwise pick another name or propose nothing.`);
  }
  if (scope === 'user' && same.some((s) => s.source === 'project')) throw new DreamError(`this project has a skill named "${name}" of its own, which would hide a user skill of that name; propose it for the project, or pick another name.`);
  const content = skillFile(name, description, body);
  if (current !== undefined && current === content) throw new DreamError(`${target} already says exactly this.`);
  // A skill of that name elsewhere (built in, or the user's) is replaced for this project by the new file
  const changes = current !== undefined || same.length > 0;
  return { name, description, body, content, current, scope, target, changesExisting: changes, title: `${changes ? 'Change' : 'New'} skill “${name}”` };
}

// ---------- Memory ----------

export interface MemoryInput {
  scope: unknown;
  add?: unknown;
  remove?: unknown;
  changes_existing?: unknown;
}

/** A memory line as the file holds it: one bullet. */
export function bullet(line: string): string {
  return `- ${line.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '')}`;
}

const lineKey = (l: string) => l.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '').toLowerCase();

function lines(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  const out = list.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (out.length > MAX_LINES) throw new DreamError(`${what} has ${out.length} lines; at most ${MAX_LINES} in one proposal.`);
  for (const l of out) if (l.length > MAX_LINE) throw new DreamError(`a line in ${what} is ${l.length} characters; keep each under ${MAX_LINE}.`);
  return out;
}

export function checkMemory(input: MemoryInput, r: Roots, known: string[]): Pick<MemoryProposal, 'scope' | 'target' | 'label' | 'add' | 'remove' | 'changesExisting' | 'title'> {
  const scope = scopeOf(input.scope);
  const add = lines(input.add, 'add').map(bullet);
  const remove = lines(input.remove, 'remove');
  if (!add.length && !remove.length) throw new DreamError('give lines to add, lines to remove, or both.');
  noSecrets(add, known);
  const file = instructionsFile(scope, r);
  if (!allowedTarget(file.path, r)) throw new DreamError(`${file.path} is not an instructions file.`);
  const current = readOrNull(file.path) ?? '';
  const have = new Map(current.split('\n').map((l) => [lineKey(l), l]));
  const removing: string[] = [];
  for (const l of remove) {
    const hit = have.get(lineKey(l));
    if (!hit || !lineKey(l)) throw new DreamError(`"${l}" is not a line of ${file.label}; remove lines exactly as the file has them.`);
    removing.push(hit);
  }
  if (removing.length && input.changes_existing !== true) throw new DreamError(`removing lines changes what ${file.label} says: set changes_existing to true and say in why what is wrong with them.`);
  for (const l of add) if (have.has(lineKey(l)) && !removing.some((x) => lineKey(x) === lineKey(l))) throw new DreamError(`${file.label} already has the line "${l}".`);
  const what = add.length && removing.length ? 'Change' : add.length ? 'Add to' : 'Remove from';
  return { scope, target: file.path, label: file.label, add, remove: removing, changesExisting: removing.length > 0, title: `${what} ${scope === 'user' ? 'your memory' : 'project memory'} (${file.label})` };
}

/** The file after a memory proposal: removed lines taken out, added ones appended (a new file gets a heading). */
export function memoryAfter(current: string | null, add: string[], remove: string[]): string {
  let text = current ?? '';
  if (remove.length) {
    const drop = new Set(remove.map(lineKey));
    text = text
      .split('\n')
      .filter((l) => !drop.has(lineKey(l)))
      .join('\n');
  }
  if (!add.length) return text;
  if (current === null) text = '# Project instructions\n\nNotes for the agent working in this project.\n';
  const have = new Set(text.split('\n').map(lineKey));
  const fresh = add.filter((l) => !have.has(lineKey(l)));
  if (!fresh.length) return text;
  const sep = !text || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${fresh.join('\n')}\n`;
}

// ---------- Mods ----------

export interface ModInput {
  id: unknown;
  name: unknown;
  description?: unknown;
  scope: unknown;
  files: unknown;
  changes_existing?: unknown;
}

/** Why a path given for a file of a mod is not acceptable, or null (the rules mod.json paths follow). */
export function modPathProblem(rel: string): string | null {
  if (!rel.trim()) return 'is empty';
  if (rel.includes('\\')) return 'uses "\\"; write paths with "/"';
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || path.isAbsolute(rel)) return 'is an absolute path; give a path inside the mod folder';
  const parts = rel.split('/');
  if (parts.some((p) => p === '..')) return 'leaves the mod folder ("..")';
  if (parts.some((p) => p === '' || p === '.')) return 'has an empty or "." segment';
  if (parts.some((p) => p.startsWith('.'))) return 'names a hidden file (starting with ".")';
  return null;
}

/** Every file of a folder as text, by "/"-separated relative path; null when there is no folder. */
export function readFolder(dir: string): Record<string, string> | null {
  if (!fs.existsSync(dir)) return null;
  const out: Record<string, string> = {};
  let count = 0;
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        if (++count > MAX_MOD_FOLDER_FILES) throw new DreamError(`${dir} has more than ${MAX_MOD_FOLDER_FILES} files; change it by hand.`);
        const buf = fs.readFileSync(p);
        if (buf.subarray(0, 8000).includes(0)) throw new DreamError(`${r} in ${dir} is not a text file; change this mod by hand.`);
        out[r] = buf.toString('utf8');
      }
    }
  };
  walk(dir, '');
  return out;
}

function writeFolder(dir: string, files: Record<string, string>): void {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

const sameFiles = (a: Record<string, string> | null | undefined, b: Record<string, string> | null | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function checkMod(input: ModInput, r: Roots, known: string[]): Pick<ModProposal, 'modId' | 'name' | 'description' | 'files' | 'current' | 'scope' | 'target' | 'changesExisting' | 'title'> {
  const modId = String(input.id ?? '').trim();
  if (!MOD_ID_RE.test(modId)) throw new DreamError(`id "${modId}" must be 2 to 40 lower-case letters, digits and -, starting with a letter.`);
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new DreamError('give the mod a name.');
  const description = String(input.description ?? '').replace(/\s+/g, ' ').trim();
  const scope = scopeOf(input.scope);
  if (!Array.isArray(input.files) || !input.files.length) throw new DreamError('files must be a list of { path, content }, with mod.json among them.');
  if (input.files.length > MAX_MOD_FILES) throw new DreamError(`${input.files.length} files; a proposed mod has at most ${MAX_MOD_FILES}.`);
  const files: { path: string; content: string }[] = [];
  for (const f of input.files as unknown[]) {
    const rel = String((f as { path?: unknown })?.path ?? '').trim();
    const content = String((f as { content?: unknown })?.content ?? '');
    const problem = modPathProblem(rel);
    if (problem) throw new DreamError(`file path "${rel}" ${problem}.`);
    if (files.some((x) => x.path === rel)) throw new DreamError(`${rel} is given twice.`);
    if (content.length > MAX_MOD_FILE) throw new DreamError(`${rel} is ${content.length} characters; at most ${MAX_MOD_FILE} per file.`);
    files.push({ path: rel, content });
  }
  if (!files.some((f) => f.path === 'mod.json')) throw new DreamError('mod.json is missing from files.');
  noSecrets(files.map((f) => f.content), known);
  const target = path.join(modsDir(scope, r), modId);
  if (!allowedTarget(target, r) || files.some((f) => !allowedTarget(path.join(target, ...f.path.split('/')), r))) throw new DreamError(`${target} is outside the mod folders.`);
  // The manifest is checked the way the app checks every mod, in a scratch copy of the folder
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-dream-mod-'));
  try {
    writeFolder(path.join(scratch, modId), Object.fromEntries(files.map((f) => [f.path, f.content])));
    const { manifest, problems } = readManifest(path.join(scratch, modId), modId);
    const bad = problems.filter((p) => !p.warning);
    if (!manifest || bad.length) throw new DreamError(`the mod would not load: ${bad.map((p) => p.message).join('; ')}.`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const current = readFolder(target) ?? undefined;
  const bundled = fs.existsSync(path.join(r.appRoot, 'mods', modId, 'mod.json'));
  if ((current || bundled) && input.changes_existing !== true) {
    throw new DreamError(`a mod with the id "${modId}" exists already${current ? ` (${target})` : ' (a built-in one)'}. To change it, set changes_existing to true and say in why what changes; otherwise pick another id.`);
  }
  if (current && sameFiles(current, Object.fromEntries(files.map((f) => [f.path, f.content])))) throw new DreamError(`${target} already holds exactly these files.`);
  return { modId, name, description, files, current, scope, target, changesExisting: Boolean(current), title: `${current ? 'Change' : 'New'} mod “${name}”` };
}

// ---------- Applying and reverting ----------

type Proposal = SkillProposal | MemoryProposal | ModProposal;

/** Writes what the proposal says and returns what it replaced. Refuses when the target changed since it was proposed. */
export function applyProposal(p: Proposal, r: Roots): Replaced {
  if (!allowedTarget(p.target, r)) throw new DreamError(`${p.target} is not a place a dream may write.`);
  if (p.kind === 'skill') {
    const before = readOrNull(p.target);
    if ((before ?? undefined) !== p.current) throw new DreamError(before === null ? `${p.target} was removed since this was proposed.` : `${p.target} ${p.current === undefined ? 'was created' : 'changed'} since this was proposed; dream again for a fresh proposal.`);
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    fs.writeFileSync(p.target, p.content);
    return { kind: 'file', path: p.target, before, wrote: p.content };
  }
  if (p.kind === 'memory') {
    const before = readOrNull(p.target);
    const lineSet = new Set((before ?? '').split('\n').map(lineKey));
    const gone = p.remove.filter((l) => !lineSet.has(lineKey(l)));
    if (gone.length) throw new DreamError(`${p.label} no longer has the line "${gone[0]}".`);
    const wrote = memoryAfter(before, p.add, p.remove);
    if (wrote === (before ?? '')) throw new DreamError(`${p.label} already says this.`);
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    fs.writeFileSync(p.target, wrote);
    return { kind: 'file', path: p.target, before, wrote };
  }
  const before = readFolder(p.target);
  if (!sameFiles(before, p.current)) throw new DreamError(`${p.target} ${p.current ? 'changed' : 'was created'} since this was proposed; dream again for a fresh proposal.`);
  const wrote = Object.fromEntries(p.files.map((f) => [f.path, f.content]));
  writeFolder(p.target, wrote);
  return { kind: 'folder', path: p.target, before, wrote };
}

/**
 * Puts back what applying replaced. A file or folder still as the app wrote it goes back exactly; memory that was
 * edited since is reverted line by line (the added lines go, the removed ones come back); anything else that changed
 * since is refused rather than overwritten.
 */
export function revertProposal(p: Proposal, rep: Replaced, r: Roots): void {
  if (!allowedTarget(rep.path, r)) throw new DreamError(`${rep.path} is not a place a dream may write.`);
  if (rep.kind === 'folder') {
    const now = readFolder(rep.path);
    if (!sameFiles(now, rep.wrote)) throw new DreamError(`${rep.path} changed since it was applied; revert it by hand.`);
    if (rep.before) writeFolder(rep.path, rep.before);
    else fs.rmSync(rep.path, { recursive: true, force: true });
    return;
  }
  const now = readOrNull(rep.path);
  if (now === rep.wrote) {
    if (rep.before === null) {
      fs.rmSync(rep.path, { force: true });
      // A skill's own folder goes with its file when nothing else is in it
      if (p.kind === 'skill') {
        try {
          fs.rmdirSync(path.dirname(rep.path));
        } catch {
          /* not empty */
        }
      }
    } else fs.writeFileSync(rep.path, rep.before);
    return;
  }
  if (p.kind !== 'memory') throw new DreamError(`${rep.path} changed since it was applied; revert it by hand.`);
  if (now === null) throw new DreamError(`${rep.path} was removed since it was applied.`);
  const added = new Set(p.add.map(lineKey));
  let text = now
    .split('\n')
    .filter((l) => !added.has(lineKey(l)))
    .join('\n');
  const have = new Set(text.split('\n').map(lineKey));
  const back = p.remove.filter((l) => !have.has(lineKey(l)));
  if (back.length) text = `${text}${text.endsWith('\n') || !text ? '' : '\n'}${back.join('\n')}\n`;
  fs.writeFileSync(rep.path, text);
}

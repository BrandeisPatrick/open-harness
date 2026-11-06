// Local images that a Markdown reply points at (![alt](./shot.png)): images.resolve hands the window an
// artifact:// URL for each, artifacts.ts serves it. The URLs live in memory, so they last while the app runs, and
// only name files that were checked to be images; every request checks the file again (it may have changed since).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { servableImage, type ImageKind } from './sniff';

interface Entry {
  /** The file the reply named */
  source: string;
  /** What is served: the file itself, or a copy with the right extension (the scheme's content type follows the name) */
  served: string;
  kind: ImageKind;
}

const byToken = new Map<string, Entry>();
const tokenBySource = new Map<string, string>();
let copyDir: string | null = null;

const EXTS: Record<ImageKind['ext'], string[]> = { png: ['.png'], jpg: ['.jpg', '.jpeg'], webp: ['.webp'], gif: ['.gif'], svg: ['.svg'] };

/** The URL path (after artifact://view/) for an image file that was already checked; the same file gets the same URL. */
export function localImagePath(file: string, kind: ImageKind): string {
  const name = encodeURIComponent(path.basename(file));
  const known = tokenBySource.get(file);
  const entry = known ? byToken.get(known) : undefined;
  if (known && entry && entry.kind.ext === kind.ext) {
    if (entry.served !== entry.source) refreshCopy(entry);
    return `_local/${known}/${name}`;
  }
  const token = known ?? randomBytes(12).toString('hex');
  const next: Entry = { source: file, served: file, kind };
  if (!EXTS[kind.ext].includes(path.extname(file).toLowerCase())) {
    next.served = path.join(dir(), `${token}.${kind.ext}`);
    refreshCopy(next);
  }
  byToken.set(token, next);
  tokenBySource.set(file, token);
  return `_local/${token}/${name}`;
}

/** The file to serve for a token, or null when it is unknown or no longer an image. */
export function localImageFile(token: string): string | null {
  const entry = /^[0-9a-f]{24}$/.test(token) ? byToken.get(token) : undefined;
  if (!entry) return null;
  return servableImage(entry.served) ? entry.served : null;
}

/** At quit: the copies made for misnamed files go (they are in a temp folder of this run). */
export function clearLocalImages(): void {
  byToken.clear();
  tokenBySource.clear();
  if (copyDir) fs.rmSync(copyDir, { recursive: true, force: true });
  copyDir = null;
}

function refreshCopy(entry: Entry): void {
  try {
    fs.copyFileSync(entry.source, entry.served);
  } catch {
    /* served from the last copy, or not at all */
  }
}

function dir(): string {
  if (!copyDir) copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-harness-images-'));
  return copyDir;
}

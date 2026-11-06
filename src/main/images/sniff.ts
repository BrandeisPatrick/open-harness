// What kind of image a file is, decided by its bytes (never its name), and its pixel size read from the header.
// Plain Node: the headless suites need both, and the app uses them where Electron's nativeImage cannot help (SVG,
// WebP and GIF on some systems).

import fs from 'node:fs';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export type ImageKind = { mime: string; ext: 'png' | 'jpg' | 'webp' | 'gif' | 'svg' };

/** How much of a file sniffing needs: SVG may open with an XML prolog, a doctype and comments before its root. */
const HEAD_BYTES = 64 * 1024;

const ascii = (b: Buffer, at: number, len: number): string => b.toString('latin1', at, at + len);

/** PNG, JPEG, WebP, GIF or SVG by content; null for anything else. */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 6 && (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a')) return { mime: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (isSvg(buf)) return { mime: 'image/svg+xml', ext: 'svg' };
  return null;
}

/** The root element is <svg> once the BOM, XML prolog, doctype, comments and processing instructions are skipped. */
function isSvg(buf: Buffer): boolean {
  let s = buf.subarray(0, HEAD_BYTES).toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // A binary file is not markup, whatever it contains further on
  if (s.includes('\u0000')) return false;
  for (let guard = 0; guard < 200; guard++) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('<?')) {
      const end = s.indexOf('?>');
      if (end < 0) return false;
      s = s.slice(end + 2);
    } else if (s.startsWith('<!--')) {
      const end = s.indexOf('-->');
      if (end < 0) return false;
      s = s.slice(end + 3);
    } else if (/^<!DOCTYPE/i.test(s)) {
      // A doctype may carry an internal subset in [...]
      const m = /^<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i.exec(s);
      if (!m) return false;
      s = s.slice(m[0].length);
    } else break;
  }
  return /^<svg[\s>/]/i.test(s) || /^<[\w.-]+:svg[\s>/]/i.test(s);
}

/** Width and height from the header for PNG, JPEG, GIF and WebP; undefined for SVG or a header it cannot read. */
export function imageSize(buf: Buffer, kind: ImageKind): { width: number; height: number } | undefined {
  try {
    const out = readSize(buf, kind.ext);
    return out && out.width > 0 && out.height > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function readSize(b: Buffer, ext: ImageKind['ext']): { width: number; height: number } | undefined {
  switch (ext) {
    case 'png':
      // The first chunk is IHDR: width and height right after its type
      if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return undefined;
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    case 'gif':
      return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : undefined;
    case 'jpg': {
      // Walk the segments to the first start-of-frame marker (C0–CF except DHT C4, JPG C8 and DAC CC)
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        if (marker === 0xd9 || marker === 0xda) return undefined;
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return undefined;
    }
    case 'webp': {
      const chunk = ascii(b, 12, 4);
      if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
        const b1 = b[21], b2 = b[22], b3 = b[23], b4 = b[24];
        return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The first bytes of a file, enough to sniff it (an empty buffer when it cannot be read). */
export function readHead(file: string): Buffer {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** A regular file within the size cap whose content is an image: its kind, or null. Used before serving any file. */
export function servableImage(file: string): ImageKind | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES || st.size === 0) return null;
  } catch {
    return null;
  }
  return sniffImage(readHead(file));
}

// Renderers for transcript items whose role renderer.ts does not know. A feature registers its role here and its
// items render wherever a transcript does (a switch, a reload, a rewind), without an edit to renderTranscript.

/** A transcript item of any role: the built-in ones are in TranscriptItem (src/shared/types.ts). */
export interface ExtraTranscriptItem {
  role: string;
  [key: string]: unknown;
}

/** Returns the element to append (null to skip the item). */
export type TranscriptItemRenderer = (item: ExtraTranscriptItem) => HTMLElement | null;

const renderers = new Map<string, TranscriptItemRenderer>();
let sink: ((el: HTMLElement) => void) | null = null;

/** Renders items of `role`; the built-in roles cannot be replaced. Returns the unregister function. */
export function registerTranscriptItem(role: string, render: TranscriptItemRenderer): () => void {
  if (renderers.has(role)) throw new Error(`Transcript items of role ${role} already have a renderer.`);
  renderers.set(role, render);
  return () => {
    if (renderers.get(role) === render) renderers.delete(role);
  };
}

export function transcriptItemRenderer(role: string): TranscriptItemRenderer | undefined {
  return renderers.get(role);
}

/** Appends a live item of a registered role to the transcript on screen (as the next row). False when nothing was shown. */
export function appendTranscriptItem(item: ExtraTranscriptItem): boolean {
  const render = renderers.get(item?.role);
  if (!render || !sink) return false;
  const el = render(item);
  if (!el) return false;
  sink(el);
  return true;
}

/** renderer.ts: where appended items go (after the streaming reply and thinking block are closed). */
export function setTranscriptSink(fn: (el: HTMLElement) => void): void {
  sink = fn;
}

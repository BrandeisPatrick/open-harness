// Images the assistant shows in its replies (the show_image tool). Types only.

/** An image the model put into the conversation; stored with the session and shown inline in the transcript. */
export interface ImageInfo {
  /** Stable within the session, e.g. "img-3" */
  id: string;
  sessionId: string;
  /** File name shown under the image and used when saving */
  name: string;
  caption?: string;
  /** image/png, image/jpeg, image/webp, image/gif or image/svg+xml */
  mime: string;
  bytes: number;
  /** Pixels, when they could be read */
  width?: number;
  height?: number;
  createdAt: number;
  /** What the window loads: artifact://view/<session>/images/<file> */
  url: string;
  /** The stored copy */
  path: string;
  /** Where it came from: the path the model named */
  source?: string;
}

export interface ImagesRpc {
  /** The images of a session (default: the one on screen), oldest first */
  'images.list': (sessionId?: string) => ImageInfo[];
  /**
   * For Markdown images in a reply: turns a local path (absolute, ~/…, or relative to the session's folder) into a
   * URL the window may load. Remote URLs are refused: the window never loads images from the network.
   */
  'images.resolve': (ref: string, sessionId?: string) => { url: string; name: string } | { error: string };
  'images.reveal': (id: string, sessionId?: string) => void;
  /** Save dialog; the chosen path or null */
  'images.saveAs': (id: string, sessionId?: string) => string | null;
  /** Puts the image itself on the clipboard */
  'images.copy': (id: string, sessionId?: string) => boolean;
}

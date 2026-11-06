// show_image: the model puts an image into its reply (a screenshot it took, a chart it generated, a picture in the
// project). The file is copied into the session's store so the reply keeps showing it after the original changes
// or a temp screenshot is cleaned up. No approval: it only shows a person their own file.

import path from 'node:path';
import type { AgentEvent } from '../../shared/types';
import type { App } from '../app';
import { describeImage, resolveUserPath, SHOWN_PREFIX, storeImage } from '../images/store';
import type { Tool } from './types';

/**
 * Hands an event to the session's agent so it travels like the agent's own (LiveState, app.events, the window).
 * The App has no public emit for a session; the agent's emitter is the runtime's dispatch for that session.
 */
function emitFor(app: App, sessionId: string, ev: AgentEvent): void {
  const agent = app.runtime.agentFor(sessionId) as unknown as { emit?: (ev: AgentEvent) => void };
  if (typeof agent.emit === 'function') agent.emit(ev);
}

export function showImageTool(app: App): Tool {
  const root = path.join(app.userData, 'artifacts');
  return {
    name: 'show_image',
    readOnly: true,
    description:
      'Show the user an image inline in your reply, the way a person attaches a screenshot: a screenshot you took (browser_screenshot gives its path), a chart or diagram you generated, or a picture in the project. PNG, JPEG, WebP, GIF or SVG, up to 15 MB. The image appears in the chat at this point of your answer; write the text around it as usual. Use it when seeing is faster than reading, not for decoration.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "The image file: absolute, ~/…, or relative to the project folder" },
        caption: { type: 'string', description: 'Optional short caption shown under the image' },
      },
      required: ['path'],
    },
    async run(args, ctx) {
      const source = typeof args?.path === 'string' ? args.path : '';
      if (!source.trim()) throw new Error('path is required: the image file to show');
      const session = app.store.get(ctx.sessionId);
      if (!session) throw new Error('this conversation is not stored yet; try again');
      const file = resolveUserPath(source, ctx.cwd);
      const info = storeImage(root, session, { file, source, caption: typeof args?.caption === 'string' ? args.caption : undefined });
      app.store.save(session, false);
      emitFor(app, ctx.sessionId, { type: 'image', image: info });
      return { content: `${SHOWN_PREFIX} ${info.name} (${describeImage(info)}).` };
    },
  };
}

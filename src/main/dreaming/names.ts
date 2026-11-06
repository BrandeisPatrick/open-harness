// The dreaming defaults and the names both sides need (src/shared is types only: both builds compile it). The window
// has its own copy of the tool names and the id pattern in src/renderer/dreaming.ts; test/dreaming.js checks they agree.

import type { DreamingConfig } from '../../shared/dreaming';

export const DEFAULT_DREAMING: DreamingConfig = { daily: false, time: '03:00', mode: 'approve', skills: true, mods: true, memory: true };

/** The tools that make a proposal: their calls are shown as proposal cards instead of tool rows. */
export const PROPOSAL_TOOLS = ['propose_skill', 'propose_memory', 'propose_mod'];

/** A proposal id as the tools' results name it ("… proposal pr_1a2b3c …"). */
export const PROPOSAL_ID_RE = /\bproposal (pr_[0-9a-f]{6,})\b/;

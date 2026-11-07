import type OpenAI from 'openai';
import type { PermissionMode } from '../../shared/types';
import type { Tool } from './types';
import { readFile, writeFile, editFile, listDirectory, glob, grep } from './fs';
import { bash } from './shell';
import { browserTools } from './browser';
import { skillTool } from './skill';
import { submitPlan } from './plan';
import { terminalTools } from './terminal';
import { createArtifact } from './artifact';
import { updateTasks } from './tasks';
import { askUser } from './ask-user';

export type { Tool, ToolContext, ToolResult, ApprovalResult, ApproveOptions } from './types';

/** The tools offered to the model. Plan mode swaps the file-changing tools for submit_plan; ask_user is in every mode. */
export function allTools(mode: PermissionMode = 'ask'): Tool[] {
  if (mode === 'plan') return [readFile, listDirectory, glob, grep, bash, skillTool, ...browserTools, ...terminalTools, createArtifact, updateTasks, askUser, submitPlan];
  return [readFile, writeFile, editFile, listDirectory, glob, grep, bash, skillTool, ...browserTools, ...terminalTools, createArtifact, updateTasks, askUser];
}

export function toSpec(tool: Tool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

// Where the app keeps the files a person edits by hand: settings.json, skills, mods and the user-level instructions.
import os from 'node:os';
import path from 'node:path';

/**
 * The user-level config directory: ~/.openagent, or OPENAGENT_CONFIG_DIR when set (tests point it at a temp
 * folder so they never read or write the real one). Read on every call, so a test can set the variable late.
 */
export function configDir(): string {
  const override = process.env.OPENAGENT_CONFIG_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.openagent');
}

/** The config directory of a project: <project>/.openagent */
export function projectConfigDir(cwd: string): string {
  return path.join(cwd, '.openagent');
}

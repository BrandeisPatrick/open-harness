// Where the app keeps the files a person edits by hand: settings.json, skills, mods and the user-level instructions.
import os from 'node:os';
import path from 'node:path';

/**
 * The user-level config directory: ~/.open-harness, or OPEN_HARNESS_CONFIG_DIR when set (tests point it at a temp
 * folder so they never read or write the real one). Read on every call, so a test can set the variable late.
 */
export function configDir(): string {
  const override = process.env.OPEN_HARNESS_CONFIG_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.open-harness');
}

/** The config directory of a project: <project>/.open-harness */
export function projectConfigDir(cwd: string): string {
  return path.join(cwd, '.open-harness');
}

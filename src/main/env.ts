// `${VAR}` and `${VAR:-default}` in strings from settings files, .mcp.json and provider entries. No dependencies, so
// the command-line tool can load it without the rest of the app.

/** Expands `${VAR}` and `${VAR:-default}` against `env` (unset with no default: empty). */
export function expandEnvRefs(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => env[name] ?? fallback ?? '');
}

/** A valid environment variable name: letters, digits and _, not starting with a digit. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

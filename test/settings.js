// settings.json layering: user vs project precedence, the env block, ${VAR} expansion,
// and that saving never bakes an override back into config.json. Run: node test/settings.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { applySettings, withoutSettings, settingsOwned, settingsProblems } = require(path.join(projectDir, 'dist/main/settings.js'));
const { check, done } = require('./support/check.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oa-settings-'));
const write = (dir, name, obj) => {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

// A config.json-shaped baseline.
const base = () => ({
  provider: 'ollama',
  ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen3:8b', numCtx: 16384, think: 'auto' },
  portkey: { baseURL: 'https://api.portkey.ai/v1', apiKey: '', model: '@openai/gpt-4o-mini', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
  workingDirectory: os.homedir(),
  permissionMode: 'ask',
  autoApprove: false,
  maxTurns: 40,
  sendScreenshotsToModel: false,
  systemPromptExtra: '',
  theme: 'system',
  autoTitles: true,
  mcpServers: {},
  mcpTrusted: {},
  autoCompact: true,
  notifications: true,
  allowRules: {},
  recentDirs: [],
});

// --- no settings files: identity -------------------------------------------
{
  const cwd = tmp();
  const cfg = base();
  cfg.workingDirectory = cwd;
  const out = applySettings(cfg, { userFile: path.join(tmp(), 'absent.json') });
  check('no settings files leaves the config alone', JSON.stringify(out) === JSON.stringify(cfg));
  check('nothing is owned', settingsOwned().length === 0);
  check('withoutSettings is identity', JSON.stringify(withoutSettings(out)) === JSON.stringify(cfg));
}

// --- user scope overrides config.json ---------------------------------------
{
  const cwd = tmp();
  const userFile = write(tmp(), 'settings.json', {
    provider: 'portkey',
    portkey: { baseURL: 'https://gateway.example.com/v1', model: '@vertex/anthropic.claude-opus-5', contextWindow: 200000 },
  });
  const cfg = base();
  cfg.workingDirectory = cwd;
  const out = applySettings(cfg, { userFile });
  check('provider overridden', out.provider === 'portkey', out.provider);
  check('portkey.model overridden', out.portkey.model === '@vertex/anthropic.claude-opus-5', out.portkey.model);
  check('portkey.baseURL overridden', out.portkey.baseURL === 'https://gateway.example.com/v1');
  check('untouched portkey fields keep config.json values', out.portkey.apiKey === '' && out.portkey.virtualKey === '');
  check('unrelated sections untouched', out.ollama.model === 'qwen3:8b' && out.maxTurns === 40);
  check('owned paths reported', settingsOwned().sort().join(',') === 'portkey.baseURL,portkey.contextWindow,portkey.model,provider', settingsOwned());

  // The crucial one: a Settings-panel save must not persist the override.
  const edited = { ...out, maxTurns: 99 };
  const stored = withoutSettings(edited);
  check('save restores provider to config.json value', stored.provider === 'ollama', stored.provider);
  check('save restores portkey.model', stored.portkey.model === '@openai/gpt-4o-mini', stored.portkey.model);
  check('save keeps genuinely edited fields', stored.maxTurns === 99);
}

// --- project scope beats user scope -----------------------------------------
{
  const cwd = tmp();
  write(cwd, path.join('.openagent', 'settings.json'), { portkey: { model: '@vertex/project-model' }, maxTurns: 7 });
  const userFile = write(tmp(), 'settings.json', {
    provider: 'portkey',
    portkey: { model: '@vertex/user-model', contextWindow: 200000 },
  });
  const cfg = base();
  cfg.workingDirectory = cwd;
  const out = applySettings(cfg, { userFile });
  check('project model wins', out.portkey.model === '@vertex/project-model', out.portkey.model);
  check('user-only field survives', out.portkey.contextWindow === 200000);
  check('user provider still applies', out.provider === 'portkey');
  check('project-only field applies', out.maxTurns === 7);
}

// --- env block + ${VAR} expansion -------------------------------------------
{
  delete process.env.OA_TEST_KEY;
  const cwd = tmp();
  const userFile = write(tmp(), 'settings.json', {
    env: { OA_TEST_KEY: 'secret-from-settings' },
    portkey: { apiKey: '${OA_TEST_KEY}', model: '${OA_MISSING:-fallback-model}' },
  });
  const cfg = base();
  cfg.workingDirectory = cwd;
  const out = applySettings(cfg, { userFile });
  check('env block reaches process.env', process.env.OA_TEST_KEY === 'secret-from-settings');
  check('${VAR} expands from the env block', out.portkey.apiKey === 'secret-from-settings', out.portkey.apiKey);
  check('${VAR:-default} falls back', out.portkey.model === 'fallback-model', out.portkey.model);
  check('expanded secret is not written back to config.json', withoutSettings(out).portkey.apiKey === '');
  delete process.env.OA_TEST_KEY;
}

// --- malformed file is reported, not fatal ----------------------------------
{
  const cwd = tmp();
  const userFile = write(tmp(), 'settings.json', '{ this is not json ');
  const cfg = base();
  cfg.workingDirectory = cwd;
  let out;
  let threw = false;
  try {
    out = applySettings(cfg, { userFile });
  } catch {
    threw = true;
  }
  check('malformed settings does not throw', !threw);
  check('config falls back to config.json', out && out.provider === 'ollama');
  check('problem is reported', settingsProblems().length === 1 && settingsProblems()[0].file === userFile, settingsProblems());
}

// --- a JSON array is rejected like malformed input ---------------------------
{
  const cwd = tmp();
  const userFile = write(tmp(), 'settings.json', '[1,2,3]');
  const cfg = base();
  cfg.workingDirectory = cwd;
  const out = applySettings(cfg, { userFile });
  check('array settings rejected', out.provider === 'ollama' && settingsProblems().length === 1);
}

done();

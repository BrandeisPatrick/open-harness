// ask_user, headless: the tool's checks and the text the model reads, then the whole wait through the runtime with
// the mock model (a question card instead of an approval, in every mode; the answer, a skip and a stop each reach
// the model as they should; the live state and the session's status while it waits).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { askUser, parseQuestions, cleanAnswers, answerText, SKIPPED } = require(path.join(projectDir, 'dist/main/tools/ask-user.js'));
const { allTools } = require(path.join(projectDir, 'dist/main/tools/index.js'));
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { startMock, askUserReply } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (err) {
    return String(err.message || err);
  }
};

const LIB = { question: 'Which chart library should the dashboard use?', header: 'Library', options: [{ label: 'Chart.js (Recommended)', description: 'Small, canvas, enough for bars and lines' }, { label: 'D3', description: 'Anything is possible, more code' }], multiSelect: false };
const FEAT = { question: 'Which features should ship first?', header: 'Features', options: [{ label: 'Export', description: 'CSV and PNG' }, { label: 'Filters', description: 'By date and team' }, { label: 'Sharing', description: 'A read-only link' }], multiSelect: true };

(async () => {
  // ---------- The checks ----------
  const ok = parseQuestions({ questions: [LIB, FEAT] });
  check('two good questions pass as they are', ok.length === 2 && ok[0].header === 'Library' && ok[0].options.length === 2 && ok[1].multiSelect === true && ok[0].multiSelect === false, ok);
  check('no questions: refused', /1 to 4 questions/.test(throws(() => parseQuestions({}))) && /1 to 4/.test(throws(() => parseQuestions({ questions: [] }))));
  check('five questions: refused', /at most 4/.test(throws(() => parseQuestions({ questions: [LIB, FEAT, { ...LIB, header: 'A' }, { ...LIB, header: 'B' }, { ...LIB, header: 'C' }] }))));
  check('a header over 12 characters: refused, saying so', /longer than 12/.test(throws(() => parseQuestions({ questions: [{ ...LIB, header: 'Chart library!' }] }))));
  check('a header of exactly 12 characters passes', parseQuestions({ questions: [{ ...LIB, header: 'Chart librar' }] })[0].header === 'Chart librar');
  check('no header: refused', /no header/.test(throws(() => parseQuestions({ questions: [{ ...LIB, header: ' ' }] }))));
  check('no question text: refused', /no question text/.test(throws(() => parseQuestions({ questions: [{ ...LIB, question: '' }] }))));
  check('one option: refused', /2 to 4 options/.test(throws(() => parseQuestions({ questions: [{ ...LIB, options: [LIB.options[0]] }] }))));
  check('five options: refused', /2 to 4 options/.test(throws(() => parseQuestions({ questions: [{ ...FEAT, options: [...FEAT.options, { label: 'D', description: '' }, { label: 'E', description: '' }] }] }))));
  check('the same option twice: refused', /twice/.test(throws(() => parseQuestions({ questions: [{ ...LIB, options: [LIB.options[0], LIB.options[0]] }] }))));
  check('the same header twice: refused', /header "library"/i.test(throws(() => parseQuestions({ questions: [LIB, { ...FEAT, header: 'library' }] }))));
  const other = parseQuestions({ questions: [{ ...FEAT, options: [...FEAT.options, { label: 'Other', description: 'Something else' }] }] });
  check('an "Other" option from the model is left out (the card has its own)', other[0].options.length === 3 && !other[0].options.some((o) => o.label === 'Other'));
  check('"Other" that leaves one option: refused, saying to leave it out', /leave "Other" out/.test(throws(() => parseQuestions({ questions: [{ ...LIB, options: [LIB.options[0], { label: 'other', description: '' }] }] }))));
  check('multiSelect "true" as a string counts, a missing one is false', parseQuestions({ questions: [{ ...FEAT, multiSelect: 'true' }] })[0].multiSelect === true && parseQuestions({ questions: [{ ...FEAT, multiSelect: undefined }] })[0].multiSelect === false);
  check('labels as plain strings are accepted', parseQuestions({ questions: [{ ...LIB, options: ['Chart.js', 'D3'] }] })[0].options[1].label === 'D3');

  // ---------- Answers ----------
  const qs = parseQuestions({ questions: [LIB, FEAT] });
  const a = cleanAnswers(qs, [{ selected: ['D3', 'Chart.js (Recommended)'] }, { selected: ['Export', 'Nope', 'Sharing'], other: '  Dark mode  ' }]);
  check('a single-choice answer keeps one label (the first the question offers)', JSON.stringify(a[0]) === JSON.stringify({ selected: ['Chart.js (Recommended)'] }), a[0]);
  check('a multi-choice answer keeps the offered labels in order and the typed text, trimmed', JSON.stringify(a[1]) === JSON.stringify({ selected: ['Export', 'Sharing'], other: 'Dark mode' }), a[1]);
  const typed = cleanAnswers(qs, [{ selected: ['D3'], other: 'Recharts' }, {}]);
  check('single choice: typed text replaces a picked option', JSON.stringify(typed[0]) === JSON.stringify({ selected: [], other: 'Recharts' }) && JSON.stringify(typed[1]) === JSON.stringify({ selected: [] }), typed);
  check('junk in: one empty answer per question', JSON.stringify(cleanAnswers(qs, 'nope')) === JSON.stringify([{ selected: [] }, { selected: [] }]));
  const text = answerText(qs, a);
  check('the model reads each header with the answer', text === 'The user answered your questions:\n- Library: Chart.js (Recommended)\n- Features: Export, Sharing, and in their own words: "Dark mode"', text);
  check('one question: "your question"; typed text alone', answerText([qs[0]], [{ selected: [], other: 'Recharts' }]) === 'The user answered your question:\n- Library: in their own words: "Recharts"');
  check('nothing picked reads as no answer', /- Features: \(no answer\)/.test(answerText(qs, [{ selected: ['D3'] }, { selected: [] }])));
  check('skipped: "The user skipped the question."', answerText(qs, null) === 'The user skipped the question.' && SKIPPED === 'The user skipped the question.');

  // ---------- The spec ----------
  for (const mode of ['ask', 'acceptEdits', 'auto', 'plan', 'bypass']) check(`offered in ${mode} mode`, allTools(mode).some((t) => t.name === 'ask_user'));
  check('the spec says when to use it, and that Other is always there', /genuinely the user's/.test(askUser.description) && /Other/.test(askUser.description) && /12 characters/.test(askUser.description));
  const item = askUser.parameters.properties.questions.items;
  check('the schema: 1–4 questions, 2–4 options, every field required', askUser.parameters.properties.questions.maxItems === 4 && item.properties.options.minItems === 2 && item.properties.options.maxItems === 4 && item.required.join() === 'question,header,options,multiSelect');
  check('no context to ask in: the tool says so', /cannot be asked/.test(await askUser.run({ questions: [LIB] }, {}).catch((e) => e.message)));

  // ---------- The wait, through the runtime ----------
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-askuser-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: tmp, permissionMode: 'ask', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const app = createApp({
    userData: tmp,
    appRoot: projectDir,
    loadConfig: () => config,
    saveConfig: (c) => (config = c),
    browser: () => ({ navigate: async () => '' }),
    artifacts: new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
  });
  const rt = app.runtime;
  let events = [];
  app.events.on((sid, ev) => events.push({ sid, ev }));
  const of = (type) => events.filter((e) => e.ev.type === type).map((e) => e.ev);
  const A = rt.foregroundId();
  const idle = () => waitFor(() => !rt.isRunning(A), 15000, 'the run to end');
  /** The content of the tool message the model got back for the ask_user call */
  const toolResult = () => {
    const last = state.requests[state.requests.length - 1].payload.messages;
    return last.filter((m) => m.role === 'tool').pop()?.content;
  };

  // 1. Ask mode: a question card, no approval card; the answer reaches the model
  state.replies.push(askUserReply([LIB, FEAT], { id: 'q1' }));
  state.replies.push({ content: 'Going with that.' });
  rt.send(A, 'Build the dashboard.');
  const req = await waitFor(() => of('question_request')[0], 5000, 'the question card');
  check('1: the run asks with a question card, not an approval card', req.questions.length === 2 && req.questions[1].header === 'Features' && !of('approval_request').length, req);
  check('1: while it waits: running, the session needs the user ("question"), the live state has the card', rt.isRunning(A) && rt.status(A).attention === 'question' && rt.live(A).questions.length === 1 && rt.live(A).questions[0].id === req.id, rt.status(A));
  check('1: an unknown card is not answered', rt.respondQuestion('nope', null) === false);
  check('1: the answer is taken', rt.respondQuestion(req.id, [{ selected: ['D3'] }, { selected: ['Filters'], other: 'A dark theme' }]) === true);
  await idle();
  check('1: the model read the answers', toolResult() === 'The user answered your questions:\n- Library: D3\n- Features: Filters, and in their own words: "A dark theme"', toolResult());
  const resolved = of('question_resolved')[0];
  check('1: question_resolved carries the cleaned answers', resolved && resolved.id === req.id && resolved.answers[0].selected[0] === 'D3' && !resolved.skipped, resolved);
  check('1: the card is gone from the live state and the status', !rt.status(A).attention && !rt.respondQuestion(req.id, null));
  const row = of('tool_end').find((e) => e.name === 'ask_user');
  check('1: the call ends ok with the same text', row && row.ok && /- Library: D3/.test(row.result), row);

  // 2. Skipped (Skip / Esc)
  events = [];
  state.requests.length = 0;
  state.replies.push(askUserReply([LIB]));
  state.replies.push({ content: 'I will pick Chart.js then.' });
  rt.send(A, 'Again.');
  const r2 = await waitFor(() => of('question_request')[0], 5000, 'the second card');
  rt.respondQuestion(r2.id, null);
  await idle();
  check('2: skipping tells the model "The user skipped the question."', toolResult() === 'The user skipped the question.', toolResult());
  check('2: question_resolved says skipped', of('question_resolved')[0]?.skipped === true);

  // 3. Plan mode and bypass: still asked (no approval needed, never refused)
  for (const mode of ['plan', 'bypass']) {
    config = { ...config, permissionMode: mode };
    events = [];
    state.replies.push(askUserReply([LIB]));
    state.replies.push({ content: 'ok' });
    rt.send(A, `In ${mode}.`);
    const r3 = await waitFor(() => of('question_request')[0], 5000, `the card in ${mode} mode`);
    rt.respondQuestion(r3.id, [{ selected: ['Chart.js (Recommended)'] }]);
    await idle();
    check(`3: ${mode} mode asks too, and the answer arrives`, /- Library: Chart\.js \(Recommended\)/.test(toolResult()), toolResult());
  }
  config = { ...config, permissionMode: 'ask' };

  // 4. A stop while it waits: the card ends, the call is interrupted
  events = [];
  state.replies.push(askUserReply([LIB]));
  rt.send(A, 'Ask and wait.');
  await waitFor(() => of('question_request')[0], 5000, 'the card to stop');
  rt.stop(A);
  await idle();
  const end = of('tool_end').find((e) => e.name === 'ask_user');
  check('4: a stop ends the card and interrupts the call', of('question_resolved')[0]?.skipped === true && end && /interrupted/.test(end.result) && !end.ok, end);
  check('4: nothing waits any more', !rt.status(A).attention && !(rt.live(A).questions || []).length);

  // 5. A bad call: the model reads why, no card
  events = [];
  state.replies.push({ content: '', toolCalls: [{ id: 'bad', name: 'ask_user', args: { questions: [{ ...LIB, header: 'A very long header' }] } }] });
  state.replies.push({ content: 'ok' });
  rt.send(A, 'Ask badly.');
  await idle();
  check('5: a header that is too long comes back as an error, with no card', /^Error: .*longer than 12/.test(toolResult()) && !of('question_request').length, toolResult());

  mock.close();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});

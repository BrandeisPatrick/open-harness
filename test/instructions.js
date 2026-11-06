// Project instructions: loading order, truncation and the "#" shortcut's append. Run: node test/instructions.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { loadInstructions, instructionsPrompt, appendInstruction } = require(path.join(projectDir, 'dist/main/instructions.js'));
const { check, done } = require('./support/check.js');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr-'));
const read = (name) => fs.readFileSync(path.join(cwd, name), 'utf8');

let r = appendInstruction(cwd, '  always run   npm test  ');
check('append creates OPENHARNESS.md with a header and the bullet', r.label === 'OPENHARNESS.md' && read('OPENHARNESS.md') === '# Project instructions\n\nNotes for the agent working in this project.\n- always run npm test\n', read('OPENHARNESS.md'));
r = appendInstruction(cwd, 'prefer small commits');
check('append adds to the existing file', read('OPENHARNESS.md').endsWith('- always run npm test\n- prefer small commits\n') && r.path === path.join(cwd, 'OPENHARNESS.md'));
let threw = false;
try { appendInstruction(cwd, '   '); } catch (e) { threw = /Nothing to add/.test(e.message); }
check('empty text rejected', threw);

const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr2-'));
fs.writeFileSync(path.join(cwd2, 'AGENTS.md'), '# Rules\nBe brief');
r = appendInstruction(cwd2, 'use tabs');
check('append goes to the existing project file and adds the missing newline', r.label === 'AGENTS.md' && fs.readFileSync(path.join(cwd2, 'AGENTS.md'), 'utf8') === '# Rules\nBe brief\n- use tabs\n');
const files = loadInstructions(cwd2);
check('loader picks AGENTS.md and the prompt names it', files.some((f) => f.label === 'AGENTS.md' && /use tabs/.test(f.text)) && /Instructions from AGENTS\.md/.test(instructionsPrompt(files)));
fs.writeFileSync(path.join(cwd2, 'OPENHARNESS.md'), 'x'.repeat(30000));
const big = loadInstructions(cwd2).find((f) => f.label === 'OPENHARNESS.md');
check('OPENHARNESS.md wins and long files are truncated', big && big.truncated && big.text.length < 24100 && !loadInstructions(cwd2).some((f) => f.label === 'AGENTS.md'));

// Names from before the renames are still read: the app was OpenAgent, and OpenCoder before that.
const { loadSkills } = require(path.join(projectDir, 'dist/main/skills.js'));
const cwd3 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr3-'));
fs.writeFileSync(path.join(cwd3, 'OPENAGENT.md'), 'Old name, still mine');
check('a project OPENAGENT.md is still read', loadInstructions(cwd3).some((f) => f.label === 'OPENAGENT.md' && /still mine/.test(f.text)));
r = appendInstruction(cwd3, 'keep going');
check('…and "#" appends to it instead of starting a new file', r.label === 'OPENAGENT.md' && !fs.existsSync(path.join(cwd3, 'OPENHARNESS.md')));
fs.writeFileSync(path.join(cwd3, 'OPENHARNESS.md'), 'New name wins');
check('the new name wins when both exist', loadInstructions(cwd3).some((f) => f.label === 'OPENHARNESS.md') && !loadInstructions(cwd3).some((f) => f.label === 'OPENAGENT.md'));
const skillFile = (dir, name) => {
  fs.mkdirSync(path.join(cwd3, dir, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(cwd3, dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: from ${dir}\n---\nDo it.`);
};
skillFile('.openagent', 'old-skill');
skillFile('.open-harness', 'new-skill');
skillFile('.openagent', 'both');
skillFile('.open-harness', 'both');
const skills = loadSkills(cwd3, path.join(cwd3, 'no-app-root'));
const by = (n) => skills.find((k) => k.name === n);
check('skills in .openagent/skills are still found', by('old-skill') && by('old-skill').source === 'project' && by('new-skill'));
check('…and .open-harness/skills wins a name clash', by('both') && by('both').description === 'from .open-harness', by('both'));
done();

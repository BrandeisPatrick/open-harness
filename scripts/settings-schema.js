// Writes docs/settings.schema.json from the app's own validation code (settingsSchema() in src/main/settings.ts), so
// the schema an editor checks settings.json against is the one the app applies. test/providers.js fails when the
// file is out of date. Run after a build: node scripts/settings-schema.js
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { settingsSchema } = require(path.join(root, 'dist', 'main', 'settings.js'));
const file = path.join(root, 'docs', 'settings.schema.json');
fs.writeFileSync(file, JSON.stringify(settingsSchema(), null, 2) + '\n');
console.log(`wrote ${path.relative(root, file)}`);

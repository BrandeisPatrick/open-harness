// Runs first, when index.ts loads, before any other module can read the config folder or the data folder: carries
// over the folders an older copy of the app left under its old names (see migrate.ts).
import { app } from 'electron';
import os from 'node:os';
import { configDirOverride } from './paths';
import { carryOverOlderDataFolder, moveConfigDir, moveDataFolder } from './migrate';

const log = (line: string): void => console.log(line);

if (!configDirOverride()) moveConfigDir(os.homedir(), log);

// app.getPath('userData') is named after productName (Silo Harness) unless --user-data-dir says otherwise.
const userData = app.getPath('userData');
if (moveDataFolder(userData, log) === 'failed') log(`[migrate] starting with a new, empty data folder at ${userData}`);
carryOverOlderDataFolder(userData, log);

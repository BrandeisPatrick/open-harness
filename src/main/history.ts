import type { App } from './app';
import { createHistory } from './history/service';

// Feature: History. Called once from index.ts after the core is up, before anything runs: it recovers sessions
// a crash cut short, then logs every session's history, keeps deleted sessions in the trash, and serves search
// and export (see history/service.ts).
export function setupHistory(app: App): void {
  createHistory(app);
}

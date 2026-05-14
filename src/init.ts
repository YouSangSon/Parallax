import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeRepoRoot } from './security.js';
import { databasePath, ensureImpactDir, ensureRepo, openDatabase } from './store.js';
import type { InitOptions, InitResult } from './types.js';

export async function initProject(options: InitOptions): Promise<InitResult> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const dir = ensureImpactDir(repoRoot);
  const configPath = path.join(dir, 'config.json');
  const created = !existsSync(configPath);
  if (created) {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: 3,
          project: 'impact-trace',
          mcp: { readOnly: true },
          redaction: { enabled: true }
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  }
  const db = openDatabase(repoRoot);
  try {
    ensureRepo(db, repoRoot);
  } finally {
    db.close();
  }
  return { created, configPath, databasePath: databasePath(repoRoot) };
}

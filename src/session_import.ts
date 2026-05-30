import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RememberValue } from './agent_memory.js';
import { DATA_DIR, PACKAGE_NAME } from './branding.js';
import { normalizeRepoRoot, redactSecrets, resolveInsideRoot, toRelativePath } from './security.js';
import { contentHash, databasePath, getRepoId, openDatabase } from './store.js';
import type { Db } from './store.js';

export type SessionImportFormat = 'codex' | 'claude';

export type SessionImportOptions = {
  repoRoot: string;
  file: string;
  format: SessionImportFormat;
  branch?: string;
  agent?: string;
};

export type SessionImportSource = {
  kind: 'repo' | 'external-explicit';
  path: string;
  bytes: number;
  sha256: string;
};

export type SessionImportResult = {
  sessionId: string;
  sessionEntityId: string;
  format: SessionImportFormat;
  source: SessionImportSource;
  messageCount: number;
  toolUseCount: number;
  referencedFiles: string[];
  summaryFactId: string;
  referenceFactIds: string[];
  factsWritten: number;
  warnings: string[];
};

type ResolvedSessionFile = {
  absolutePath: string;
  source: Omit<SessionImportSource, 'sha256'>;
};

type ParsedSession = {
  messageCount: number;
  toolUseCount: number;
  textForExtraction: string;
};

const MAX_SESSION_BYTES = 1_000_000;
const MAX_EXTRACT_TEXT_CHARS = 200_000;
const MAX_REFERENCED_FILES = 100;

export async function importSession(options: SessionImportOptions): Promise<SessionImportResult> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  validateFormat(options.format);
  if (!existsSync(databasePath(repoRoot))) {
    throw new Error(`parallax database not found; run ${PACKAGE_NAME} init first`);
  }

  const resolved = resolveSessionFile(repoRoot, options.file);
  const raw = await readFile(resolved.absolutePath, 'utf8');
  const source: SessionImportSource = {
    ...resolved.source,
    sha256: sha256(raw)
  };
  const redacted = redactSecrets(raw, MAX_EXTRACT_TEXT_CHARS);
  const parsed = parseSessionText(redacted, options.format);
  const referencedFiles = extractReferencedRepoFiles(repoRoot, parsed.textForExtraction);
  const sessionId = contentHash(options.format, source.sha256, referencedFiles.join('\n'));
  const sessionEntityId = `session:${options.format}:${sessionId.slice(0, 16)}`;
  const agent = options.agent ?? 'cli:import-session';
  const warnings: string[] = [];
  if (referencedFiles.length >= MAX_REFERENCED_FILES) {
    warnings.push(`referenced files capped at ${MAX_REFERENCED_FILES}`);
  }

  const summaryValue: RememberValue = {
    format: options.format,
    sourceKind: source.kind,
    source,
    messageCount: parsed.messageCount,
    toolUseCount: parsed.toolUseCount,
    referencedFiles,
    rawContentStored: false,
    summary: sessionSummary(options.format, parsed, referencedFiles)
  };
  const persisted = persistSessionFacts(repoRoot, {
    sessionId,
    sessionEntityId,
    summaryValue,
    referencedFiles,
    agent,
    ...(options.branch !== undefined ? { branch: options.branch } : {})
  });

  return {
    sessionId,
    sessionEntityId,
    format: options.format,
    source,
    messageCount: parsed.messageCount,
    toolUseCount: parsed.toolUseCount,
    referencedFiles,
    summaryFactId: persisted.summaryFactId,
    referenceFactIds: persisted.referenceFactIds,
    factsWritten: persisted.factsWritten,
    warnings
  };
}

function validateFormat(format: SessionImportFormat): void {
  if (format !== 'codex' && format !== 'claude') {
    throw new Error('import-session --format must be codex or claude');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveSessionFile(repoRoot: string, inputFile: string): ResolvedSessionFile {
  if (!inputFile || inputFile.includes('\0')) {
    throw new Error('invalid session file path');
  }
  if (/[*?[\]{}]/.test(inputFile)) {
    throw new Error('session file path must name one file; glob patterns are not supported');
  }

  let absolutePath: string;
  let sourceKind: SessionImportSource['kind'];
  if (path.isAbsolute(inputFile)) {
    absolutePath = realpathSync(inputFile);
    sourceKind = pathInside(repoRoot, absolutePath) ? 'repo' : 'external-explicit';
  } else {
    absolutePath = resolveInsideRoot(repoRoot, inputFile);
    sourceKind = 'repo';
  }

  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error('session file must be a regular file');
  }
  if (stat.size > MAX_SESSION_BYTES) {
    throw new Error(`session file exceeds ${MAX_SESSION_BYTES} bytes`);
  }

  const sourcePath = sourceKind === 'repo' ? toRelativePath(repoRoot, absolutePath) : '[external-session-log]';
  return {
    absolutePath,
    source: {
      kind: sourceKind,
      path: sourcePath,
      bytes: stat.size
    }
  };
}

function pathInside(repoRoot: string, absolutePath: string): boolean {
  const relative = path.relative(repoRoot, absolutePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseSessionText(redacted: string, format: SessionImportFormat): ParsedSession {
  const lines = redacted.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const extracted: string[] = [];
  let parsedObjects = 0;
  let toolUseCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      parsedObjects++;
      collectStrings(parsed, extracted);
      if (looksLikeToolUse(parsed)) toolUseCount++;
    } catch {
      extracted.push(line);
      if (/tool[_-]?use|tool_call|function_call|apply_patch|exec_command|bash/i.test(line)) {
        toolUseCount++;
      }
    }
  }

  const joined = extracted.join('\n').slice(0, MAX_EXTRACT_TEXT_CHARS);
  return {
    messageCount: parsedObjects > 0 ? parsedObjects : lines.length,
    toolUseCount,
    textForExtraction: joined || `${format} session`
  };
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, output);
    }
  }
}

function looksLikeToolUse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const serialized = JSON.stringify(value).toLowerCase();
  return /tool[_-]?use|tool_call|function_call|apply_patch|exec_command|bash/.test(serialized);
}

function extractReferencedRepoFiles(repoRoot: string, text: string): string[] {
  const candidates = new Set<string>();
  const pattern =
    /(?:^|[\s"'`([{])((?:\.?[A-Za-z0-9_@+.-]+\/)*\.?[A-Za-z0-9_@+.-]+\.[A-Za-z0-9_@+.-]+)(?=$|[\s"'`)\]},:;])/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1]?.replace(/[.,;:]+$/, '');
    if (!candidate || candidate.includes('\0')) continue;
    if (candidate.startsWith('../') || candidate.startsWith('/') || candidate.includes('://')) continue;
    if (
      candidate.startsWith(`${DATA_DIR}/`) ||
      candidate.includes(`/${DATA_DIR}/`)
    ) continue;
    if (candidate.startsWith('node_modules/') || candidate.includes('/node_modules/')) continue;
    try {
      const absolute = resolveInsideRoot(repoRoot, candidate);
      if (!statSync(absolute).isFile()) continue;
      candidates.add(toRelativePath(repoRoot, absolute));
    } catch {
      // Ignore non-repo paths and path-looking strings that do not exist.
    }
    if (candidates.size >= MAX_REFERENCED_FILES) break;
  }
  return [...candidates].sort();
}

function sessionSummary(format: SessionImportFormat, parsed: ParsedSession, referencedFiles: string[]): string {
  const filePart =
    referencedFiles.length === 0
      ? 'no referenced repo files'
      : `${referencedFiles.length} referenced repo file(s): ${referencedFiles.slice(0, 5).join(', ')}`;
  return `Imported ${format} session with ${parsed.messageCount} event(s), ${parsed.toolUseCount} tool marker(s), ${filePart}.`;
}

type PersistSessionInput = {
  sessionId: string;
  sessionEntityId: string;
  summaryValue: RememberValue;
  referencedFiles: string[];
  branch?: string;
  agent: string;
};

type PersistSessionResult = {
  summaryFactId: string;
  referenceFactIds: string[];
  factsWritten: number;
};

function persistSessionFacts(repoRoot: string, input: PersistSessionInput): PersistSessionResult {
  const summaryBlob = JSON.stringify(input.summaryValue);
  const referenceValues = input.referencedFiles.map((file) => `file:${file}`);

  const db = openDatabase(repoRoot);
  try {
    getRepoId(db, repoRoot);
    const branch = loadBranch(db, input.branch ?? 'main');
    const summaryFactId = factId(input.sessionEntityId, 'session_summary', summaryBlob, branch.id);
    const referenceFactIds = referenceValues.map((value) =>
      factId(input.sessionEntityId, 'references_file', JSON.stringify(value), branch.id)
    );
    const allFactsExist =
      factExists(db, summaryFactId) &&
      referenceFactIds.every((referenceFactId) =>
        factExists(db, referenceFactId) && provenanceExists(db, referenceFactId, summaryFactId)
      );
    if (allFactsExist) {
      return { summaryFactId, referenceFactIds, factsWritten: 0 };
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      ensureAttributeDef(db, 'session_summary', 'Imported coding agent session crystal summary');
      ensureAttributeDef(db, 'references_file', 'Repo-relative file referenced by an imported coding agent session');

      const ts = new Date().toISOString();
      const txId = contentHash(branch.head_tx_id ?? '', branch.id, ts, input.agent, input.sessionId);
      db.prepare(
        'INSERT OR IGNORE INTO transactions (id, parent_tx_id, branch_id, ts, agent, index_run_id) VALUES (?, ?, ?, ?, ?, NULL)'
      ).run(txId, branch.head_tx_id, branch.id, ts, input.agent);
      if (branch.head_tx_id) {
        db.prepare('INSERT OR IGNORE INTO transaction_parents (tx_id, parent_tx_id) VALUES (?, ?)').run(
          txId,
          branch.head_tx_id
        );
      }

      let factsWritten = insertFact(db, {
        id: summaryFactId,
        entity: input.sessionEntityId,
        attribute: 'session_summary',
        valueBlob: summaryBlob,
        txId
      });
      for (let index = 0; index < referenceValues.length; index++) {
        const referenceFactId = referenceFactIds[index]!;
        factsWritten += insertFact(db, {
          id: referenceFactId,
          entity: input.sessionEntityId,
          attribute: 'references_file',
          valueBlob: JSON.stringify(referenceValues[index]!),
          txId
        });
        db.prepare(
          'INSERT OR IGNORE INTO fact_provenance (id, fact_id, source_fact_id, kind, tx_id) VALUES (?, ?, ?, ?, ?)'
        ).run(contentHash(referenceFactId, summaryFactId, 'session_import'), referenceFactId, summaryFactId, 'evidence', txId);
      }

      db.prepare('UPDATE branches SET head_tx_id = ? WHERE id = ?').run(txId, branch.id);
      db.exec('COMMIT');
      return { summaryFactId, referenceFactIds, factsWritten };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function factId(entity: string, attribute: string, valueBlob: string, branchId: string): string {
  return contentHash(entity, attribute, valueBlob, 'assert', branchId);
}

function factExists(db: Db, id: string): boolean {
  const row = db.prepare('SELECT 1 AS one FROM facts WHERE id = ?').get(id) as { one: number } | undefined;
  return row !== undefined;
}

function provenanceExists(db: Db, factIdValue: string, sourceFactId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS one FROM fact_provenance WHERE fact_id = ? AND source_fact_id = ?')
    .get(factIdValue, sourceFactId) as { one: number } | undefined;
  return row !== undefined;
}

function loadBranch(db: Db, name: string): { id: string; head_tx_id: string | null } {
  const row = db
    .prepare('SELECT id, head_tx_id FROM branches WHERE name = ?')
    .get(name) as { id: string; head_tx_id: string | null } | undefined;
  if (!row) throw new Error(`branch not found: ${name}`);
  return row;
}

function ensureAttributeDef(db: Db, name: string, description: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO attribute_defs (name, value_type, is_code_relation, description) VALUES (?, 'json', 0, ?)"
  ).run(name, description);
}

function insertFact(
  db: Db,
  input: { id: string; entity: string; attribute: string; valueBlob: string; txId: string }
): number {
  const result = db
    .prepare('INSERT OR IGNORE INTO facts (id, entity_id, attribute, value_blob, op, tx_id, redacted) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(input.id, input.entity, input.attribute, input.valueBlob, 'assert', input.txId, 0) as { changes?: number };
  return result.changes ?? 0;
}

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ensureRepo, openDatabase } from './store.js';
import { normalizeRepoRoot, redactSecrets, toRelativePath } from './security.js';
import type { IndexOptions, IndexResult } from './types.js';

const ignoredDirs = new Set(['.git', '.impact-trace', 'node_modules', 'dist', 'coverage']);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md']);

type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  content: string;
  hash: string;
  language: string;
};

export async function indexProject(options: IndexOptions): Promise<IndexResult> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const db = openDatabase(repoRoot);
  const repoId = ensureRepo(db, repoRoot);
  const run = db
    .prepare('INSERT INTO index_runs (repo_id, status, started_at, extractor_version) VALUES (?, ?, datetime(\'now\'), ?)')
    .run(repoId, 'running', 'mvp-ts-js-1');
  const indexRunId = Number(run.lastInsertRowid);

  try {
    const files = scanFiles(repoRoot);
    const fileIdByPath = new Map<string, number>();
    const upsertFile = db.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, index_run_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        index_run_id = excluded.index_run_id
    `);
    const selectFile = db.prepare('SELECT id FROM files WHERE repo_id = ? AND path = ?');

    for (const file of files) {
      upsertFile.run(repoId, file.relativePath, file.language, file.hash, indexRunId);
      const row = selectFile.get(repoId, file.relativePath) as { id: number };
      fileIdByPath.set(file.relativePath, row.id);
    }

    let symbolsIndexed = 0;
    let edgesIndexed = 0;
    const insertSymbol = db.prepare(`
      INSERT OR REPLACE INTO symbols (file_id, name, kind, exported, semantic_id, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = db.prepare(`
      INSERT OR REPLACE INTO edges (repo_id, source_file_id, target_file_id, kind, target_path, confidence, provenance, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEvidence = db.prepare(`
      INSERT OR REPLACE INTO evidence (id, repo_id, file_path, kind, snippet, confidence, index_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      const fileId = fileIdByPath.get(file.relativePath);
      if (!fileId) continue;

      for (const symbol of extractSymbols(file)) {
        insertSymbol.run(
          fileId,
          symbol.name,
          symbol.kind,
          symbol.exported ? 1 : 0,
          `${file.relativePath}#${symbol.kind}:${symbol.name}`,
          indexRunId
        );
        symbolsIndexed++;
      }

      for (const imported of extractImports(file)) {
        const target = resolveImportPath(file.relativePath, imported, fileIdByPath);
        insertEdge.run(
          repoId,
          fileId,
          target ? fileIdByPath.get(target)! : null,
          'IMPORTS',
          target ?? imported,
          target ? 'proven' : 'heuristic',
          imported,
          indexRunId
        );
        edgesIndexed++;
      }

      if (isTestFile(file.relativePath)) {
        for (const sourcePath of inferTestTargets(file.relativePath, file.content, fileIdByPath)) {
          insertEdge.run(repoId, fileId, fileIdByPath.get(sourcePath)!, 'TESTS', sourcePath, 'inferred', 'test import/name', indexRunId);
          edgesIndexed++;
        }
      }

      if (file.relativePath.toLowerCase().endsWith('.md')) {
        for (const sourcePath of inferDocTargets(file.content, fileIdByPath)) {
          insertEdge.run(repoId, fileId, fileIdByPath.get(sourcePath)!, 'DOCUMENTS', sourcePath, 'heuristic', 'doc mention', indexRunId);
          edgesIndexed++;
        }
      }

      insertEvidence.run(
        evidenceId(file.relativePath, 'scan'),
        repoId,
        file.relativePath,
        'scan',
        redactSecrets(file.content.slice(0, 500)),
        'proven',
        indexRunId
      );
    }

    db.prepare('UPDATE index_runs SET status = ?, finished_at = datetime(\'now\') WHERE id = ?').run('completed', indexRunId);
    db.close();
    return { indexRunId, filesIndexed: files.length, symbolsIndexed, edgesIndexed };
  } catch (error) {
    db.prepare('UPDATE index_runs SET status = ?, finished_at = datetime(\'now\') WHERE id = ?').run('failed', indexRunId);
    db.close();
    throw error;
  }
}

function scanFiles(repoRoot: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(dir, entry.name);
      const ext = path.extname(entry.name);
      if (!sourceExtensions.has(ext)) continue;
      const content = readFileSync(absolutePath, 'utf8');
      const relativePath = toRelativePath(repoRoot, absolutePath);
      out.push({
        absolutePath,
        relativePath,
        content,
        hash: createHash('sha256').update(content).digest('hex'),
        language: ext.slice(1) || 'text'
      });
    }
  };
  walk(repoRoot);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function extractSymbols(file: ScannedFile): Array<{ name: string; kind: string; exported: boolean }> {
  if (file.relativePath.endsWith('.md')) return [];
  const symbols: Array<{ name: string; kind: string; exported: boolean }> = [];
  const pattern = /(export\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(file.content))) {
    symbols.push({ name: match[3]!, kind: match[2]!, exported: Boolean(match[1]) });
  }
  return symbols;
}

function extractImports(file: ScannedFile): string[] {
  if (file.relativePath.endsWith('.md')) return [];
  const imports = new Set<string>();
  const patterns = [
    /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content))) {
      imports.add(match[1]!);
    }
  }
  return [...imports].sort();
}

function resolveImportPath(sourcePath: string, specifier: string, fileIdByPath: Map<string, number>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.posix.join(base, 'index.ts'),
    path.posix.join(base, 'index.tsx'),
    path.posix.join(base, 'index.js')
  ];
  return candidates.find((candidate) => fileIdByPath.has(candidate));
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(relativePath);
}

function inferTestTargets(relativePath: string, content: string, fileIdByPath: Map<string, number>): string[] {
  const imported = extractImports({ absolutePath: '', relativePath, content, hash: '', language: 'ts' }).flatMap((specifier) => {
    const resolved = resolveImportPath(relativePath, specifier, fileIdByPath);
    return resolved ? [resolved] : [];
  });
  return [...new Set(imported)].sort();
}

function inferDocTargets(content: string, fileIdByPath: Map<string, number>): string[] {
  const targets: string[] = [];
  const normalizedContent = content.toLowerCase();
  for (const file of fileIdByPath.keys()) {
    const stem = path.posix.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    if (stem && normalizedContent.includes(stem)) {
      targets.push(file);
    }
  }
  return targets.sort();
}

function evidenceId(filePath: string, kind: string): string {
  return createHash('sha1').update(`${kind}:${filePath}`).digest('hex').slice(0, 16);
}

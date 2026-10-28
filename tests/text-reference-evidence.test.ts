import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigInfraSemanticAdapter } from '../src/adapters/config-infra.js';
import { MultiLanguageRegexAdapter, TypeScriptJavaScriptSemanticAdapter } from '../src/adapters/multi-language-regex.js';
import type { PendingRelation, SemanticAdapter } from '../src/adapters/types.js';
import type { ScannedFile } from '../src/types.js';

function file(relativePath: string, language: string, content = ''): ScannedFile {
  return { relativePath, language, content, hash: 'fixture', absolutePath: `/synthetic/${relativePath}` };
}

async function relations(adapter: SemanticAdapter, input: ScannedFile, targets = [file('src/a.ts', 'typescript')]) {
  const files = [input, ...targets];
  const run = await adapter.start({ repoRoot: `/source-offset/${input.relativePath}`, indexRunId: 1,
    adapterRunId: 1, indexedFiles: files }, files);
  const result: PendingRelation[] = [];
  try {
    for await (const event of run.process(input)) if (event.kind === 'relation') result.push(event.relation);
    return result;
  } finally { await run.dispose?.(); }
}

test('parser import and call positions preserve UTF-16 columns across empty CRLF lines', async () => {
  const statement = 'import { go } from "./a";';
  for (const prefix of ['', '/*😀*/ ']) {
    const input = file('src/use.ts', 'typescript',
      `${prefix}${statement}\r\n\r\nexport function run() {\r\n  return go();\r\n}`);
    const actual = await relations(new TypeScriptJavaScriptSemanticAdapter(), input);
    const imported = actual.find(row => row.kind === 'DEPENDS_ON')?.evidence?.[0];
    assert.deepEqual(imported && [imported.snippet, imported.startLine, imported.endLine, imported.startCol, imported.endCol],
      [statement, 1, 1, prefix.length + 1, prefix.length + statement.length + 1]);
    const called = actual.find(row => row.kind === 'CALLS' && row.evidence?.[0]?.snippet === 'go()')?.evidence?.[0];
    assert.deepEqual(called && [called.startLine, called.endLine, called.startCol, called.endCol], [4, 4, 10, 14]);
  }
});

test('parser positions remain LF-based for bare CR and Unicode separators', async () => {
  const statement = 'import { go } from "./a";';
  for (const separator of ['\r', '\u2028', '\u2029']) {
    const prefix = `/*😀*/${separator}`;
    const beforeCall = `${prefix}${statement}${separator}export function run() { return `;
    const actual = await relations(new TypeScriptJavaScriptSemanticAdapter(),
      file('src/use.ts', 'typescript', `${beforeCall}go(); }`));
    const imported = actual.find(row => row.kind === 'DEPENDS_ON')?.evidence?.[0];
    assert.deepEqual(imported && [imported.startLine, imported.endLine, imported.startCol, imported.endCol],
      [1, 1, prefix.length + 1, prefix.length + statement.length + 1]);
    const called = actual.find(row => row.kind === 'CALLS' && row.evidence?.[0]?.snippet === 'go()')?.evidence?.[0];
    assert.deepEqual(called && [called.startLine, called.endLine, called.startCol, called.endCol],
      [1, 1, beforeCall.length + 1, beforeCall.length + 5]);
  }
});

test('fallback positions preserve the CR immediately before a line feed', async () => {
  const line = '  path: src/a.ts';
  const actual = await relations(new MultiLanguageRegexAdapter(),
    file('config.yml', 'yaml', `#😀\r\n\r\n${line}\r\n`));
  assert.equal(actual.length, 1);
  const evidence = actual[0]!.evidence?.[0];
  assert.deepEqual(evidence && [evidence.snippet, evidence.startLine, evidence.endLine, evidence.startCol, evidence.endCol],
    [line.trim(), 3, 3, 3, line.length + 2]);
});

test('config evidence uses the original line after Unicode lowercase expansion', async () => {
  const line = '  run: node src/a.ts';
  const input = file('.github/workflows/offset.yml', 'yaml', `${'İ'.repeat(12)}\n${line}\nsentinel\n`);
  const actual = await relations(new ConfigInfraSemanticAdapter(), input);
  assert.equal(actual.length, 1);
  assert.deepEqual(actual[0]!.evidence, [{ file: input.relativePath, snippet: line.slice(2),
    startLine: 2, endLine: 2, startCol: 3, endCol: line.length + 1, confidence: 'heuristic' }]);
});

test('config search retains whole-string final sigma casing and original evidence', async () => {
  const input = file('.github/workflows/sigma.yml', 'yaml', `${'İ'.repeat(20)}\nrun: cat src/ΟΣ/a.ts\nsentinel\n`);
  const actual = await relations(new ConfigInfraSemanticAdapter(), input,
    [file('src/ος/a.ts', 'typescript'), file('src/οσ/a.ts', 'typescript')]);
  assert.deepEqual(actual.map((relation) => relation.target.path), ['src/ος/a.ts']);
  assert.equal(actual[0]!.evidence?.[0]?.snippet, 'run: cat src/ΟΣ/a.ts');
  assert.equal(actual[0]!.evidence?.[0]?.startLine, 2);
});

for (const [name, adapter, inputPath] of [
  ['config', new ConfigInfraSemanticAdapter(), '.github/workflows/newline.yml'],
  ['fallback', new MultiLanguageRegexAdapter(), 'config.yml']
] as const) {
  test(`${name} LF-leading paths preserve original empty and nonempty evidence lines`, async () => {
    for (const [path, content, snippet] of [
      ['\na.ts', 'header!\na.ts\n', 'a.ts'],
      ['\n\na.ts', `${'İ'.repeat(12)}!\n\na.ts\n`, '']
    ] as const) {
      const input = file(inputPath, 'yaml', content);
      const actual = await relations(adapter, input, [file(path, 'typescript')]);
      assert.equal(actual.length, 1);
      assert.deepEqual(actual[0]!.evidence, [{ file: input.relativePath, snippet,
        startLine: 2, endLine: 2, startCol: 1, endCol: snippet.length + 1, confidence: 'heuristic' }]);
    }
  });
}

test('Docker COPY evidence retains physical CRLF widths and original columns', async () => {
  const line = '  COPY src/a.ts /app/a.ts';
  const input = file('Dockerfile', 'dockerfile', `${'# head\r\n'.repeat(10)}${line}\r\n`);
  const actual = await relations(new ConfigInfraSemanticAdapter(), input);
  assert.deepEqual(actual.map((relation) => relation.kind), ['DEPENDS_ON', 'CONFIGURES']);
  for (const relation of actual) {
    assert.deepEqual(relation.evidence, [{ file: input.relativePath, snippet: `${line.slice(2)}\r`,
      startLine: 11, endLine: 11, startCol: 3, endCol: line.length + 2,
      confidence: relation.kind === 'DEPENDS_ON' ? 'proven' : 'heuristic' }]);
  }
});

test('CRLF cannot expose a deferred Docker stage source as a local relation', async () => {
  const input = file('Dockerfile', 'dockerfile', `${'# head\r\n'.repeat(10)}COPY --from=builder src/a.ts /app/a.ts\r\n`);
  assert.deepEqual(await relations(new ConfigInfraSemanticAdapter(), input), []);
});

test('Docker line iteration preserves EOF and embedded-CR parsing limits', async () => {
  for (const [content, kinds] of [
    ['COPY src/a.ts /app/a.ts', ['DEPENDS_ON', 'CONFIGURES']],
    ['COPY src/a.ts /app/a.ts\r', ['CONFIGURES']],
    ['COPY src/a.ts\r /app/a.ts\n', ['CONFIGURES']]
  ] as const) {
    const actual = await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', content));
    assert.deepEqual(actual.map((relation) => relation.kind), kinds, JSON.stringify(content));
    assert.ok(actual.every((relation) => relation.evidence?.[0]?.snippet === content.replace(/\n$/, '')));
  }
});

test('Docker ignored ranges project Unicode prefix and source expansion before a valid later reference', async () => {
  const source = file('src/İ.ts', 'typescript');
  const prefix = `${'# İİİ\r\n'.repeat(10)}COPY --from=builder src/İ.ts /ignored\r\n`;
  const deferred = file('Dockerfile', 'dockerfile', prefix);
  assert.deepEqual(await relations(new ConfigInfraSemanticAdapter(), deferred, [source]), []);
  const line = '  COPY src/İ.ts /app/a.ts # 😀';
  const input = { ...deferred, content: `${prefix}${line}\r\n` };
  const actual = await relations(new ConfigInfraSemanticAdapter(), input, [source]);
  assert.deepEqual(actual.map((relation) => relation.kind), ['DEPENDS_ON', 'CONFIGURES']);
  for (const relation of actual) {
    assert.deepEqual(relation.evidence, [{ file: input.relativePath, snippet: `${line.slice(2)}\r`,
      startLine: 12, endLine: 12, startCol: 3, endCol: line.length + 2,
      confidence: relation.kind === 'DEPENDS_ON' ? 'proven' : 'heuristic' }]);
  }
});

for (const fixture of [
  { name: 'explicit contract path', path: 'openapi.json', language: 'json',
    body: `{\n  "description": "${'İ'.repeat(40)}",\n  "x-ref": "src/a.ts",\n  "sentinel": "other"\n}\n`,
    snippet: '"x-ref": "src/a.ts",', line: 3, startCol: 3, target: 'src/a.ts' },
  { name: 'general full path', path: 'config.yml', language: 'yaml',
    body: `# ${'İ'.repeat(20)}\npath: src/a.ts\nsentinel: other\n`,
    snippet: 'path: src/a.ts', line: 2, startCol: 1, target: 'src/a.ts' },
  { name: 'general stem', path: 'config.yml', language: 'yaml',
    body: `# ${'İ'.repeat(20)}\npath: target\nsentinel: other\n`,
    snippet: 'path: target', line: 2, startCol: 1, target: 'src/target.ts' }
]) {
  test(`fallback ${fixture.name} evidence maps to the original line`, async () => {
    const input = file(fixture.path, fixture.language, fixture.body);
    const actual = (await relations(new MultiLanguageRegexAdapter(), input,
      [file(fixture.target, 'typescript')])).filter((relation) => relation.target.path === fixture.target);
    assert.equal(actual.length, 1);
    assert.deepEqual(actual[0]!.evidence, [{ file: input.relativePath, snippet: fixture.snippet,
      startLine: fixture.line, endLine: fixture.line, startCol: fixture.startCol,
      endCol: fixture.snippet.length + fixture.startCol, confidence: 'heuristic' }]);
  });
}


test('Docker stage sources use distinct raw token spans while destination references survive', async () => {
  for (const content of [
    'COPY --from=builder src/a.ts src/a.ts /out/\n',
    'COPY --from=src/a.ts src/a.ts /out/\n',
    'COPY --from=builder ["src/a.ts","src/a.ts","/out/"]\n'
  ]) {
    assert.deepEqual(await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', content)), [], content);
  }
  for (const content of [
    'COPY --from=builder src/a.ts src/a.ts\n',
    'COPY --from=builder ["src/a.ts","src/a.ts"]\n'
  ]) {
    const actual = await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', content));
    assert.deepEqual(actual.map((relation) => relation.kind), ['CONFIGURES'], content);
    assert.equal(actual[0]!.evidence?.[0]?.snippet, content.trimEnd());
  }
});

test('Docker stage spans exclude raw glob and URL operands without hiding a later local copy', async () => {
  const prefix = '# İİİ\r\nCOPY --from builder *src/a.ts https://host/src/a.ts /out/\r\n';
  assert.deepEqual(await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', prefix)), []);
  const actual = await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', `${prefix}COPY src/a.ts /app/a.ts\r\n`));
  assert.deepEqual(actual.map((relation) => relation.kind), ['DEPENDS_ON', 'CONFIGURES']);
  assert.ok(actual.every((relation) => relation.evidence?.[0]?.startLine === 3));
});

test('Docker JSON paths retain significant whitespace and flag-like operands stay operands', async () => {
  const target = file('src/has  space.ts', 'typescript');
  const content = 'COPY ["src/has  space.ts", "/out/file.ts"]\n';
  const actual = await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', content), [target]);
  assert.deepEqual(actual.map((relation) => relation.kind), ['DEPENDS_ON', 'CONFIGURES']);
  const flagPath = file('--from', 'typescript');
  const flags = await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', 'COPY a.ts --from /out/\n'), [file('a.ts', 'typescript'), flagPath]);
  assert.ok(flags.some((relation) => relation.kind === 'DEPENDS_ON' && relation.target.path === '--from'));
});

test('Docker JSON source spans use decoded values with raw coordinates and validate the complete array', async () => {
  const content = '# header\r\nCOPY ["src\\/a.ts", "/out/a.ts"]\r\n';
  const actual = await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', content));
  assert.deepEqual(actual.map((relation) => relation.kind), ['DEPENDS_ON']);
  assert.equal(actual[0]!.evidence?.[0]?.startLine, 2);
  assert.equal(actual[0]!.evidence?.[0]?.snippet, content.split('\n')[1]);
  const quotedPath = '"a.ts"';
  const quoted = await relations(new ConfigInfraSemanticAdapter(),
    file('Dockerfile', 'dockerfile', `COPY ${JSON.stringify([quotedPath, '/out/'])}\n`),
    [file(quotedPath, 'typescript'), file('a.ts', 'typescript')]);
  assert.deepEqual(quoted.filter((relation) => relation.kind === 'DEPENDS_ON').map((relation) => relation.target.path), [quotedPath]);
  for (const payload of ['["src/a.ts", 0, "/out/"]', '["src/a.ts", "/out/"']) {
    const events = await relations(new ConfigInfraSemanticAdapter(), file('Dockerfile', 'dockerfile', `COPY ${payload}\n`));
    assert.ok(events.every((relation) => relation.kind !== 'DEPENDS_ON'), payload);
  }
});

test('rejected Docker JSON never enters the secondary string lexer', async (t) => {
  const payload = '["src/a.ts","' + String.raw`\"`.repeat(64);
  const matchAll = String.prototype.matchAll;
  t.mock.method(String.prototype, 'matchAll', function (this: string, pattern: RegExp) {
    if (String(this) === payload && pattern.source !== '\\S+') {
      throw new Error('rejected JSON reached the string lexer');
    }
    return matchAll.call(this, pattern);
  });
  const actual = await relations(new ConfigInfraSemanticAdapter(),
    file('Dockerfile', 'dockerfile', `COPY ${payload}\n`));
  assert.ok(actual.every((relation) => relation.kind !== 'DEPENDS_ON'));
});

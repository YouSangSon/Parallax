import { createHash } from 'node:crypto';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import type { AdapterRun, SemanticAdapter } from '../src/adapters/types.js';
import type { IndexScanReads } from '../src/types.js';
import { editSyntheticChangedFile, generateSyntheticRepo } from './synthetic-repo.js';

export type ExtractionSample = {
  phase: 'start' | 'process' | 'dispose';
  path?: string;
  elapsedMs: number;
  events: number;
};

export function profileAdapter(adapter: SemanticAdapter, samples: ExtractionSample[]): SemanticAdapter {
  const { id, version, capabilities, confidence, knownGaps, selectionMode, fileContentScope, outputOwnership } = adapter;
  return {
    id, version, capabilities,
    ...(confidence === undefined ? {} : { confidence }),
    ...(knownGaps === undefined ? {} : { knownGaps }),
    ...(selectionMode === undefined ? {} : { selectionMode }),
    ...(fileContentScope === undefined ? {} : { fileContentScope }),
    ...(outputOwnership === undefined ? {} : { outputOwnership }),
    supports: adapter.supports.bind(adapter),
    async start(ctx, files) {
      const started = performance.now();
      let run: AdapterRun;
      try {
        run = await adapter.start(ctx, files);
      } finally {
        samples.push({ phase: 'start', elapsedMs: performance.now() - started, events: 0 });
      }
      return {
        async *process(file) {
          const started = performance.now();
          let events = 0;
          try {
            for await (const event of run.process(file)) {
              events += 1;
              yield event;
            }
          } finally {
            // Includes the consumer's event collection between yields, not just adapter CPU.
            samples.push({ phase: 'process', path: file.relativePath, elapsedMs: performance.now() - started, events });
          }
        },
        ...(run.dispose ? { async dispose() {
          const started = performance.now();
          try {
            await run.dispose?.();
          } finally {
            samples.push({ phase: 'dispose', elapsedMs: performance.now() - started, events: 0 });
          }
        } } : {})
      };
    }
  };
}

export async function profileConfigExtraction(packageRoot: string) {
  const root = path.resolve(packageRoot);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (pkg.name !== 'parallax') throw new Error('expected a built Parallax package root');
  const runtimeFiles = ['init', 'indexer', 'store', 'adapters/registry', 'adapters/config-infra'];
  const runtimeSha256: Record<string, string> = {};
  for (const file of runtimeFiles) {
    runtimeSha256[`dist/src/${file}.js`] = createHash('sha256')
      .update(await readFile(path.join(root, 'dist/src', `${file}.js`))).digest('hex');
  }
  const load = (file: string) => import(pathToFileURL(path.join(root, 'dist/src', `${file}.js`)).href);
  const { initProject } = await load('init') as typeof import('../src/init.js');
  const { createDefaultRegistry, indexProjectWithRegistryForTest } = await load('indexer') as typeof import('../src/indexer.js');
  const { AdapterRegistry } = await load('adapters/registry') as typeof import('../src/adapters/registry.js');
  const { CONFIG_INFRA_SEMANTIC_ADAPTER_ID } = await load('adapters/config-infra') as typeof import('../src/adapters/config-infra.js');
  const fixture = await mkdtemp(path.join(tmpdir(), 'parallax-config-profile-'));
  try {
    const info = await generateSyntheticRepo(fixture, { files: 20 });
    await mkdir(path.join(fixture, '.github/workflows'), { recursive: true });
    await mkdir(path.join(fixture, 'infra'), { recursive: true });
    await writeFile(path.join(fixture, '.github/workflows/ci.yml'), 'steps:\n  - run: node src/mod0.ts\n');
    await writeFile(path.join(fixture, 'Dockerfile'), 'COPY src/mod0.ts /app/leaf.ts\nCOPY src/mod1.ts /app/use.ts\n');
    await writeFile(path.join(fixture, 'infra/main.tf'), 'source = "src/mod1.ts"\n');
    await initProject({ repoRoot: fixture });

    const observe = async (phase: string, changedPath?: string) => {
      const samples: ExtractionSample[] = [];
      const registry = new AdapterRegistry();
      for (const adapter of createDefaultRegistry().list()) {
        registry.register(adapter.id === CONFIG_INFRA_SEMANTIC_ADAPTER_ID ? profileAdapter(adapter, samples) : adapter);
      }
      const scanReads: IndexScanReads = { bodyReads: 0, bodyBytes: 0, sampleReads: 0, sampleBytes: 0 };
      let scanCalls = 0;
      let scanMs = 0;
      const started = performance.now();
      const result = await indexProjectWithRegistryForTest({ repoRoot: fixture, perfObserver: (name, ms, reads) => {
        if (name !== 'scan') return;
        scanCalls += 1;
        scanMs += ms;
        if (reads) {
          scanReads.bodyReads += reads.bodyReads;
          scanReads.bodyBytes += reads.bodyBytes;
          scanReads.sampleReads += reads.sampleReads;
          scanReads.sampleBytes += reads.sampleBytes;
        }
      } }, registry);
      const indexCallElapsedMs = performance.now() - started;
      if (result.mode !== 'full') throw new Error(`${phase}: expected conservative full extraction`);
      return { phase, changedPath: changedPath ?? null, indexCallElapsedMs, scanCalls, scanMs, scanReads, result, samples,
        unchangedConfigWindowMs: samples.filter((sample) => sample.phase === 'process' && sample.path !== changedPath)
          .reduce((sum, sample) => sum + sample.elapsedMs, 0) };
    };
    const baseline = await observe('baseline');
    await editSyntheticChangedFile(fixture, info);
    const sourceEdit = await observe('source-edit', info.changedFile);
    await writeFile(path.join(fixture, 'Dockerfile'), 'COPY src/mod2.ts /app/edited.ts\n');
    const configEdit = await observe('config-edit', 'Dockerfile');
    return { packageVersion: pkg.version, runtimeSha256, node: process.version, execArgv: process.execArgv,
      platform: `${process.platform}/${process.arch}`, host: { release: release(), logicalCpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? 'unknown', totalMemoryBytes: totalmem() },
      fixture: { sourceFiles: 20, configFiles: 3, gitHistory: false },
      boundary: 'Advisory wall time including collection, waits and instrumentation; not adapter CPU, a speedup, or a read reduction. This fixture requests no models/network/services.',
      observations: [baseline, sourceEdit, configEdit] };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node config-extraction-profile.js <built-parallax-package-root>');
    process.exitCode = 2;
  } else {
    profileConfigExtraction(process.argv[2]!).then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
}

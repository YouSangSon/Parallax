import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

type PackageJson = {
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
};

type GitHubActionsWorkflow = {
  jobs?: Record<
    string,
    {
      steps?: Array<{
        name?: string;
        run?: string;
        if?: string;
      }>;
    }
  >;
};

type CompositeAction = {
  runs?: {
    steps?: Array<{
      run?: string;
      env?: Record<string, string>;
    }>;
  };
};

type SarifModule = {
  impactReportToSarif(report: {
    id: string;
    indexRunId: number;
    changedFiles: string[];
    affectedFiles: [];
    changed: [];
    affected: [];
    actions: [];
    testCommands: [];
    evidence: [];
  }): {
    version: string;
    runs: Array<{ tool: { driver: { version?: string } } }>;
  };
};

test('package exports only the public module entrypoint and metadata', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as PackageJson;

  assert.deepEqual(packageJson.exports, {
    '.': './dist/src/index.js',
    './package.json': './package.json'
  });
  assert.equal(packageJson.bin?.['parallax'], './dist/src/cli.js');
  assert.equal(packageJson.scripts?.prepack, 'npm run build');
  assert.equal(
    packageJson.scripts?.verify,
    'npm run lint && npm run test:install-smoke && npm test && npm run test:dogfood && npm run bench && npm audit --audit-level=high'
  );
  assert.equal(packageJson.scripts?.['bench:report'], 'tsx bench/impact-bench-report.ts');
  assert.equal(
    packageJson.scripts?.['test:install-smoke'],
    'npm run build && node dist/src/cli.js --help'
  );
  assert.deepEqual(packageJson.files, ['dist/src', 'README.md', 'docs', '!docs/superpowers/plans', 'schemas']);
  assert.equal(packageJson.files?.includes('dist'), false);
  assert.equal(packageJson.files?.includes('schemas'), true);
});

test('CI verify job delegates to the canonical release gate', async () => {
  const workflow = parseYaml(
    await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  ) as GitHubActionsWorkflow;

  assert.equal(
    workflow.jobs?.verify?.steps?.some((step) => step.run === 'npm run verify') ?? false,
    true
  );
  assert.equal(
    workflow.jobs?.verify?.steps?.some(
      (step) => step.name === 'Report bench summary'
        && step.if === 'always()'
        && step.run === 'npm run bench:report -- --github-step-summary --allow-missing --baseline .parallax/bench/impact-bench-baseline.json'
    ) ?? false,
    true
  );
  assert.equal(
    workflow.jobs?.verify?.steps?.some(
      (step) => step.name === 'Prepare PR bench baseline'
        && step.if === "github.event_name == 'pull_request'"
    ) ?? false,
    true
  );
});

test('SARIF composite action passes inputs through shell environment variables', async () => {
  const action = parseYaml(
    await readFile(new URL('../action.yml', import.meta.url), 'utf8')
  ) as CompositeAction;
  const step = action.runs?.steps?.[0];

  assert.ok(step?.run);
  assert.equal(step.run.includes('${{'), false);
  assert.match(step.run, /--changed "\$PARALLAX_CHANGED"/);
  assert.match(step.run, /--sarif-output "\$PARALLAX_SARIF_OUTPUT"/);
  assert.match(step.run, /--sarif-category "\$PARALLAX_SARIF_CATEGORY"/);
  assert.match(step.run, /--fail-on "\$PARALLAX_FAIL_ON"/);
  assert.deepEqual(step.env, {
    PARALLAX_CHANGED: '${{ inputs.changed }}',
    PARALLAX_SARIF_OUTPUT: '${{ inputs.sarif-output }}',
    PARALLAX_SARIF_CATEGORY: '${{ inputs.sarif-category }}',
    PARALLAX_FAIL_ON: '${{ inputs.fail-on }}'
  });
});

test('built SARIF module imports and uses root package metadata', async () => {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
  assert.equal(build.status, 0, build.stderr);

  const { impactReportToSarif } = await import(new URL('../dist/src/sarif.js', import.meta.url).href) as SarifModule;
  const sarif = impactReportToSarif({
    id: 'r',
    indexRunId: 1,
    changedFiles: [],
    affectedFiles: [],
    changed: [],
    affected: [],
    actions: [],
    testCommands: [],
    evidence: []
  });

  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0]?.tool.driver.version, '0.1.0');
});

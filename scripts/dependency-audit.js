import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const EXPIRES_AT = new Date('2026-10-01T00:00:00.000Z');
const AUDIT_SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const KNOWN_VULNERABILITIES = {
  '@huggingface/transformers': {
    name: '@huggingface/transformers', severity: 'high', isDirect: true,
    via: ['onnxruntime-node', 'sharp'], effects: [], range: '*',
    nodes: ['node_modules/@huggingface/transformers'], fixAvailable: false
  },
  'adm-zip': {
    name: 'adm-zip', severity: 'high', isDirect: false,
    via: [{
      source: 1123686, name: 'adm-zip', dependency: 'adm-zip',
      title: 'adm-zip: Crafted ZIP file triggers 4GB memory allocation',
      url: 'https://github.com/advisories/GHSA-xcpc-8h2w-3j85', severity: 'high',
      cwe: ['CWE-400', 'CWE-789'],
      cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
      range: '<0.6.0'
    }],
    effects: ['onnxruntime-node'], range: '<0.6.0', nodes: ['node_modules/adm-zip'], fixAvailable: false
  },
  'onnxruntime-node': {
    name: 'onnxruntime-node', severity: 'high', isDirect: false,
    via: ['adm-zip'], effects: ['@huggingface/transformers'],
    range: '1.22.0-dev.20250415-c18e06d5e3 - 1.29.0-dev.20260811-e415ef9afd',
    nodes: ['node_modules/onnxruntime-node'], fixAvailable: false
  },
  sharp: {
    name: 'sharp', severity: 'high', isDirect: false,
    via: [{
      source: 1124066, name: 'sharp', dependency: 'sharp',
      title: 'sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591',
      url: 'https://github.com/advisories/GHSA-f88m-g3jw-g9cj', severity: 'high',
      cwe: ['CWE-1395'], cvss: { score: 0, vectorString: null }, range: '<0.35.0'
    }],
    effects: ['@huggingface/transformers'], range: '<0.35.0', nodes: ['node_modules/sharp'], fixAvailable: false
  }
};
const KNOWN_THRESHOLD_COUNTS = { high: 4, critical: 0 };
const LOCK_EXPECTATIONS = [
  ['packages..dependencies.@huggingface/transformers', '^4.2.0'],
  ['packages.node_modules/@huggingface/transformers.version', '4.2.0'],
  ['packages.node_modules/@huggingface/transformers.dependencies.onnxruntime-node', '1.24.3'],
  ['packages.node_modules/@huggingface/transformers.dependencies.sharp', '^0.34.5'],
  ['packages.node_modules/onnxruntime-node.version', '1.24.3'],
  ['packages.node_modules/onnxruntime-node.dependencies.adm-zip', '^0.5.16'],
  ['packages.node_modules/adm-zip.version', '0.5.18'],
  ['packages.node_modules/sharp.version', '0.34.5']
];

function lockValue(lockfile, key) {
  const [, packagePath, ...fields] = key.split('.');
  let value = lockfile?.packages?.[packagePath];
  for (const field of fields) value = value?.[field];
  return value;
}

function auditErrorCode(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'UNKNOWN';
}

export function gateDependencyAudit({ auditResult, lockfileText, now = new Date() }) {
  if (auditResult.error) throw new Error('npm audit could not start');
  if (auditResult.status !== 0 && auditResult.status !== 1) {
    const signal = typeof auditResult.signal === 'string' && /^SIG[A-Z0-9]+$/.test(auditResult.signal)
      ? auditResult.signal
      : 'unknown';
    throw new Error(`npm audit failed with ${auditResult.status === null ? `signal ${signal}` : `exit status ${auditResult.status}`}`);
  }
  if (typeof auditResult.stdout !== 'string' || auditResult.stdout.trim() === '') {
    throw new Error('npm audit returned no JSON');
  }

  let report;
  try {
    report = JSON.parse(auditResult.stdout);
  } catch {
    throw new Error('npm audit did not return valid JSON');
  }
  if (report?.error) throw new Error(`npm audit returned audit error code ${auditErrorCode(report.error)}`);
  if (report?.auditReportVersion !== 2
      || typeof report?.vulnerabilities !== 'object'
      || report.vulnerabilities === null
      || Array.isArray(report.vulnerabilities)) {
    throw new Error('npm audit returned an unsupported or malformed report');
  }

  const counts = report.metadata?.vulnerabilities;
  const vulnerabilityEntries = Object.values(report.vulnerabilities);
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)
      || AUDIT_SEVERITIES.some((severity) => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0)
      || !Number.isSafeInteger(counts.total)
      || counts.total !== AUDIT_SEVERITIES.reduce((total, severity) => total + counts[severity], 0)
      || vulnerabilityEntries.some((vulnerability) =>
        typeof vulnerability !== 'object'
        || vulnerability === null
        || Array.isArray(vulnerability)
        || !AUDIT_SEVERITIES.includes(vulnerability.severity))) {
    throw new Error('npm audit returned an unsupported or malformed report');
  }
  for (const severity of AUDIT_SEVERITIES) {
    if (counts[severity] !== vulnerabilityEntries.filter((item) => item.severity === severity).length) {
      throw new Error('npm audit returned an unsupported or malformed report');
    }
  }
  const thresholdCounts = { high: counts?.high, critical: counts?.critical };
  const thresholdVulnerabilities = Object.fromEntries(Object.entries(report.vulnerabilities)
    .filter(([, vulnerability]) => vulnerability?.severity === 'high' || vulnerability?.severity === 'critical'));
  if (Object.keys(thresholdVulnerabilities).length === 0
      && isDeepStrictEqual(thresholdCounts, { high: 0, critical: 0 })) {
    if (auditResult.status !== 0) throw new Error('clean npm audit report exited non-zero');
    return { acceptedException: false };
  }
  if (auditResult.status !== 1) throw new Error('vulnerable npm audit report exited zero');
  if (now >= EXPIRES_AT) throw new Error('dependency audit exception expired at 2026-10-01T00:00:00.000Z');
  if (!isDeepStrictEqual(thresholdVulnerabilities, KNOWN_VULNERABILITIES)
      || !isDeepStrictEqual(thresholdCounts, KNOWN_THRESHOLD_COUNTS)) {
    throw new Error('npm audit findings differ from the pinned exception');
  }

  let lockfile;
  try {
    lockfile = JSON.parse(lockfileText);
  } catch {
    throw new Error('package-lock.json is not valid JSON');
  }
  for (const [key, expected] of LOCK_EXPECTATIONS) {
    if (lockValue(lockfile, key) !== expected) throw new Error(`package-lock.json drifted at ${key}`);
  }
  return { acceptedException: true };
}

function main() {
  const auditResult = spawnSync('npm', ['audit', '--audit-level=high', '--json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  let lockfileText;
  try {
    lockfileText = readFileSync('package-lock.json', 'utf8');
  } catch {
    console.error('[dependency-audit] FAIL: package-lock.json could not be read');
    console.error('Rerun `npm audit --audit-level=high --json` locally for raw diagnostics.');
    process.exitCode = 1;
    return;
  }
  try {
    const result = gateDependencyAudit({ auditResult, lockfileText });
    if (result.acceptedException) {
      console.error('');
      console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.error('WARNING: TEMPORARY HIGH-SEVERITY DEPENDENCY AUDIT EXCEPTION ACCEPTED');
      console.error('Allowed only for GHSA-xcpc-8h2w-3j85 and GHSA-f88m-g3jw-g9cj');
      console.error('Expires after 2026-09-30 UTC; remove or renew before that deadline.');
      console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    }
  } catch (error) {
    console.error(`[dependency-audit] FAIL: ${error instanceof Error ? error.message : 'unexpected gate failure'}`);
    console.error('Rerun `npm audit --audit-level=high --json` locally for raw diagnostics.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();

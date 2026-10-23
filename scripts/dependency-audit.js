import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const AUDIT_SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

function auditErrorCode(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'UNKNOWN';
}

export function gateDependencyAudit({ auditResult }) {
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
  if (counts.high === 0 && counts.critical === 0) {
    if (auditResult.status !== 0) throw new Error('below-threshold npm audit report exited non-zero');
    return;
  }
  if (auditResult.status !== 1) throw new Error('vulnerable npm audit report exited zero');
  throw new Error(`npm audit found ${counts.high} high and ${counts.critical} critical vulnerabilities`);
}

function main() {
  const auditResult = spawnSync('npm', ['audit', '--audit-level=high', '--json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  try {
    gateDependencyAudit({ auditResult });
  } catch (error) {
    console.error(`[dependency-audit] FAIL: ${error instanceof Error ? error.message : 'unexpected gate failure'}`);
    console.error('Rerun `npm audit --audit-level=high --json` locally for raw diagnostics.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();

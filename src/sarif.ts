import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRODUCT_NAME } from './branding.js';
import type { AffectedFile, Confidence, Evidence, ImpactReport } from './types.js';

export interface SarifOptions {
  category?: string;
  toolVersion?: string;
  informationUri?: string;
  checkoutRoot?: string;
}

export interface SarifLog {
  version: '2.1.0';
  $schema: string;
  runs: SarifRun[];
}

export interface SarifRun {
  tool: {
    driver: SarifToolComponent;
  };
  results: SarifResult[];
  invocations?: SarifInvocation[];
  automationDetails?: {
    id: string;
  };
  originalUriBaseIds?: Record<string, {
    uri: string;
  }>;
  properties?: Record<string, unknown>;
}

export interface SarifToolComponent {
  name: string;
  version?: string;
  informationUri?: string;
  rules: SarifReportingDescriptor[];
}

export interface SarifReportingDescriptor {
  id: string;
  name: string;
  shortDescription: {
    text: string;
  };
  fullDescription: {
    text: string;
  };
  defaultConfiguration: {
    level: SarifResultLevel;
  };
}

export type SarifResultLevel = 'none' | 'note' | 'warning' | 'error';

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifResultLevel;
  message: {
    text: string;
  };
  locations: SarifLocation[];
  relatedLocations?: SarifLocation[];
  codeFlows?: Array<{
    threadFlows: Array<{
      locations: Array<{
        location: SarifLocation;
      }>;
    }>;
  }>;
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}

export interface SarifLocation {
  id?: number;
  physicalLocation: {
    artifactLocation: {
      uri: string;
      uriBaseId?: string;
    };
    region?: SarifRegion;
  };
  message?: {
    text: string;
  };
}

export interface SarifRegion {
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  snippet?: {
    text: string;
  };
}

export interface SarifInvocation {
  executionSuccessful: boolean;
  properties?: Record<string, unknown>;
}

const packageMetadata = loadPackageMetadata();

const confidences: Confidence[] = ['proven', 'inferred', 'heuristic', 'unknown'];
const maxSnippetLength = 400;

export function impactReportToSarif(report: ImpactReport, options: SarifOptions = {}): SarifLog {
  const toolVersion = options.toolVersion ?? packageMetadata.version;
  const informationUri = options.informationUri ?? packageMetadata.homepage;
  const rules = confidences.map((confidence) => ruleForConfidence(confidence));
  const ruleIndex = new Map(rules.map((rule, index) => [rule.id, index]));
  const evidenceByAffectedFile = groupEvidenceByAffectedFile(report.evidence, report.affectedFiles);
  const results = report.affectedFiles.map((affectedFile) => {
    const evidence = evidenceByAffectedFile.get(affectedFile.path) ?? [];
    const ruleId = `parallax.impact.${affectedFile.confidence}`;
    const location = locationForAffectedFile(affectedFile, evidence, options.checkoutRoot);
    const relatedLocations = relatedLocationsFor(report, affectedFile, evidence, options.checkoutRoot);
    const codeFlows = codeFlowsFor(affectedFile, options.checkoutRoot);
    const evidenceIds = evidence.map((item) => item.id);
    const properties: Record<string, unknown> = {
      reportId: report.id,
      indexRunId: report.indexRunId,
      affectedPath: affectedFile.path,
      confidence: affectedFile.confidence,
      reason: affectedFile.reason,
      evidenceIds
    };
    if (affectedFile.depth !== undefined) properties.depth = affectedFile.depth;
    if (affectedFile.relationPath !== undefined) properties.relationPath = affectedFile.relationPath;

    return {
      ruleId,
      ruleIndex: ruleIndex.get(ruleId) ?? 0,
      level: levelForConfidence(affectedFile.confidence),
      message: {
        text: `${affectedFile.path} may be impacted: ${affectedFile.reason}`
      },
      locations: [location],
      ...(relatedLocations.length > 0 ? { relatedLocations } : {}),
      ...(codeFlows.length > 0 ? { codeFlows } : {}),
      partialFingerprints: {
        parallaxImpact: fingerprintFor(affectedFile, evidenceIds)
      },
      properties
    } satisfies SarifResult;
  });

  const run: SarifRun = {
    tool: {
      driver: {
        name: PRODUCT_NAME,
        ...(toolVersion ? { version: toolVersion } : {}),
        ...(informationUri ? { informationUri } : {}),
        rules
      }
    },
    results,
    invocations: [{
      executionSuccessful: true,
      properties: {
        reportId: report.id,
        changedFiles: report.changedFiles,
        warnings: report.warnings ?? []
      }
    }],
    ...(options.category ? { automationDetails: { id: options.category } } : {}),
    ...(options.checkoutRoot ? { originalUriBaseIds: { SRCROOT: { uri: pathToFileUri(options.checkoutRoot) } } } : {}),
    properties: {
      changedFiles: report.changedFiles,
      warnings: report.warnings ?? []
    }
  };

  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [run]
  };
}

function ruleForConfidence(confidence: Confidence): SarifReportingDescriptor {
  return {
    id: `parallax.impact.${confidence}`,
    name: `Parallax ${confidence} impact`,
    shortDescription: {
      text: `Parallax ${confidence} impact finding`
    },
    fullDescription: {
      text: `Parallax identified an affected file with ${confidence} confidence from the impact graph.`
    },
    defaultConfiguration: {
      level: levelForConfidence(confidence)
    }
  };
}

function levelForConfidence(confidence: Confidence): SarifResultLevel {
  return confidence === 'unknown' ? 'note' : 'warning';
}

function groupEvidenceByAffectedFile(
  evidence: readonly Evidence[],
  affectedFiles: readonly AffectedFile[]
): Map<string, Evidence[]> {
  const affectedPaths = new Set(affectedFiles.map((file) => normalizeReportPath(file.path)));
  const byFile = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const key = normalizeReportPath(item.file);
    if (!affectedPaths.has(key)) continue;
    const items = byFile.get(key) ?? [];
    items.push(item);
    byFile.set(key, items);
  }
  return byFile;
}

function locationForAffectedFile(
  affectedFile: AffectedFile,
  evidence: readonly Evidence[],
  checkoutRoot: string | undefined
): SarifLocation {
  const primaryEvidence = evidence.find((item) => item.startLine !== undefined) ?? evidence[0];
  const region = primaryEvidence ? regionForEvidence(primaryEvidence) : undefined;
  return {
    physicalLocation: {
      artifactLocation: artifactLocation(affectedFile.path, checkoutRoot),
      ...(region ? { region } : {})
    },
    message: {
      text: affectedFile.reason
    }
  };
}

function relatedLocationsFor(
  report: ImpactReport,
  affectedFile: AffectedFile,
  evidence: readonly Evidence[],
  checkoutRoot: string | undefined
): SarifLocation[] {
  const locations: SarifLocation[] = [];
  let id = 1;
  const add = (uri: string, message: string, region?: SarifRegion): void => {
    const normalized = normalizeReportPath(uri);
    if (normalized === normalizeReportPath(affectedFile.path) && region === undefined) return;
    locations.push({
      id,
      physicalLocation: {
        artifactLocation: artifactLocation(normalized, checkoutRoot),
        ...(region ? { region } : {})
      },
      message: { text: message }
    });
    id++;
  };

  for (const changedFile of report.changedFiles) {
    add(changedFile, 'Changed file');
  }
  for (const item of evidence) {
    add(item.file, `Evidence ${item.id}: ${item.kind}`, regionForEvidence(item));
  }
  return locations;
}

function codeFlowsFor(
  affectedFile: AffectedFile,
  checkoutRoot: string | undefined
): NonNullable<SarifResult['codeFlows']> {
  if (!affectedFile.relationPath || affectedFile.relationPath.length === 0) return [];
  const filePathLocations = affectedFile.relationPath
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => isRepoRelativeFilePath(part));
  if (filePathLocations.length === 0) return [];
  return [{
    threadFlows: [{
      locations: filePathLocations.map(({ part, index }) => ({
        location: {
          physicalLocation: {
            artifactLocation: artifactLocation(part, checkoutRoot)
          },
          message: {
            text: index === 0 ? 'Changed file' : `Impact path: ${part}`
          }
        }
      }))
    }]
  }];
}

function regionForEvidence(evidence: Evidence): SarifRegion | undefined {
  if (evidence.startLine === undefined && evidence.startCol === undefined && !evidence.snippet) {
    return undefined;
  }
  const region: SarifRegion = {};
  if (evidence.startLine !== undefined) region.startLine = evidence.startLine;
  if (evidence.endLine !== undefined) region.endLine = evidence.endLine;
  if (evidence.startCol !== undefined) region.startColumn = evidence.startCol;
  if (evidence.endCol !== undefined) region.endColumn = evidence.endCol;
  if (evidence.snippet) {
    region.snippet = { text: boundSnippet(evidence.snippet) };
  }
  return region;
}

function artifactLocation(filePath: string, checkoutRoot: string | undefined): SarifLocation['physicalLocation']['artifactLocation'] {
  return {
    uri: uriForPath(filePath, checkoutRoot),
    ...(checkoutRoot ? { uriBaseId: 'SRCROOT' } : {})
  };
}

function uriForPath(filePath: string, checkoutRoot: string | undefined): string {
  const normalized = normalizeReportPath(filePath);
  if (!path.isAbsolute(normalized)) return normalized;
  if (!checkoutRoot) return normalized.replaceAll(path.sep, '/');
  const relative = path.relative(checkoutRoot, normalized);
  return normalizeReportPath(relative);
}

function normalizeReportPath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function isRepoRelativeFilePath(value: string): boolean {
  const normalized = normalizeReportPath(value).trim();
  if (!normalized || normalized !== normalizeReportPath(value)) return false;
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value)) return false;
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) return false;
  if (normalized.endsWith('/')) return false;
  if (/[\s<>:"|?*\0]/u.test(normalized)) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(normalized)) return false;
  return normalized.includes('/') || path.posix.basename(normalized).includes('.');
}

function fingerprintFor(affectedFile: AffectedFile, evidenceIds: readonly string[]): string {
  const payload = {
    path: normalizeReportPath(affectedFile.path),
    reason: affectedFile.reason,
    confidence: affectedFile.confidence,
    relationPath: affectedFile.relationPath?.map(normalizeReportPath) ?? [],
    evidenceIds: [...evidenceIds].sort()
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function boundSnippet(snippet: string): string {
  const normalized = snippet.replace(/\s+$/u, '');
  if (normalized.length <= maxSnippetLength) return normalized;
  return `${normalized.slice(0, maxSnippetLength - 3)}...`;
}

function pathToFileUri(root: string): string {
  const resolved = path.resolve(root);
  const normalized = resolved.replaceAll(path.sep, '/');
  return `file://${normalized.endsWith('/') ? normalized : `${normalized}/`}`;
}

function loadPackageMetadata(): { version?: string; homepage?: string } {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(current, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
        homepage?: string;
      };
      if (parsed.name === 'parallax') {
        return {
          ...(parsed.version !== undefined ? { version: parsed.version } : {}),
          ...(parsed.homepage !== undefined ? { homepage: parsed.homepage } : {})
        };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

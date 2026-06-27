import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRODUCT_NAME } from './branding.js';
import type { AffectedFile, Confidence, CrossRepoImpact, Evidence, ImpactAction, ImpactReport } from './types.js';

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
const coverageGapRuleId = 'parallax.coverage-gap';
const contractBreakRuleId = 'parallax.contract-break';
const verificationRuleId = 'parallax.verification';
const adapterKnownGapRuleId = 'parallax.adapter-known-gap';
const maxSnippetLength = 400;

type AdapterKnownGapEntry = {
  adapterId: string;
  adapterVersion: string;
  languageIds: string[];
  status: string;
  confidence: Confidence;
  gap: string;
  gapIndex: number;
};

export function impactReportToSarif(report: ImpactReport, options: SarifOptions = {}): SarifLog {
  const toolVersion = options.toolVersion ?? packageMetadata.version;
  const informationUri = options.informationUri ?? packageMetadata.homepage;
  const rules = [
    ...confidences.map((confidence) => ruleForConfidence(confidence)),
    coverageGapRule(),
    contractBreakRule(),
    verificationActionRule(),
    adapterKnownGapRule()
  ];
  const ruleIndex = new Map(rules.map((rule, index) => [rule.id, index]));
  const uploadableChangedFiles = report.changedFiles.filter(isRepoRelativeFilePath);
  const uploadableAffectedFiles = report.affectedFiles.filter((affectedFile) =>
    isRepoRelativeFilePath(affectedFile.path)
  );
  const omittedAffectedFiles = report.affectedFiles
    .filter((affectedFile) => !isRepoRelativeFilePath(affectedFile.path))
    .map((affectedFile) => ({
      path: affectedFile.path,
      confidence: affectedFile.confidence,
      reason: affectedFile.reason
    }));
  const evidenceByAffectedFile = groupEvidenceByAffectedFile(report.evidence, uploadableAffectedFiles);
  const impactResults = uploadableAffectedFiles.map((affectedFile) => {
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
  const uploadableActions = report.actions.filter((action) =>
    action.target.path !== undefined && isRepoRelativeFilePath(action.target.path)
  );
  const verificationResults = uploadableActions.map((action) =>
    verificationResultFor(report, action, ruleIndex, options.checkoutRoot)
  );
  const coverageGapFiles = coverageGapFilesFor(report);
  const uploadableCoverageGapFiles = coverageGapFiles.filter(isRepoRelativeFilePath);
  const coverageGapResults = uploadableCoverageGapFiles.map((filePath) =>
    coverageGapResultFor(report, filePath, ruleIndex, options.checkoutRoot)
  );
  const contractBreakImpacts = report.crossRepoImpacts ?? [];
  const uploadableContractBreakImpacts = contractBreakImpacts.filter((impact) =>
    isRepoRelativeFilePath(impact.provider.contractPath)
  );
  const contractBreakResults = uploadableContractBreakImpacts.map((impact) =>
    contractBreakResultFor(report, impact, ruleIndex, options.checkoutRoot)
  );
  const adapterKnownGaps = adapterKnownGapEntries(report);
  const adapterKnownGapResults = uploadableChangedFiles.length > 0
    ? adapterKnownGaps.map((knownGap) =>
      adapterKnownGapResultFor(report, knownGap, uploadableChangedFiles, ruleIndex, options.checkoutRoot)
    )
    : [];
  const results = [
    ...impactResults,
    ...coverageGapResults,
    ...contractBreakResults,
    ...verificationResults,
    ...adapterKnownGapResults
  ];

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
        warnings: report.warnings ?? [],
        omittedAffectedFileCount: omittedAffectedFiles.length,
        omittedAffectedFiles,
        verificationActionCount: uploadableActions.length,
        omittedVerificationActionCount: report.actions.length - uploadableActions.length,
        coverageGapCount: coverageGapResults.length,
        omittedCoverageGapCount: coverageGapFiles.length - coverageGapResults.length,
        contractBreakCount: contractBreakResults.length,
        omittedContractBreakCount: contractBreakImpacts.length - contractBreakResults.length,
        adapterKnownGapCount: adapterKnownGapResults.length,
        omittedAdapterKnownGapCount: adapterKnownGaps.length - adapterKnownGapResults.length
      }
    }],
    ...(options.category ? { automationDetails: { id: options.category } } : {}),
    ...(options.checkoutRoot ? { originalUriBaseIds: { SRCROOT: { uri: pathToFileUri(options.checkoutRoot) } } } : {}),
    properties: {
      changedFiles: report.changedFiles,
      warnings: report.warnings ?? [],
      omittedAffectedFileCount: omittedAffectedFiles.length,
      omittedAffectedFiles,
      verificationActionCount: uploadableActions.length,
      omittedVerificationActionCount: report.actions.length - uploadableActions.length,
      coverageGapCount: coverageGapResults.length,
      omittedCoverageGapCount: coverageGapFiles.length - coverageGapResults.length,
      contractBreakCount: contractBreakResults.length,
      omittedContractBreakCount: contractBreakImpacts.length - contractBreakResults.length,
      adapterKnownGapCount: adapterKnownGapResults.length,
      omittedAdapterKnownGapCount: adapterKnownGaps.length - adapterKnownGapResults.length
    }
  };

  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [run]
  };
}

function verificationActionRule(): SarifReportingDescriptor {
  return {
    id: verificationRuleId,
    name: 'Parallax verification action',
    shortDescription: {
      text: 'Parallax recommended verification action'
    },
    fullDescription: {
      text: 'Parallax identified a test or review command that should be run for this impact analysis.'
    },
    defaultConfiguration: {
      level: 'note'
    }
  };
}

function coverageGapRule(): SarifReportingDescriptor {
  return {
    id: coverageGapRuleId,
    name: 'Parallax coverage gap',
    shortDescription: {
      text: 'Parallax index coverage gap'
    },
    fullDescription: {
      text: 'Parallax could not find a changed file in the latest completed index run, so impact analysis may be incomplete.'
    },
    defaultConfiguration: {
      level: 'warning'
    }
  };
}

function contractBreakRule(): SarifReportingDescriptor {
  return {
    id: contractBreakRuleId,
    name: 'Parallax contract break',
    shortDescription: {
      text: 'Parallax cross-repo contract break'
    },
    fullDescription: {
      text: 'Parallax identified a breaking provider contract change with a persisted cross-repo consumer impact.'
    },
    defaultConfiguration: {
      level: 'warning'
    }
  };
}

function adapterKnownGapRule(): SarifReportingDescriptor {
  return {
    id: adapterKnownGapRuleId,
    name: 'Parallax adapter known gap',
    shortDescription: {
      text: 'Parallax adapter known gap'
    },
    fullDescription: {
      text: 'Parallax identified an extraction limitation from an adapter used by this impact analysis.'
    },
    defaultConfiguration: {
      level: 'note'
    }
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

function coverageGapResultFor(
  report: ImpactReport,
  filePath: string,
  ruleIndex: Map<string, number>,
  checkoutRoot: string | undefined
): SarifResult {
  return {
    ruleId: coverageGapRuleId,
    ruleIndex: ruleIndex.get(coverageGapRuleId) ?? 0,
    level: 'warning',
    message: {
      text: `Index coverage gap: ${filePath} was not present in index run ${report.indexRunId}`
    },
    locations: [{
      physicalLocation: {
        artifactLocation: artifactLocation(filePath, checkoutRoot)
      },
      message: {
        text: 'Changed file not present in latest index'
      }
    }],
    partialFingerprints: {
      parallaxImpact: fingerprintForCoverageGap(report, filePath)
    },
    properties: {
      reportId: report.id,
      indexRunId: report.indexRunId,
      changedPath: filePath,
      reason: 'changed file not in index'
    }
  };
}

function contractBreakResultFor(
  report: ImpactReport,
  impact: CrossRepoImpact,
  ruleIndex: Map<string, number>,
  checkoutRoot: string | undefined
): SarifResult {
  const anchorPath = impact.provider.contractPath;
  const consumer = consumerLabel(impact);
  const change = contractChangeLabel(impact);
  return {
    ruleId: contractBreakRuleId,
    ruleIndex: ruleIndex.get(contractBreakRuleId) ?? 0,
    level: levelForConfidence(impact.confidence),
    message: {
      text: `Breaking contract change may affect ${consumer}: ${change}`
    },
    locations: [{
      physicalLocation: {
        artifactLocation: artifactLocation(anchorPath, checkoutRoot)
      },
      message: {
        text: `Provider contract ${impact.provider.serviceName}:${impact.provider.contractPath}`
      }
    }],
    partialFingerprints: {
      parallaxImpact: fingerprintForContractBreak(impact)
    },
    properties: {
      reportId: report.id,
      indexRunId: report.indexRunId,
      workspace: impact.workspace,
      providerServiceName: impact.provider.serviceName,
      providerContractPath: impact.provider.contractPath,
      consumerServiceName: impact.consumer.serviceName,
      consumerPath: impact.consumer.path,
      confidence: impact.confidence,
      changeKind: impact.change.kind,
      ...(impact.change.method === undefined ? {} : { changeMethod: impact.change.method }),
      ...(impact.change.path === undefined ? {} : { changePath: impact.change.path }),
      ...(impact.change.previousEndpointId === undefined ? {} : {
        previousEndpointId: impact.change.previousEndpointId
      }),
      evidenceFilePath: impact.evidence.filePath,
      ...(impact.resources === undefined ? {} : { resources: impact.resources })
    }
  };
}

function adapterKnownGapResultFor(
  report: ImpactReport,
  knownGap: AdapterKnownGapEntry,
  changedFiles: readonly string[],
  ruleIndex: Map<string, number>,
  checkoutRoot: string | undefined
): SarifResult {
  const anchorPath = changedFiles[0]!;
  const relatedLocations = changedFiles.slice(1).map((changedFile, index) => ({
    id: index + 1,
    physicalLocation: {
      artifactLocation: artifactLocation(changedFile, checkoutRoot)
    },
    message: {
      text: 'Changed file in this analysis'
    }
  }));
  return {
    ruleId: adapterKnownGapRuleId,
    ruleIndex: ruleIndex.get(adapterKnownGapRuleId) ?? 0,
    level: 'note',
    message: {
      text: `Adapter known gap: ${knownGap.adapterId}: ${knownGap.gap}`
    },
    locations: [{
      physicalLocation: {
        artifactLocation: artifactLocation(anchorPath, checkoutRoot)
      },
      message: {
        text: `${knownGap.adapterId} known gap: ${knownGap.gap}`
      }
    }],
    ...(relatedLocations.length > 0 ? { relatedLocations } : {}),
    partialFingerprints: {
      parallaxImpact: fingerprintForAdapterKnownGap(knownGap, changedFiles)
    },
    properties: {
      reportId: report.id,
      indexRunId: report.indexRunId,
      adapterId: knownGap.adapterId,
      adapterVersion: knownGap.adapterVersion,
      adapterStatus: knownGap.status,
      languageIds: knownGap.languageIds,
      confidence: knownGap.confidence,
      knownGap: knownGap.gap,
      knownGapIndex: knownGap.gapIndex,
      anchorPath
    }
  };
}

function coverageGapFilesFor(report: ImpactReport): string[] {
  const changedPaths = new Set(report.changedFiles.map(normalizeReportPath));
  const coverageGapFiles = new Set<string>();
  for (const affectedFile of report.affectedFiles) {
    const normalizedPath = normalizeReportPath(affectedFile.path);
    if (affectedFile.reason !== 'changed file not in index') continue;
    if (!changedPaths.has(normalizedPath)) continue;
    coverageGapFiles.add(normalizedPath);
  }
  return [...coverageGapFiles].sort();
}

function consumerLabel(impact: CrossRepoImpact): string {
  return impact.consumer.serviceName
    ? `${impact.consumer.serviceName}:${impact.consumer.path}`
    : impact.consumer.path;
}

function contractChangeLabel(impact: CrossRepoImpact): string {
  return [
    impact.change.kind,
    impact.change.method,
    impact.change.path
  ].filter((part): part is string => part !== undefined && part !== '').join(' ');
}

function verificationResultFor(
  report: ImpactReport,
  action: ImpactAction,
  ruleIndex: Map<string, number>,
  checkoutRoot: string | undefined
): SarifResult {
  const targetPath = action.target.path!;
  return {
    ruleId: verificationRuleId,
    ruleIndex: ruleIndex.get(verificationRuleId) ?? 0,
    level: 'note',
    message: {
      text: `Recommended verification: ${action.display}`
    },
    locations: [{
      physicalLocation: {
        artifactLocation: artifactLocation(targetPath, checkoutRoot)
      },
      message: {
        text: action.display
      }
    }],
    partialFingerprints: {
      parallaxImpact: fingerprintForAction(action)
    },
    properties: {
      reportId: report.id,
      indexRunId: report.indexRunId,
      actionKind: action.kind,
      confidence: action.confidence,
      targetPath,
      display: action.display,
      ...(action.runnerId === undefined ? {} : { runnerId: action.runnerId }),
      ...(action.command === undefined ? {} : { command: action.command }),
      ...(action.args === undefined ? {} : { args: action.args })
    }
  };
}

function adapterKnownGapEntries(report: ImpactReport): AdapterKnownGapEntry[] {
  const entries: AdapterKnownGapEntry[] = [];
  for (const adapter of report.adapterInsights ?? []) {
    adapter.knownGaps.forEach((gap, gapIndex) => {
      const normalizedGap = gap.trim();
      if (!normalizedGap) return;
      entries.push({
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        languageIds: adapter.languageIds,
        status: adapter.status,
        confidence: adapter.confidence,
        gap: normalizedGap,
        gapIndex
      });
    });
  }
  return entries;
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

function fingerprintForCoverageGap(report: ImpactReport, filePath: string): string {
  const payload = {
    indexRunId: report.indexRunId,
    path: normalizeReportPath(filePath),
    reason: 'changed file not in index'
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function fingerprintForContractBreak(impact: CrossRepoImpact): string {
  const payload = {
    workspace: impact.workspace,
    provider: {
      serviceName: impact.provider.serviceName,
      contractPath: normalizeReportPath(impact.provider.contractPath)
    },
    consumer: {
      serviceName: impact.consumer.serviceName,
      path: impact.consumer.path
    },
    change: impact.change,
    confidence: impact.confidence
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function fingerprintForAdapterKnownGap(
  knownGap: AdapterKnownGapEntry,
  changedFiles: readonly string[]
): string {
  const payload = {
    adapterId: knownGap.adapterId,
    adapterVersion: knownGap.adapterVersion,
    gap: knownGap.gap,
    changedFiles: [...changedFiles].map(normalizeReportPath).sort()
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function fingerprintForAction(action: ImpactAction): string {
  const payload = {
    path: action.target.path ? normalizeReportPath(action.target.path) : action.target.id,
    kind: action.kind,
    display: action.display,
    command: action.command,
    args: action.args ?? []
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

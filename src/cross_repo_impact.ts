import { createHash } from 'node:crypto';
import path from 'node:path';

import { asConfidence } from './confidence.js';
import { parseJsonObject } from './contract_diff/shared.js';
import { normalizeRepoRoot } from './security.js';
import { openDatabase } from './store.js';
import { workspaceResources } from './workspace_resources.js';
import type {
  AffectedFile,
  CrossRepoImpact,
  Evidence,
  ImpactTarget
} from './types.js';

export type CrossRepoImpactCandidate = {
  impact: CrossRepoImpact;
  affectedFile: AffectedFile;
  affectedTarget: ImpactTarget;
  evidence: Evidence;
};

export type CrossRepoImpactLoadOptions = {
  db: ReturnType<typeof openDatabase>;
  repoRoot: string;
  repoId: number;
  indexRunId: number;
  changedFile: string;
};

export type CrossRepoImpactLoadResult = {
  candidates: CrossRepoImpactCandidate[];
  malformedLinkCount: number;
};

type ContractRow = {
  service_name: string | null;
};

type BreakLinkRow = {
  id: string;
  workspace_name: string;
  confidence: string;
  provenance: string;
};

type ParsedBreakLink = {
  consumer: {
    serviceName: string;
    repoPath?: string;
    path: string;
  };
  provider: {
    serviceName: string;
    repoPath?: string;
    contractPath: string;
  };
  change: {
    kind: string;
    method?: string;
    path?: string;
    previousEndpointId?: string;
  };
  evidence: {
    filePath: string;
    snippet: string;
  };
};

export function loadCrossRepoImpactsForChangedContract(
  options: CrossRepoImpactLoadOptions
): CrossRepoImpactLoadResult {
  const { db, repoRoot, repoId, indexRunId, changedFile } = options;
  if (!hasTables(db, ['contracts', 'contract_versions', 'cross_repo_links', 'workspaces'])) {
    return { candidates: [], malformedLinkCount: 0 };
  }

  const contract = db
    .prepare(
      `SELECT c.service_name
         FROM contracts c
         INNER JOIN contract_versions v ON v.contract_id = c.id
        WHERE c.repo_id = ?
          AND c.path = ?
          AND v.index_run_id = ?
        LIMIT 1`
    )
    .get(repoId, changedFile, indexRunId) as ContractRow | undefined;
  if (!contract) return { candidates: [], malformedLinkCount: 0 };

  const rows = db
    .prepare(
      `SELECT link.id, workspace.name AS workspace_name, link.confidence, link.provenance
         FROM cross_repo_links link
         LEFT JOIN workspaces workspace ON workspace.id = link.workspace_id
        WHERE link.target_repo_id = ?
          AND link.kind = 'BREAKS_COMPATIBILITY_WITH'
        ORDER BY link.id`
    )
    .all(repoId) as BreakLinkRow[];

  const candidates: CrossRepoImpactCandidate[] = [];
  let malformedLinkCount = 0;
  for (const row of rows) {
    const parsed = parseBreakLink(row.provenance);
    if (!parsed) {
      malformedLinkCount += 1;
      continue;
    }
    if (parsed.provider.contractPath !== changedFile) continue;
    if (!providerRepoMatches(parsed.provider.repoPath, repoRoot)) continue;

    const workspaceName = row.workspace_name;
    if (!workspaceName) {
      malformedLinkCount += 1;
      continue;
    }

    const confidence = asConfidence(row.confidence);
    const displayPath = `${parsed.consumer.serviceName}:${parsed.consumer.path}`;
    const providerDisplayPath = `${parsed.provider.serviceName}:${parsed.provider.contractPath}`;
    const relationPath = [`${displayPath} BREAKS_COMPATIBILITY_WITH ${providerDisplayPath}`];
    const subject = {
      id: `cross-repo:${workspaceName}:${displayPath}`,
      kind: 'external_entity' as const,
      path: displayPath,
      displayName: displayPath
    };
    const target = {
      id: `contract:${providerDisplayPath}`,
      kind: 'contract' as const,
      path: parsed.provider.contractPath,
      displayName: providerDisplayPath
    };
    const resources = workspaceResources(workspaceName);
    const publicProviderRepoPath = publicRepoPath(parsed.provider.repoPath);
    const publicConsumerRepoPath = publicRepoPath(parsed.consumer.repoPath);
    const publicEvidenceFilePath = publicFilePath(parsed.evidence.filePath, displayPath);
    const evidenceId = createHash('sha1')
      .update(`${row.id}:${displayPath}:BREAKS_COMPATIBILITY_WITH:${providerDisplayPath}`)
      .digest('hex')
      .slice(0, 16);

    const impact: CrossRepoImpact = {
      workspace: workspaceName,
      provider: {
        serviceName: parsed.provider.serviceName || contract.service_name || '',
        ...(publicProviderRepoPath ? { repoPath: publicProviderRepoPath } : {}),
        contractPath: parsed.provider.contractPath
      },
      consumer: {
        serviceName: parsed.consumer.serviceName,
        ...(publicConsumerRepoPath ? { repoPath: publicConsumerRepoPath } : {}),
        path: parsed.consumer.path
      },
      change: parsed.change,
      confidence,
      evidence: {
        filePath: publicEvidenceFilePath,
        snippet: parsed.evidence.snippet
      },
      resources: {
        workspace: resources.workspace,
        crossRepoLinks: resources.crossRepoLinks
      }
    };

    candidates.push({
      impact,
      affectedFile: {
        path: displayPath,
        reason: `breaks cross-repo consumer ${parsed.consumer.serviceName} via ${parsed.provider.contractPath}`,
        confidence,
        depth: 1,
        relationPath
      },
      affectedTarget: {
        target: subject,
        relations: relationPath,
        confidence
      },
      evidence: {
        id: evidenceId,
        file: displayPath,
        kind: 'BREAKS_COMPATIBILITY_WITH',
        snippet: parsed.evidence.snippet,
        confidence,
        subject,
        target,
        relationKind: 'BREAKS_COMPATIBILITY_WITH',
        relationConfidence: confidence,
        extractorId: 'cross-repo-contract-impact'
      }
    });
  }

  return {
    candidates: dedupeCandidates(candidates),
    malformedLinkCount
  };
}

function hasTables(db: ReturnType<typeof openDatabase>, tables: string[]): boolean {
  return tables.every((table) =>
    db
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function parseBreakLink(provenanceJson: string): ParsedBreakLink | undefined {
  const provenance = parseJsonObject(provenanceJson);
  if (!provenance) return undefined;
  const consumer = objectAt(provenance, 'consumer');
  const provider = objectAt(provenance, 'provider');
  const change = objectAt(provenance, 'change');
  const evidence = objectAt(provenance, 'evidence');
  const consumerRepoPath = optionalStringAt(consumer, 'repoPath');
  const providerRepoPath = optionalStringAt(provider, 'repoPath');
  const changeMethod = optionalStringAt(change, 'method');
  const changePath = optionalStringAt(change, 'path');
  const previousEndpointId = optionalStringAt(change, 'previousEndpointId');
  const parsed: ParsedBreakLink = {
    consumer: {
      serviceName: stringAt(consumer, 'serviceName'),
      ...(consumerRepoPath ? { repoPath: consumerRepoPath } : {}),
      path: stringAt(consumer, 'path')
    },
    provider: {
      serviceName: stringAt(provider, 'serviceName'),
      ...(providerRepoPath ? { repoPath: providerRepoPath } : {}),
      contractPath: stringAt(provider, 'contractPath')
    },
    change: {
      kind: stringAt(change, 'kind'),
      ...(changeMethod ? { method: changeMethod } : {}),
      ...(changePath ? { path: changePath } : {}),
      ...(previousEndpointId ? { previousEndpointId } : {})
    },
    evidence: {
      filePath: stringAt(evidence, 'filePath'),
      snippet: stringAt(evidence, 'snippet')
    }
  };

  if (
    !parsed.provider.serviceName ||
    !parsed.provider.contractPath ||
    !parsed.consumer.serviceName ||
    !parsed.consumer.path ||
    !parsed.change.kind ||
    !parsed.evidence.filePath ||
    !parsed.evidence.snippet
  ) {
    return undefined;
  }
  return parsed;
}

function objectAt(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const child = value?.[key];
  return child && typeof child === 'object' && !Array.isArray(child)
    ? child as Record<string, unknown>
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string {
  const child = value?.[key];
  return typeof child === 'string' ? child : '';
}

function optionalStringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const child = stringAt(value, key);
  return child.length > 0 ? child : undefined;
}

function providerRepoMatches(providerRepoPath: string | undefined, repoRoot: string): boolean {
  if (!providerRepoPath) return true;
  try {
    return normalizeRepoRoot(providerRepoPath) === repoRoot;
  } catch {
    return path.resolve(providerRepoPath) === repoRoot;
  }
}

function publicRepoPath(repoPath: string | undefined): string | undefined {
  if (!repoPath || path.isAbsolute(repoPath)) return undefined;
  return repoPath;
}

function publicFilePath(filePath: string, fallbackDisplayPath: string): string {
  return path.isAbsolute(filePath) ? fallbackDisplayPath : filePath;
}

function dedupeCandidates(candidates: CrossRepoImpactCandidate[]): CrossRepoImpactCandidate[] {
  const deduped = new Map<string, CrossRepoImpactCandidate>();
  for (const candidate of candidates.sort(compareCandidates)) {
    const key = [
      candidate.affectedFile.path,
      candidate.evidence.relationKind ?? candidate.evidence.kind,
      candidate.evidence.target?.id ?? '',
      candidate.evidence.id
    ].join('\0');
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  return [...deduped.values()].sort(compareCandidates);
}

function compareCandidates(left: CrossRepoImpactCandidate, right: CrossRepoImpactCandidate): number {
  return left.affectedFile.path.localeCompare(right.affectedFile.path)
    || (left.evidence.relationKind ?? left.evidence.kind).localeCompare(right.evidence.relationKind ?? right.evidence.kind)
    || (left.evidence.target?.id ?? '').localeCompare(right.evidence.target?.id ?? '')
    || left.evidence.id.localeCompare(right.evidence.id);
}

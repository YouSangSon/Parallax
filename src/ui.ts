import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { doctorProject, type DoctorReport } from './doctor.js';
import { exportImpactGraph } from './graph.js';
import { databasePath, getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { normalizeRepoRoot } from './security.js';
import type { GraphExport, ImpactAction, ImpactReport } from './types.js';

export type UiOptions = {
  repoRoot: string;
  reportId?: string;
};

export type UiServerOptions = UiOptions & {
  host?: string;
  port?: number;
};

export type UiSnapshot = {
  version: 0;
  generatedAt: string;
  repoRoot: string;
  selectedReportId: string | null;
  doctor: DoctorReport;
  errors: UiError[];
  reports: UiReportSummary[];
  selectedReport: UiReportPreview | null;
  graph: UiGraphPreview | null;
  coverage: UiCoverageSnapshot | null;
  contextPacks: UiContextPackSummary[];
  workArtifacts: UiWorkArtifactImpact[];
  workspaces: UiWorkspaceSnapshot[];
};

export type UiError = {
  code: string;
  message: string;
  fix?: string;
};

export type UiReportSummary = {
  id: string;
  indexRunId: number;
  createdAt: string;
  changedFiles: string[];
  changedCount: number;
  affectedCount: number;
  evidenceCount: number;
  actionCount: number;
};

export type UiReportPreview = UiReportSummary & {
  changed: ImpactReport['changed'];
  affectedFiles: ImpactReport['affectedFiles'];
  evidence: UiEvidencePreview[];
  actions: ImpactAction[];
  warnings: string[];
};

export type UiEvidencePreview = ImpactReport['evidence'][number] & {
  snippetOmitted?: boolean;
  omittedReason?: string;
  resourceUri?: string;
};

export type UiGraphPreview = {
  nodes: GraphExport['nodes'];
  edges: GraphExport['edges'];
  totalNodes: number;
  totalEdges: number;
};

export type UiContextPackSummary = {
  id: string;
  budget: string;
  indexRunId: number;
  returnedBytes: number;
  hitCount: number;
  createdAt: string;
  lastAccessedAt: string;
};

export type UiCoverageSnapshot = {
  indexRunId: number;
  coverage: Array<{
    path: string;
    languageId: string | null;
    status: string;
    reason: string;
    adapterId: string;
  }>;
  limit: number;
  truncated: boolean;
};

export type UiWorkArtifactImpact = {
  kind: string;
  path: string;
  displayName: string;
  reason: string;
  confidence: string;
  relations: string[];
  resourceUri: string;
  depth?: number;
};

export type UiWorkspaceSnapshot = {
  name: string;
  repoCount: number;
  contracts: UiWorkspaceContract[];
  links: UiWorkspaceLink[];
  warnings: string[];
  resources: {
    workspace: string;
    contracts: string;
    crossRepoLinks: string;
  };
  limits: {
    contracts: number;
    links: number;
    contractsTruncated: boolean;
    linksTruncated: boolean;
  };
};

export type UiWorkspaceContract = {
  id: string;
  serviceName: string;
  repoPath: string;
  path: string;
  kind: string;
  indexRunId: number;
  endpointCount: number;
  schemaVersion?: string;
};

export type UiWorkspaceLink = {
  id: string;
  kind: string;
  confidence: string;
  sourceService: string;
  targetService: string;
  routeLabel?: string;
  consumerPath?: string;
  providerContractPath?: string;
  eventTopology?: {
    providerAction: string;
    counterpartyRole: 'consumer' | 'producer' | 'unknown';
    pattern: string;
  };
};

type ReportRow = {
  id: string;
  index_run_id: number;
  json: string;
  created_at: string;
};

type ContextPackRow = {
  id: string;
  budget: string;
  index_run_id: number;
  returned_bytes: number;
  hit_count: number;
  created_at: string;
  last_accessed_at: string;
};

type GraphPageCursor = {
  nodeOffset: number;
  edgeOffset: number;
};

type WorkspaceRow = {
  id: number;
  name: string;
};

type WorkspaceRepoRow = {
  local_path: string;
  service_name: string | null;
};

type WorkspaceContractRow = {
  id: string;
  kind: string;
  service_name: string | null;
  path: string | null;
  schema_version: string | null;
  endpoint_count: number;
};

type WorkspaceLinkRow = {
  id: string;
  kind: string;
  confidence: string;
  provenance: string;
  source_path: string;
  source_service: string | null;
  target_path: string;
  target_service: string | null;
};

export async function buildUiSnapshot(options: UiOptions): Promise<UiSnapshot> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const doctor = doctorProject({ repoRoot });
  const generatedAt = new Date().toISOString();
  if (!doctor.database.exists || !existsSync(databasePath(repoRoot))) {
    return {
      version: 0,
      generatedAt,
      repoRoot,
      selectedReportId: null,
      doctor,
      errors: [{
        code: 'database_missing',
        message: 'Impact database not found for this repository.',
        fix: 'Run impact-trace init and impact-trace index before opening the UI.'
      }],
      reports: [],
      selectedReport: null,
      graph: null,
      coverage: null,
      contextPacks: [],
      workArtifacts: [],
      workspaces: []
    };
  }

  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const reportRows = db
      .prepare('SELECT id, index_run_id, json, created_at FROM reports WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT 20')
      .all(repoId) as ReportRow[];
    const requestedReport = options.reportId
      ? reportRows.find((row) => row.id === options.reportId)
        ?? db
          .prepare('SELECT id, index_run_id, json, created_at FROM reports WHERE repo_id = ? AND id = ?')
          .get(repoId, options.reportId) as ReportRow | undefined
        ?? null
      : undefined;
    const selectorRows =
      requestedReport && !reportRows.some((row) => row.id === requestedReport.id)
        ? [requestedReport, ...reportRows.slice(0, 19)]
        : reportRows;
    const reports = selectorRows.map(reportSummaryFromRow);
    const errors: UiError[] = [];
    if (options.reportId && !requestedReport) {
      errors.push({
        code: 'report_not_found',
        message: `Impact report not found: ${options.reportId}`,
        fix: 'Choose a report from the selector or run impact-trace analyze to create a current report.'
      });
    } else if (!options.reportId && reportRows.length === 0) {
      errors.push({
        code: 'report_missing',
        message: 'No persisted impact reports were found.',
        fix: 'Run impact-trace analyze --changed <path> to create a report.'
      });
    }
    const selectedRow = requestedReport ?? (options.reportId ? null : reportRows[0] ?? null);
    const selectedReport = selectedRow ? reportPreviewFromRow(selectedRow) : null;
    const graph = selectedRow ? await graphPreview(repoRoot, selectedRow.id) : null;
    return {
      version: 0,
      generatedAt,
      repoRoot,
      selectedReportId: selectedRow?.id ?? null,
      doctor,
      errors,
      reports,
      selectedReport,
      graph,
      coverage: readLatestCoverage(db, repoId),
      contextPacks: readContextPacks(db, repoId),
      workArtifacts: selectedRow ? workArtifactsFromReportRow(selectedRow) : [],
      workspaces: readWorkspaceSnapshots(db)
    };
  } finally {
    db.close();
  }
}

export function renderUiHtml(snapshot: UiSnapshot): string {
  const report = snapshot.selectedReport;
  const doctor = snapshot.doctor;
  const title = report ? `Impact Workbench - ${report.id}` : 'Impact Workbench';
  const missingReportOption = snapshot.selectedReportId === null && snapshot.reports.length > 0
    ? '<option value="" selected>Select a report</option>'
    : '';
  const reportOptions = missingReportOption + snapshot.reports.map((item) =>
    `<option value="${escapeHtml(item.id)}"${item.id === snapshot.selectedReportId ? ' selected' : ''}>${escapeHtml(item.id)}</option>`
  ).join('');
  const findings = doctor.findings.map((finding) => `
    <li class="finding finding-${escapeHtml(finding.severity)}">
      <strong>${escapeHtml(finding.code)}</strong>
      <span>${escapeHtml(finding.message)}</span>
    </li>
  `).join('');
  const errors = snapshot.errors.map((error) => `
    <li class="finding finding-error">
      <strong>${escapeHtml(error.code)}</strong>
      <span>${escapeHtml(error.message)}</span>
      ${error.fix ? `<small>${escapeHtml(error.fix)}</small>` : ''}
    </li>
  `).join('');
  const changedRows = (report?.changed ?? []).map((entity) => `
    <li class="entity-row">
      <span class="kind">${escapeHtml(entity.kind)}</span>
      <span>${escapeHtml(entity.displayName ?? entity.path ?? entity.id)}</span>
    </li>
  `).join('');
  const affectedRows = (report?.affectedFiles ?? []).slice(0, 40).map((item) => `
    <li class="impact-row" data-filter-text="${escapeHtml(`${item.path} ${item.reason} ${item.confidence}`)}">
      <div>
        <strong>${escapeHtml(item.path)}</strong>
        <span>${escapeHtml(item.reason)}</span>
      </div>
      <span class="badge confidence-${escapeHtml(item.confidence)}">${escapeHtml(item.confidence)}</span>
    </li>
  `).join('');
  const evidenceRows = (report?.evidence ?? []).slice(0, 30).map((item) => `
    <li class="evidence-row" data-filter-text="${escapeHtml(`${item.file} ${item.kind} ${item.snippet}`)}">
      <div class="evidence-meta">
        <strong>${escapeHtml(item.file)}</strong>
        <span>${escapeHtml(item.kind)} · ${escapeHtml(item.confidence)}</span>
        ${item.resourceUri ? `<small>${escapeHtml(item.resourceUri)}</small>` : ''}
      </div>
      <pre>${escapeHtml(item.snippet)}</pre>
    </li>
  `).join('');
  const actionRows = (report?.actions ?? []).slice(0, 20).map((item) => `
    <li class="action-row">
      <span class="kind">${escapeHtml(item.kind)}</span>
      <span>${escapeHtml(item.display)}</span>
      ${item.command ? `<code>${escapeHtml(item.command)}</code>` : ''}
    </li>
  `).join('');
  const graphNodes = (snapshot.graph?.nodes ?? []).slice(0, 28).map((node) => `
    <li>
      <span class="node-dot ${escapeHtml(node.group ?? 'neutral')}"></span>
      <span>${escapeHtml(node.label)}</span>
      <small>${escapeHtml(node.kind)}</small>
    </li>
  `).join('');
  const graphEdges = (snapshot.graph?.edges ?? []).slice(0, 24).map((edge) => `
    <li><span>${escapeHtml(edge.source)}</span><b>${escapeHtml(edge.kind)}</b><span>${escapeHtml(edge.target)}</span></li>
  `).join('');
  const contextPackRows = snapshot.contextPacks.map((pack) => `
    <li class="pack-row">
      <strong>${escapeHtml(pack.id)}</strong>
      <span>${escapeHtml(pack.budget)} · hits ${pack.hitCount} · ${pack.returnedBytes} bytes</span>
    </li>
  `).join('');
  const coverageRows = (snapshot.coverage?.coverage ?? []).slice(0, 30).map((item) => `
    <li class="coverage-row">
      <strong>${escapeHtml(item.path)}</strong>
      <span>${escapeHtml(item.status)} · ${escapeHtml(item.adapterId)} · ${escapeHtml(item.reason)}</span>
    </li>
  `).join('');
  const workArtifactRows = snapshot.workArtifacts.slice(0, 30).map((item) => `
    <li class="work-artifact-row" data-filter-text="${escapeHtml(`${item.kind} ${item.path} ${item.reason} ${item.relations.join(' ')}`)}">
      <div>
        <strong>${escapeHtml(item.displayName)}</strong>
        <span>${escapeHtml(item.kind)} · ${escapeHtml(item.reason)} · ${escapeHtml(item.confidence)}</span>
        <small>${escapeHtml(item.resourceUri)}</small>
      </div>
    </li>
  `).join('');
  const workspaceRows = snapshot.workspaces.flatMap((workspace) => [
    `
      <li class="workspace-row" data-filter-text="${escapeHtml(`${workspace.name} ${workspace.repoCount}`)}">
        <div>
          <strong>${escapeHtml(workspace.name)}</strong>
          <span>${workspace.repoCount} repos · ${workspace.contracts.length} contracts · ${workspace.links.length} links</span>
        </div>
      </li>
    `,
    ...workspace.links.slice(0, 24).map((link) => `
      <li class="workspace-link-row" data-filter-text="${escapeHtml(`${workspace.name} ${link.kind} ${link.sourceService} ${link.targetService} ${link.routeLabel ?? ''} ${link.eventTopology?.pattern ?? ''}`)}">
        <div>
          <strong>${escapeHtml(link.sourceService)} → ${escapeHtml(link.targetService)}</strong>
          <span>${escapeHtml(link.kind)}${link.routeLabel ? ` · ${escapeHtml(link.routeLabel)}` : ''}${link.eventTopology ? ` · ${escapeHtml(link.eventTopology.pattern)}` : ''}</span>
          ${link.consumerPath ? `<small>${escapeHtml(link.consumerPath)}</small>` : ''}
        </div>
        ${link.eventTopology ? `<span class="badge">${escapeHtml(link.eventTopology.providerAction)} → ${escapeHtml(link.eventTopology.counterpartyRole)}</span>` : `<span class="badge confidence-${escapeHtml(link.confidence)}">${escapeHtml(link.confidence)}</span>`}
      </li>
    `),
    ...workspace.contracts.slice(0, 12).map((contract) => `
      <li class="workspace-contract-row" data-filter-text="${escapeHtml(`${workspace.name} ${contract.serviceName} ${contract.path} ${contract.kind}`)}">
        <div>
          <strong>${escapeHtml(contract.serviceName)} · ${escapeHtml(contract.path)}</strong>
          <span>${escapeHtml(contract.kind)} · endpoints ${contract.endpointCount} · index ${contract.indexRunId}</span>
        </div>
      </li>
    `)
  ]).join('');
  const dataJson = JSON.stringify(snapshot).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ef;
      --panel: #fffdf8;
      --ink: #1f2320;
      --muted: #6b6f68;
      --line: #d9d5ca;
      --green: #2f7d5c;
      --amber: #a86b18;
      --red: #b23b3b;
      --teal: #26747a;
      --graph: #344b3f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, select { font: inherit; letter-spacing: 0; }
    .topbar {
      min-height: 64px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      padding: 12px 18px;
      border-bottom: 1px solid var(--line);
      background: #fbfaf6;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .title h1 { margin: 0; font-size: 20px; line-height: 1.2; }
    .title p { margin: 4px 0 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .toolbar input, .toolbar select {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: white;
      padding: 0 10px;
      max-width: min(360px, 100%);
    }
    .shell { width: min(1480px, 100%); margin: 0 auto; padding: 16px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 12px; min-height: 76px; }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 8px; font-size: 22px; line-height: 1; }
    .workbench {
      display: grid;
      grid-template-columns: minmax(220px, 0.9fr) minmax(300px, 1.25fr) minmax(320px, 1.2fr);
      gap: 12px;
      align-items: start;
    }
    .panel { min-width: 0; overflow: hidden; }
    .panel h2 {
      margin: 0;
      padding: 12px;
      font-size: 14px;
      border-bottom: 1px solid var(--line);
      background: #fdfaf2;
    }
    .list { list-style: none; margin: 0; padding: 0; max-height: 520px; overflow: auto; }
    .entity-row, .impact-row, .evidence-row, .action-row, .pack-row, .coverage-row, .work-artifact-row, .workspace-row, .workspace-link-row, .workspace-contract-row, .finding {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      min-width: 0;
    }
    .entity-row, .action-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; }
    .impact-row, .workspace-link-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .impact-row strong, .pack-row strong, .coverage-row strong, .work-artifact-row strong, .workspace-row strong, .workspace-link-row strong, .workspace-contract-row strong { display: block; overflow-wrap: anywhere; }
    .impact-row span, .pack-row span, .coverage-row span, .work-artifact-row span, .work-artifact-row small, .workspace-row span, .workspace-link-row span, .workspace-link-row small, .workspace-contract-row span, .evidence-meta span { color: var(--muted); font-size: 12px; }
    .kind, .badge {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      white-space: nowrap;
      background: #f8f5ee;
    }
    .confidence-proven { color: var(--green); border-color: #8ab9a4; }
    .confidence-inferred { color: var(--teal); border-color: #8bb8bc; }
    .confidence-heuristic { color: var(--amber); border-color: #d6b47a; }
    .confidence-low { color: var(--red); border-color: #d9a0a0; }
    pre {
      margin: 8px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
      color: #2d332e;
    }
    code { font-size: 12px; overflow-wrap: anywhere; color: var(--graph); }
    .bottom {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 0.8fr);
      gap: 12px;
      margin-top: 12px;
    }
    .wide-panel { margin-top: 12px; }
    .graph-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      gap: 0;
    }
    .graph-list { list-style: none; margin: 0; padding: 0; max-height: 300px; overflow: auto; }
    .graph-list li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); align-items: center; }
    .graph-list li span, .graph-list li small { overflow-wrap: anywhere; }
    .edge-list li { grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); }
    .node-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--teal); }
    .node-dot.changed { background: var(--green); }
    .node-dot.affected { background: var(--amber); }
    .finding { display: grid; gap: 4px; }
    .finding-error strong { color: var(--red); }
    .finding-warn strong { color: var(--amber); }
    .finding-info strong { color: var(--teal); }
    .empty { padding: 18px; color: var(--muted); }
    .hidden { display: none !important; }
    @media (max-width: 980px) {
      .topbar { grid-template-columns: 1fr; }
      .toolbar { justify-content: stretch; }
      .toolbar input, .toolbar select { width: 100%; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .workbench, .bottom, .graph-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .shell { padding: 10px; }
      .metrics { grid-template-columns: 1fr; }
      .impact-row, .workspace-link-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="title">
      <h1>Impact Workbench</h1>
      <p>${escapeHtml(snapshot.repoRoot)} · schema ${escapeHtml(String(doctor.database.schemaVersion ?? 'missing'))} · generated ${escapeHtml(snapshot.generatedAt)}</p>
    </div>
    <div class="toolbar" aria-label="Workbench controls">
      <select id="reportSelect" aria-label="Report selector">${reportOptions || '<option value="">No reports</option>'}</select>
      <input id="filterInput" type="search" placeholder="Filter paths, evidence, actions" aria-label="Filter workbench rows">
    </div>
  </header>
  <main class="shell">
    <section class="metrics" aria-label="Repository and report metrics">
      <div class="metric"><span>Index status</span><strong>${escapeHtml(doctor.index.latestCompletedRun?.status ?? 'missing')}</strong></div>
      <div class="metric"><span>Changed</span><strong>${escapeHtml(String(report?.changedCount ?? 0))}</strong></div>
      <div class="metric"><span>Affected</span><strong>${escapeHtml(String(report?.affectedCount ?? 0))}</strong></div>
      <div class="metric"><span>Evidence</span><strong>${escapeHtml(String(report?.evidenceCount ?? 0))}</strong></div>
      <div class="metric"><span>Actions</span><strong>${escapeHtml(String(report?.actionCount ?? 0))}</strong></div>
      <div class="metric"><span>Coverage gaps</span><strong>${escapeHtml(String(doctor.index.coverage?.skippedPaths ?? 0))}</strong></div>
      <div class="metric"><span>Work artifacts</span><strong>${escapeHtml(String(snapshot.workArtifacts.length))}</strong></div>
      <div class="metric"><span>Workspaces</span><strong>${escapeHtml(String(snapshot.workspaces.length))}</strong></div>
    </section>
    <section class="workbench" aria-label="Impact report workbench">
      <section class="panel">
        <h2>Change Set</h2>
        <ul class="list filterable">${changedRows || '<li class="empty">Run impact-trace analyze to create a report.</li>'}</ul>
      </section>
      <section class="panel">
        <h2>Impact Paths</h2>
        <ul class="list filterable">${affectedRows || '<li class="empty">No affected paths in the selected report.</li>'}</ul>
      </section>
      <section class="panel">
        <h2>Evidence</h2>
        <ul class="list filterable">${evidenceRows || '<li class="empty">No evidence in the selected report.</li>'}</ul>
      </section>
    </section>
    <section class="panel wide-panel">
      <h2>Work Artifacts</h2>
      <ul class="list filterable">${workArtifactRows || '<li class="empty">No policy, decision, PRD, requirement, or proposal impact in the selected report.</li>'}</ul>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>Focused Graph</h2>
        <div class="graph-grid">
          <ul class="graph-list">${graphNodes || '<li class="empty">No graph nodes available.</li>'}</ul>
          <ul class="graph-list edge-list">${graphEdges || '<li class="empty">No graph edges available.</li>'}</ul>
        </div>
      </section>
      <section class="panel">
        <h2>Verification Queue</h2>
        <ul class="list">${actionRows || '<li class="empty">No recommended actions in this report.</li>'}</ul>
      </section>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>Doctor Findings</h2>
        <ul class="list">${errors}${findings || (!errors ? '<li class="empty">No doctor findings.</li>' : '')}</ul>
      </section>
      <section class="panel">
        <h2>Context Packs</h2>
        <ul class="list">${contextPackRows || '<li class="empty">No reusable context packs yet.</li>'}</ul>
      </section>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>Workspace Contracts</h2>
        <ul class="list filterable">${workspaceRows || '<li class="empty">No workspace contract links available.</li>'}</ul>
      </section>
      <section class="panel">
        <h2>Workspace Resources</h2>
        <ul class="list">
          ${snapshot.workspaces.map((workspace) => `
            <li class="pack-row">
              <strong>${escapeHtml(workspace.name)}</strong>
              <span>${escapeHtml(workspace.resources.workspace)} · ${escapeHtml(workspace.resources.contracts)} · ${escapeHtml(workspace.resources.crossRepoLinks)}</span>
            </li>
          `).join('') || '<li class="empty">No workspace resources available.</li>'}
        </ul>
      </section>
    </section>
    <section class="bottom">
      <section class="panel">
        <h2>Coverage Gaps</h2>
        <ul class="list">${coverageRows || '<li class="empty">No coverage rows available.</li>'}</ul>
      </section>
      <section class="panel">
        <h2>Resource Contract</h2>
        <ul class="list">
          <li class="pack-row"><strong>/api/bootstrap</strong><span>DoctorReport, reports, selected report, graph, coverage, context packs</span></li>
          <li class="pack-row"><strong>/api/reports/{id}</strong><span>Persisted ImpactReport JSON shape</span></li>
          <li class="pack-row"><strong>/api/reports/{id}/graph/json</strong><span>GraphExport JSON shape with limit/cursor pagination</span></li>
          <li class="pack-row"><strong>/api/coverage/latest</strong><span>Coverage resource shape</span></li>
          <li class="pack-row"><strong>/api/context-packs/{id}</strong><span>Persisted context pack resource shape</span></li>
          <li class="pack-row"><strong>bootstrap.workArtifacts</strong><span>Policy, decision, PRD, requirement, and proposal impact preview shape</span></li>
          <li class="pack-row"><strong>/api/workspaces/{name}</strong><span>Workspace contracts and cross-repo link preview shape</span></li>
        </ul>
      </section>
    </section>
  </main>
  <script id="impact-data" type="application/json">${dataJson}</script>
  <script>
    const input = document.getElementById('filterInput');
    input?.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      for (const row of document.querySelectorAll('.filterable > li')) {
        const text = (row.getAttribute('data-filter-text') || row.textContent || '').toLowerCase();
        row.classList.toggle('hidden', query.length > 0 && !text.includes(query));
      }
    });
    document.getElementById('reportSelect')?.addEventListener('change', (event) => {
      const value = event.target.value;
      if (value) window.location.href = '/?report=' + encodeURIComponent(value);
    });
  </script>
</body>
</html>`;
}

export async function startUiServer(options: UiServerOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const preferredPort = options.port ?? 3717;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname === '/healthz') {
        response.writeHead(200, jsonHeaders());
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      const reportId = url.searchParams.get('report') ?? options.reportId;
      const snapshot = await buildUiSnapshot({ repoRoot: options.repoRoot, ...(reportId ? { reportId } : {}) });
      if (url.pathname === '/data.json' || url.pathname === '/api/bootstrap') {
        response.writeHead(200, jsonHeaders());
        response.end(JSON.stringify(snapshot));
        return;
      }
      const apiResponse = await uiApiResponse(options.repoRoot, url);
      if (apiResponse !== null) {
        response.writeHead(200, jsonHeaders());
        response.end(JSON.stringify(apiResponse));
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, htmlHeaders());
        response.end(renderUiHtml(snapshot));
        return;
      }
      response.writeHead(404, textHeaders());
      response.end('not found');
    } catch (error) {
      response.writeHead(500, jsonHeaders());
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  const port = await listen(server, host, preferredPort, options.port === undefined);
  return {
    server,
    url: `http://${host}:${port}/`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function uiApiResponse(repoRootInput: string, url: URL): Promise<unknown | null> {
  const repoRoot = normalizeRepoRoot(repoRootInput);
  if (!existsSync(databasePath(repoRoot))) return null;
  const reportMatch = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
  if (reportMatch) {
    return readReport(repoRoot, decodeURIComponent(reportMatch[1]!));
  }
  const graphMatch = /^\/api\/reports\/([^/]+)\/graph\/json$/.exec(url.pathname);
  if (graphMatch) {
    const graph = await exportImpactGraph({
      repoRoot,
      reportId: decodeURIComponent(graphMatch[1]!),
      format: 'json'
    });
    const limit = parseGraphPageLimit(url.searchParams.get('limit'));
    const cursorRaw = url.searchParams.get('cursor');
    const cursor = parseGraphPageCursor(cursorRaw);
    validateGraphPageCursor(cursor, graph);
    const nodes = graph.nodes.slice(cursor.nodeOffset, cursor.nodeOffset + limit);
    const edges = graph.edges.slice(cursor.edgeOffset, cursor.edgeOffset + limit);
    const nextNodeOffset = cursor.nodeOffset + nodes.length;
    const nextEdgeOffset = cursor.edgeOffset + edges.length;
    const nextCursor =
      nextNodeOffset < graph.nodes.length || nextEdgeOffset < graph.edges.length
        ? `${nextNodeOffset}:${nextEdgeOffset}`
        : null;
    return {
      reportId: graph.reportId,
      indexRunId: graph.indexRunId,
      format: graph.format,
      nodes,
      edges,
      page: {
        cursor: cursorRaw,
        nextCursor,
        limit,
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
        returnedNodes: nodes.length,
        returnedEdges: edges.length
      }
    };
  }
  if (url.pathname === '/api/coverage/latest') {
    const db = openDatabase(repoRoot, { readOnly: true });
    try {
      return readLatestCoverage(db, getRepoId(db, repoRoot));
    } finally {
      db.close();
    }
  }
  const packMatch = /^\/api\/context-packs\/([^/]+)$/.exec(url.pathname);
  if (packMatch) {
    return readContextPack(repoRoot, decodeURIComponent(packMatch[1]!));
  }
  const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(url.pathname);
  if (workspaceMatch) {
    return readWorkspace(repoRoot, decodeURIComponent(workspaceMatch[1]!));
  }
  return null;
}

function reportSummaryFromRow(row: ReportRow): UiReportSummary {
  const report = JSON.parse(row.json) as ImpactReport;
  return {
    id: row.id,
    indexRunId: row.index_run_id,
    createdAt: row.created_at,
    changedFiles: report.changedFiles,
    changedCount: report.changed.length,
    affectedCount: report.affectedFiles.length,
    evidenceCount: report.evidence.length,
    actionCount: report.actions.length
  };
}

function reportPreviewFromRow(row: ReportRow): UiReportPreview {
  const report = JSON.parse(row.json) as ImpactReport;
  return {
    ...reportSummaryFromRow(row),
    changed: report.changed,
    affectedFiles: report.affectedFiles,
    evidence: evidencePreviewFromReport(report),
    actions: report.actions,
    warnings: report.warnings ?? []
  };
}

const workArtifactKinds = new Set(['policy', 'proposal', 'prd', 'decision', 'business_plan', 'requirement', 'meeting_note', 'customer_artifact']);
const omittedWorkArtifactEvidenceSnippet = 'Work artifact evidence omitted from UI bootstrap. Open the entity resource for document details.';

function evidencePreviewFromReport(report: ImpactReport): UiEvidencePreview[] {
  const workArtifactPaths = workArtifactPathSet(report);
  return report.evidence.map((item) => {
    const resourceUri = workArtifactEvidenceResourceUri(item, workArtifactPaths);
    if (!resourceUri) return item;
    return {
      ...item,
      snippet: omittedWorkArtifactEvidenceSnippet,
      snippetOmitted: true,
      omittedReason: 'work-artifact-resource-on-demand',
      resourceUri
    };
  });
}

function workArtifactsFromReportRow(row: ReportRow): UiWorkArtifactImpact[] {
  const report = JSON.parse(row.json) as ImpactReport;
  const affectedByPath = new Map(report.affectedFiles.map((item) => [item.path, item]));
  const byKey = new Map<string, UiWorkArtifactImpact>();
  for (const item of report.affected) {
    const targetPath = item.target.path;
    if (!targetPath || !workArtifactKinds.has(item.target.kind)) continue;
    const affectedFile = affectedByPath.get(targetPath);
    const key = `${item.target.kind}:${targetPath}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      kind: item.target.kind,
      path: targetPath,
      displayName: item.target.displayName ?? targetPath,
      reason: affectedFile?.reason ?? item.relations.join(' -> '),
      confidence: affectedFile?.confidence ?? item.confidence,
      relations: item.relations,
      resourceUri: entityResourceUri(item.target),
      ...(affectedFile?.depth !== undefined ? { depth: affectedFile.depth } : {})
    });
  }
  return [...byKey.values()].sort(compareWorkArtifacts);
}

function workArtifactPathSet(report: ImpactReport): Set<string> {
  return new Set(
    report.affected
      .map((item) => item.target)
      .filter((target) => target.path && workArtifactKinds.has(target.kind))
      .map((target) => target.path!)
  );
}

function workArtifactEvidenceResourceUri(
  evidence: ImpactReport['evidence'][number],
  workArtifactPaths: ReadonlySet<string>
): string | undefined {
  if (evidence.subject && workArtifactKinds.has(evidence.subject.kind)) {
    return entityResourceUri(evidence.subject);
  }
  if (evidence.subject?.path && workArtifactPaths.has(evidence.subject.path)) {
    return entityResourceUri(evidence.subject);
  }
  if (workArtifactPaths.has(evidence.file)) {
    return `impact-trace://entities/${encodeURIComponent(`file:${evidence.file}`)}`;
  }
  return undefined;
}

function compareWorkArtifacts(left: UiWorkArtifactImpact, right: UiWorkArtifactImpact): number {
  return workArtifactKindRank(left.kind) - workArtifactKindRank(right.kind)
    || (left.depth ?? 99) - (right.depth ?? 99)
    || left.path.localeCompare(right.path);
}

function workArtifactKindRank(kind: string): number {
  if (kind === 'policy') return 0;
  if (kind === 'decision') return 1;
  if (kind === 'prd' || kind === 'requirement') return 2;
  if (kind === 'proposal') return 3;
  return 4;
}

async function graphPreview(repoRoot: string, reportId: string): Promise<UiGraphPreview | null> {
  try {
    const graph = await exportImpactGraph({ repoRoot, reportId, format: 'json' });
    return {
      nodes: graph.nodes.slice(0, 80),
      edges: graph.edges.slice(0, 80),
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length
    };
  } catch {
    return null;
  }
}

function readContextPacks(db: ReturnType<typeof openDatabase>, repoId: number): UiContextPackSummary[] {
  if (!tableExists(db, 'context_packs')) return [];
  const rows = db
    .prepare(`
      SELECT id, budget, index_run_id, returned_bytes, hit_count, created_at, last_accessed_at
      FROM context_packs
      WHERE repo_id = ?
      ORDER BY last_accessed_at DESC, created_at DESC
      LIMIT 20
    `)
    .all(repoId) as ContextPackRow[];
  return rows.map((row) => ({
    id: row.id,
    budget: row.budget,
    indexRunId: row.index_run_id,
    returnedBytes: row.returned_bytes,
    hitCount: row.hit_count,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at
  }));
}

function readReport(repoRoot: string, reportId: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const row = db
      .prepare('SELECT json FROM reports WHERE repo_id = ? AND id = ?')
      .get(repoId, reportId) as { json: string } | undefined;
    if (!row) return { error: { code: 'report_not_found', message: `Impact report not found: ${reportId}` } };
    return JSON.parse(row.json) as unknown;
  } finally {
    db.close();
  }
}

function readContextPack(repoRoot: string, contextPackId: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const row = tableExists(db, 'context_packs')
      ? db
          .prepare('SELECT pack_json FROM context_packs WHERE repo_id = ? AND id = ?')
          .get(repoId, contextPackId) as { pack_json: string } | undefined
      : undefined;
    if (!row) return { error: { code: 'context_pack_not_found', message: `Context pack not found: ${contextPackId}` } };
    return JSON.parse(row.pack_json) as unknown;
  } finally {
    db.close();
  }
}

function readLatestCoverage(db: ReturnType<typeof openDatabase>, repoId: number): UiCoverageSnapshot | null {
  const run = db
    .prepare("SELECT id FROM index_runs WHERE repo_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1")
    .get(repoId) as { id: number } | undefined;
  if (!run || !tableExists(db, 'index_coverage')) return null;
  const limit = 80;
  const rows = db
    .prepare(`
      SELECT path, language_id, status, reason, adapter_id
      FROM index_coverage
      WHERE index_run_id = ?
      ORDER BY status DESC, path
      LIMIT ?
    `)
    .all(run.id, limit + 1) as Array<{
      path: string;
      language_id: string | null;
      status: string;
      reason: string;
      adapter_id: string;
    }>;
  return {
    indexRunId: run.id,
    coverage: rows.slice(0, limit).map((row) => ({
      path: row.path,
      languageId: row.language_id,
      status: row.status,
      reason: row.reason,
      adapterId: row.adapter_id
    })),
    limit,
    truncated: rows.length > limit
  };
}

function readWorkspace(repoRoot: string, workspaceName: string): unknown {
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const workspace = readWorkspaceSnapshots(db).find((item) => item.name === workspaceName);
    if (!workspace) {
      return { error: { code: 'workspace_not_found', message: `Workspace not found: ${workspaceName}` } };
    }
    return workspace;
  } finally {
    db.close();
  }
}

function readWorkspaceSnapshots(db: ReturnType<typeof openDatabase>): UiWorkspaceSnapshot[] {
  if (!tableExists(db, 'workspaces') || !tableExists(db, 'workspace_repos')) return [];
  const rows = db
    .prepare('SELECT id, name FROM workspaces ORDER BY name')
    .all() as WorkspaceRow[];
  return rows.map((workspace) => {
    const warnings: string[] = [];
    const repos = readWorkspaceReposForUi(db, workspace.id);
    const contractResult = readWorkspaceContractsForUi(workspace.name, repos, warnings);
    const linkResult = readWorkspaceLinksForUi(db, workspace.id);
    return {
      name: workspace.name,
      repoCount: repos.length,
      contracts: contractResult.contracts,
      links: linkResult.links,
      warnings,
      resources: workspaceResources(workspace.name),
      limits: {
        contracts: contractResult.limit,
        links: linkResult.limit,
        contractsTruncated: contractResult.truncated,
        linksTruncated: linkResult.truncated
      }
    };
  });
}

function readWorkspaceReposForUi(db: ReturnType<typeof openDatabase>, workspaceId: number): WorkspaceRepoRow[] {
  return db
    .prepare(`
      SELECT local_path, service_name
      FROM workspace_repos
      WHERE workspace_id = ?
      ORDER BY local_path
    `)
    .all(workspaceId) as WorkspaceRepoRow[];
}

function readWorkspaceContractsForUi(
  workspaceName: string,
  repos: WorkspaceRepoRow[],
  warnings: string[]
): { contracts: UiWorkspaceContract[]; limit: number; truncated: boolean } {
  const limit = 80;
  const contracts: UiWorkspaceContract[] = [];
  let truncated = false;
  for (const repo of repos) {
    if (contracts.length >= limit) {
      truncated = true;
      break;
    }
    let repoDb: ReturnType<typeof openDatabase> | undefined;
    try {
      repoDb = openDatabase(repo.local_path, { readOnly: true });
      const repoId = getRepoId(repoDb, repo.local_path);
      const indexRunId = latestCompletedIndexRun(repoDb, repoId);
      const remaining = limit - contracts.length;
      const rows = repoDb
        .prepare(`
          SELECT
            c.id,
            c.kind,
            c.service_name,
            c.path,
            v.schema_version,
            (
              SELECT count(*)
              FROM relations r
              INNER JOIN entities target
                 ON target.id = r.target_entity_id
                AND target.repo_id = r.repo_id
              WHERE r.repo_id = c.repo_id
                AND r.index_run_id = ?
                AND r.source_entity_id = c.id
                AND r.kind = 'DECLARES'
                AND target.kind = 'endpoint'
            ) AS endpoint_count
          FROM contracts c
          INNER JOIN contract_versions v
             ON v.contract_id = c.id
            AND v.index_run_id = ?
          WHERE c.repo_id = ?
          ORDER BY COALESCE(c.service_name, ''), c.path, c.id
          LIMIT ?
        `)
        .all(indexRunId, indexRunId, repoId, remaining + 1) as WorkspaceContractRow[];
      if (rows.length > remaining) truncated = true;
      contracts.push(...rows.slice(0, remaining).map((row) => ({
        id: row.id,
        serviceName: row.service_name ?? repo.service_name ?? repo.local_path,
        repoPath: repo.local_path,
        path: row.path ?? row.id,
        kind: row.kind,
        indexRunId,
        endpointCount: row.endpoint_count,
        ...(row.schema_version !== null ? { schemaVersion: row.schema_version } : {})
      })));
    } catch (error) {
      warnings.push(`workspace contract repo skipped: ${workspaceName}:${repo.local_path}: ${errorMessage(error)}`);
    } finally {
      repoDb?.close();
    }
  }
  return { contracts, limit, truncated };
}

function readWorkspaceLinksForUi(
  db: ReturnType<typeof openDatabase>,
  workspaceId: number
): { links: UiWorkspaceLink[]; limit: number; truncated: boolean } {
  const limit = 120;
  if (!tableExists(db, 'cross_repo_links')) return { links: [], limit, truncated: false };
  const rows = db
    .prepare(`
      SELECT
        link.id,
        link.kind,
        link.confidence,
        link.provenance,
        source_member.local_path AS source_path,
        source_member.service_name AS source_service,
        target_member.local_path AS target_path,
        target_member.service_name AS target_service
      FROM cross_repo_links link
      INNER JOIN workspace_repos source_member
         ON source_member.workspace_id = link.workspace_id
        AND source_member.repo_id = link.source_repo_id
      INNER JOIN workspace_repos target_member
         ON target_member.workspace_id = link.workspace_id
        AND target_member.repo_id = link.target_repo_id
      WHERE link.workspace_id = ?
      ORDER BY link.kind, source_member.service_name, target_member.service_name, link.id
      LIMIT ?
    `)
    .all(workspaceId, limit + 1) as WorkspaceLinkRow[];
  return {
    links: rows.slice(0, limit).map((row) => {
      const provenance = parsedProvenance(row.provenance);
      const routeLabel = routeLabelFromProvenance(provenance);
      const consumerPath =
        stringAt(objectAt(provenance, 'consumer'), 'path')
        ?? stringAt(objectAt(provenance, 'evidence'), 'filePath');
      const providerContractPath = stringAt(objectAt(provenance, 'provider'), 'contractPath');
      const eventTopology = eventTopologyFromProvenance(provenance);
      return {
        id: row.id,
        kind: row.kind,
        confidence: row.confidence,
        sourceService: row.source_service ?? row.source_path,
        targetService: row.target_service ?? row.target_path,
        ...(routeLabel !== undefined ? { routeLabel } : {}),
        ...(consumerPath !== undefined ? { consumerPath } : {}),
        ...(providerContractPath !== undefined ? { providerContractPath } : {}),
        ...(eventTopology !== undefined ? { eventTopology } : {})
      };
    }),
    limit,
    truncated: rows.length > limit
  };
}

function workspaceResourceUri(workspaceName: string): string {
  return `impact-trace://workspaces/${encodeURIComponent(workspaceName)}`;
}

function entityResourceUri(entity: ImpactReport['changed'][number]): string {
  return `impact-trace://entities/${encodeURIComponent(entity.id)}`;
}

function workspaceResources(workspaceName: string): UiWorkspaceSnapshot['resources'] {
  const workspace = workspaceResourceUri(workspaceName);
  return {
    workspace,
    contracts: `${workspace}/contracts`,
    crossRepoLinks: `${workspace}/cross-repo-links`
  };
}

function parsedProvenance(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function routeLabelFromProvenance(provenance: unknown): string | undefined {
  const http = objectAt(provenance, 'http');
  const method = stringAt(http, 'method');
  const routePath = stringAt(http, 'path');
  if (method && routePath) return `${method} ${routePath}`;

  const change = objectAt(provenance, 'change');
  const changeMethod = stringAt(change, 'method');
  const changePath = stringAt(change, 'path');
  if (changeMethod && changePath) return `${changeMethod} ${changePath}`;
  return routePath ?? changePath;
}

function eventTopologyFromProvenance(provenance: unknown): UiWorkspaceLink['eventTopology'] | undefined {
  const topology = objectAt(provenance, 'eventTopology');
  const providerAction = stringAt(topology, 'providerAction');
  const counterpartyRole = stringAt(topology, 'counterpartyRole');
  const pattern = stringAt(topology, 'pattern');
  if (!providerAction || !pattern) return undefined;
  if (counterpartyRole !== 'consumer' && counterpartyRole !== 'producer' && counterpartyRole !== 'unknown') {
    return undefined;
  }
  return { providerAction, counterpartyRole, pattern };
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'string' && child.length > 0 ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function tableExists(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function parseGraphPageLimit(value: string | null): number {
  if (value === null) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('graph page limit must be an integer between 1 and 500');
  }
  return limit;
}

function parseGraphPageCursor(value: string | null): GraphPageCursor {
  if (value === null) return { nodeOffset: 0, edgeOffset: 0 };
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) throw new Error('graph page cursor must be returned by a previous graph JSON page');
  return {
    nodeOffset: parseGraphCursorOffset(match[1]!, 'node'),
    edgeOffset: parseGraphCursorOffset(match[2]!, 'edge')
  };
}

function parseGraphCursorOffset(value: string, label: 'node' | 'edge'): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`graph page cursor ${label} offset must be a safe non-negative integer`);
  }
  return offset;
}

function validateGraphPageCursor(cursor: GraphPageCursor, graph: GraphExport): void {
  if (cursor.nodeOffset > graph.nodes.length || cursor.edgeOffset > graph.edges.length) {
    throw new Error('graph page cursor is outside the current graph bounds');
  }
}

function jsonHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
}

function htmlHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  };
}

function textHeaders(): Record<string, string> {
  return {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
}

function listen(server: Server, host: string, port: number, allowFallback: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (allowFallback && error.code === 'EADDRINUSE' && port !== 0) {
        server.listen(0, host);
        server.once('listening', onListening);
        server.once('error', reject);
        return;
      }
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

import { asConfidence } from './confidence.js';
import { entityKindForPath } from './entity_classification.js';
import { getRepoId, openDatabase } from './store.js';
import { normalizeRepoRoot } from './security.js';
import type {
  Confidence,
  EntityRef,
  EntityKind,
  GraphEdge,
  GraphExport,
  GraphExportOptions,
  GraphNode,
  ImpactReport
} from './types.js';

type ReportRow = {
  id: string;
  index_run_id: number;
  json: string;
};

type CanonicalGraphRow = {
  relation_id: string;
  relation_kind: string;
  confidence: string;
  source_id: string;
  source_kind: string;
  source_path: string | null;
  source_display_name: string;
  target_id: string;
  target_kind: string;
  target_path: string | null;
  target_display_name: string;
};

type LegacyGraphRow = {
  edge_id: number;
  kind: string;
  confidence: string;
  source_path: string;
  target_path: string;
};

type ReportEvidenceEdge = {
  id: string;
  source: EntityRef;
  target: EntityRef;
  kind: string;
  confidence: Confidence;
};

export async function exportImpactGraph(options: GraphExportOptions): Promise<GraphExport> {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const db = openDatabase(repoRoot, { readOnly: true });
  try {
    const repoId = getRepoId(db, repoRoot);
    const reportRow = db
      .prepare('SELECT id, index_run_id, json FROM reports WHERE repo_id = ? AND id = ?')
      .get(repoId, options.reportId) as ReportRow | undefined;
    if (!reportRow) {
      throw new Error(`impact report not found: ${options.reportId}`);
    }

    const report = JSON.parse(reportRow.json) as ImpactReport;
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    for (const changed of report.changed) {
      nodes.set(changed.id, {
        id: changed.id,
        label: changed.displayName ?? changed.path ?? changed.id,
        kind: changed.kind,
        ...(changed.path ? { path: changed.path } : {}),
        group: 'changed'
      });
    }

    for (const affected of report.affected) {
      nodes.set(affected.target.id, {
        id: affected.target.id,
        label: affected.target.displayName ?? affected.target.path ?? affected.target.id,
        kind: affected.target.kind,
        ...(affected.target.path ? { path: affected.target.path } : {}),
        group: 'affected',
        confidence: affected.confidence
      });
    }

    const changedEntityIds = new Set(report.changed.map((entity) => entity.id));
    const affectedEntityIds = new Set(report.affected.map((item) => item.target.id));
    const graphScopeEntityIds = [...new Set([...changedEntityIds, ...affectedEntityIds])];
    const canonicalRows = loadCanonicalRows(db, repoId, report.indexRunId, graphScopeEntityIds);
    const edgeSignatures = new Set<string>();
    if (canonicalRows.length > 0) {
      for (const row of canonicalRows) {
        upsertRowNode(nodes, row.source_id, row.source_kind, row.source_display_name, row.source_path, 'affected', asConfidence(row.confidence));
        upsertRowNode(
          nodes,
          row.target_id,
          row.target_kind,
          row.target_display_name,
          row.target_path,
          changedEntityIds.has(row.target_id) ? 'changed' : affectedEntityIds.has(row.target_id) ? 'affected' : 'context',
          asConfidence(row.confidence)
        );
        edges.set(row.relation_id, {
          id: row.relation_id,
          source: row.source_id,
          target: row.target_id,
          kind: row.relation_kind,
          confidence: asConfidence(row.confidence),
          label: row.relation_kind
        });
        edgeSignatures.add(edgeSignature(row.source_id, row.relation_kind, row.target_id));
      }
    }

    for (const edge of buildReportEvidenceEdges(report)) {
      const signature = edgeSignature(edge.source.id, edge.kind, edge.target.id);
      if (edgeSignatures.has(signature)) continue;
      upsertReportNode(
        nodes,
        edge.source,
        changedEntityIds.has(edge.source.id) ? 'changed' : affectedEntityIds.has(edge.source.id) ? 'affected' : 'context',
        edge.confidence
      );
      upsertReportNode(
        nodes,
        edge.target,
        changedEntityIds.has(edge.target.id) ? 'changed' : affectedEntityIds.has(edge.target.id) ? 'affected' : 'context',
        edge.confidence
      );
      edges.set(edge.id, {
        id: edge.id,
        source: edge.source.id,
        target: edge.target.id,
        kind: edge.kind,
        confidence: edge.confidence,
        label: edge.kind
      });
      edgeSignatures.add(signature);
    }

    if (canonicalRows.length === 0 && edges.size === 0) {
      for (const row of loadLegacyRows(db, repoId, report.indexRunId, report.changedFiles)) {
        const sourceId = `file:${row.source_path}`;
        const targetId = `file:${row.target_path}`;
        upsertRowNode(nodes, sourceId, entityKindForPath(row.source_path), row.source_path, row.source_path, 'affected', asConfidence(row.confidence));
        upsertRowNode(nodes, targetId, entityKindForPath(row.target_path), row.target_path, row.target_path, 'changed', asConfidence(row.confidence));
        edges.set(`legacy:${row.edge_id}`, {
          id: `legacy:${row.edge_id}`,
          source: sourceId,
          target: targetId,
          kind: row.kind,
          confidence: asConfidence(row.confidence),
          label: row.kind
        });
      }
    }

    const graphNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const graphEdges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
    const graph = {
      reportId: report.id,
      indexRunId: report.indexRunId,
      format: options.format,
      nodes: graphNodes,
      edges: graphEdges,
      rendered: ''
    };
    graph.rendered = renderGraph(options.format, graphNodes, graphEdges, graph);
    return graph;
  } finally {
    db.close();
  }
}

function buildReportEvidenceEdges(report: ImpactReport): ReportEvidenceEdge[] {
  const entities = [
    ...report.changed,
    ...report.affected.map((item) => item.target)
  ];
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const entityByLabel = new Map<string, EntityRef>();
  for (const entity of entities) {
    for (const label of labelsForEntity(entity)) {
      entityByLabel.set(label, entity);
    }
  }

  const edges = new Map<string, ReportEvidenceEdge>();
  for (const evidence of report.evidence) {
    if (!evidence.subject || !evidence.relationKind) continue;
    const source = entityById.get(evidence.subject.id) ?? evidence.subject;
    const target = targetFromReportRelations(report, source, evidence.relationKind, entityByLabel)
      ?? (report.changed.length === 1 ? report.changed[0] : undefined);
    if (!target || source.id === target.id) continue;

    const kind = evidence.relationKind;
    const confidence = asConfidence(evidence.relationConfidence ?? evidence.confidence);
    const id = `report-evidence:${evidence.id}:${source.id}:${kind}:${target.id}`;
    edges.set(id, { id, source, target, kind, confidence });
  }
  return [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function edgeSignature(sourceId: string, kind: string, targetId: string): string {
  return `${sourceId}\0${kind}\0${targetId}`;
}

function targetFromReportRelations(
  report: ImpactReport,
  source: EntityRef,
  relationKind: string,
  entityByLabel: Map<string, EntityRef>
): EntityRef | undefined {
  const affected = report.affected.find((item) => item.target.id === source.id);
  if (!affected) return undefined;
  const verb = relationVerb(relationKind);
  for (const relation of affected.relations) {
    for (const sourceLabel of labelsForEntity(source)) {
      const prefix = `${sourceLabel} ${verb} `;
      if (!relation.startsWith(prefix)) continue;
      const targetLabel = relation.slice(prefix.length);
      const target = entityByLabel.get(targetLabel);
      if (target) return target;
    }
  }
  return undefined;
}

function labelsForEntity(entity: EntityRef): string[] {
  return [...new Set([
    entity.displayName,
    entity.path,
    entity.id
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function relationVerb(kind: string): string {
  if (kind === 'DEPENDS_ON') return 'depends on';
  if (kind === 'VERIFIES') return 'verifies';
  if (kind === 'DOCUMENTS') return 'documents';
  if (kind === 'PROPOSES') return 'proposes';
  if (kind === 'REQUIRES') return 'requires';
  if (kind === 'CONFIGURES') return 'configures';
  if (kind === 'DEPLOYS') return 'deploys';
  if (kind === 'CALLS') return 'calls';
  if (kind === 'REFERENCES') return 'references';
  if (kind === 'CONSUMES') return 'consumes';
  if (kind === 'IMPLEMENTS') return 'implements';
  if (kind === 'PRODUCES') return 'produces';
  if (kind === 'CO_CHANGES') return 'co-changes with';
  return kind.toLowerCase();
}

function loadCanonicalRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  scopeEntityIds: string[]
): CanonicalGraphRow[] {
  if (scopeEntityIds.length === 0) return [];
  const placeholders = scopeEntityIds.map(() => '?').join(', ');
  return db
    .prepare(`
      SELECT
        r.id AS relation_id,
        r.kind AS relation_kind,
        r.confidence AS confidence,
        source.id AS source_id,
        source.kind AS source_kind,
        source.path AS source_path,
        source.display_name AS source_display_name,
        target.id AS target_id,
        target.kind AS target_kind,
        target.path AS target_path,
        target.display_name AS target_display_name
      FROM relations r
      JOIN entities source ON source.id = r.source_entity_id
      JOIN entities target ON target.id = r.target_entity_id
      WHERE r.repo_id = ?
        AND r.index_run_id = ?
        AND r.target_entity_id IN (${placeholders})
        AND r.source_entity_id IN (${placeholders})
        AND source.path IS NOT NULL
      ORDER BY source.display_name, target.display_name, r.kind
    `)
    .all(repoId, indexRunId, ...scopeEntityIds, ...scopeEntityIds) as CanonicalGraphRow[];
}

function loadLegacyRows(
  db: ReturnType<typeof openDatabase>,
  repoId: number,
  indexRunId: number,
  changedFiles: string[]
): LegacyGraphRow[] {
  if (changedFiles.length === 0) return [];
  const placeholders = changedFiles.map(() => '?').join(', ');
  return db
    .prepare(`
      SELECT
        e.id AS edge_id,
        e.kind AS kind,
        e.confidence AS confidence,
        f.path AS source_path,
        e.target_path AS target_path
      FROM edges e
      JOIN files f ON f.id = e.source_file_id
      WHERE e.repo_id = ?
        AND e.index_run_id = ?
        AND e.target_path IN (${placeholders})
      ORDER BY f.path, e.target_path, e.kind
    `)
    .all(repoId, indexRunId, ...changedFiles) as LegacyGraphRow[];
}

function upsertReportNode(
  nodes: Map<string, GraphNode>,
  entity: EntityRef,
  group: GraphNode['group'],
  confidence?: Confidence
): void {
  upsertRowNode(
    nodes,
    entity.id,
    entity.kind,
    entity.displayName ?? entity.path ?? entity.id,
    entity.path ?? null,
    group,
    confidence
  );
}

function upsertRowNode(
  nodes: Map<string, GraphNode>,
  id: string,
  kindValue: string,
  label: string,
  path: string | null,
  group: GraphNode['group'],
  confidence?: Confidence
): void {
  const existing = nodes.get(id);
  if (existing) {
    // Immutable upgrade: rebuild the node instead of mutating it in place.
    const upgradeGroup = existing.group !== 'changed' && group === 'changed';
    const addConfidence = !existing.confidence && confidence;
    if (upgradeGroup || addConfidence) {
      nodes.set(id, {
        ...existing,
        ...(upgradeGroup ? { group: 'changed' as const } : {}),
        ...(addConfidence ? { confidence } : {})
      });
    }
    return;
  }
  nodes.set(id, {
    id,
    label,
    kind: isEntityKind(kindValue) ? kindValue : 'file',
    ...(path ? { path } : {}),
    group,
    ...(confidence ? { confidence } : {})
  });
}

function renderMermaid(nodes: GraphNode[], edges: GraphEdge[]): string {
  const idByNode = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart LR'];
  for (const node of nodes) {
    lines.push(`  ${idByNode.get(node.id)}["${escapeMermaidLabel(node.label)}"]`);
  }
  for (const edge of edges) {
    const source = idByNode.get(edge.source);
    const target = idByNode.get(edge.target);
    if (!source || !target) continue;
    lines.push(`  ${source} -->|${escapeMermaidLabel(edge.label)}:${edge.confidence}| ${target}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderGraph(format: 'json' | 'mermaid' | 'dot', nodes: GraphNode[], edges: GraphEdge[], graph: Omit<GraphExport, 'rendered'>): string {
  if (format === 'json') return JSON.stringify({ ...graph, rendered: undefined }, null, 2);
  if (format === 'dot') return renderDot(nodes, edges);
  return renderMermaid(nodes, edges);
}

function renderDot(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines = [
    'digraph parallax {',
    '  rankdir=LR;',
    '  node [shape=box, style="rounded,filled", fontname="Helvetica"];'
  ];
  for (const node of nodes) {
    const fill = node.group === 'changed' ? '#fde68a' : node.group === 'affected' ? '#bfdbfe' : '#e5e7eb';
    lines.push(`  "${escapeDotId(node.id)}" [label="${escapeDotLabel(node.label)}", fillcolor="${fill}"];`);
  }
  for (const edge of edges) {
    lines.push(
      `  "${escapeDotId(edge.source)}" -> "${escapeDotId(edge.target)}" [label="${escapeDotLabel(`${edge.label}:${edge.confidence}`)}"];`
    );
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function escapeMermaidLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ');
}

function escapeDotId(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeDotLabel(value: string): string {
  return escapeDotId(value).replace(/\n/g, ' ').replace(/\r/g, ' ');
}

function isEntityKind(value: string): value is EntityKind {
  return [
    'file',
    'symbol',
    'module',
    'package',
    'test',
    'doc',
    'config',
    'policy',
    'proposal',
    'prd',
    'workflow',
    'resource',
    'endpoint',
    'contract',
    'event',
    'business_plan',
    'requirement',
    'decision',
    'meeting_note',
    'metric',
    'customer_artifact',
    'task',
    'external_entity'
  ].includes(value);
}

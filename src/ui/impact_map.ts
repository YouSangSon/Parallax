// Impact-map presentation cluster extracted from ui.ts. Builds the changed →
// affected map model and renders the SVG map panel plus its inspector. Functions
// moved verbatim. Type-only imports from ui.ts are erased at compile time, so
// there is no runtime import cycle; runtime helpers come from shared.ts.

import {
  actionByTargetPath,
  actionCommandText,
  classifyImpactLane,
  compareAffectedFilesForUi,
  entityLabel,
  escapeHtml,
  evidenceSourceLocation,
  impactEvidenceMatchesPath,
  shortenMiddle,
  type SourceLinkContext,
  topAffectedFilesForSummary
} from './shared.js';
import type { ImpactAction } from '../types.js';
import type {
  ImpactLane,
  ImpactLaneId,
  ImpactLaneTone,
  ImpactMapEdge,
  ImpactMapNode,
  UiEvidencePreview,
  UiGraphPreview,
  UiMessages,
  UiReportPreview
} from '../ui.js';

export function renderImpactMapPanel(
  graph: UiGraphPreview | null,
  report: UiReportPreview | null,
  m: UiMessages,
  sourceContext: SourceLinkContext = {}
): string {
  const map = buildImpactMap(graph, report);
  const firstImpact = report ? initialImpactForUi(report) : undefined;
  const displayedPathCount = map.edges.length;
  const totalAffectedCount = report?.affectedCount ?? map.affectedNodes.length;
  const chips = `
    <span>${map.changedNodes.length} ${escapeHtml(m.changed)}</span>
    <span>${totalAffectedCount} ${escapeHtml(m.totalAffected)}</span>
    <span>${displayedPathCount} ${escapeHtml(m.mappedPaths)}</span>
  `;
  if (map.changedNodes.length === 0 && map.affectedNodes.length === 0) {
    return `
      <section class="panel map-panel">
        <div class="panel-heading">
          <h2>${escapeHtml(m.impactMap)}</h2>
          <div class="panel-chips">${chips}</div>
        </div>
        <div class="empty">${escapeHtml(m.emptyNoGraphNodes)}</div>
      </section>
    `;
  }

  const selectedPath = firstImpact?.path;
  const svg = renderImpactMapSvg(map, selectedPath, m);
  const selectedAction = selectedPath && report ? actionByTargetPath(report.actions).get(selectedPath) : undefined;
  const insight = renderImpactMapInsight(map, totalAffectedCount, displayedPathCount, m, firstImpact?.path, selectedAction);
  const routeStrip = renderImpactRouteStrip(map, m, selectedPath);
  const edgeRows = map.edges.slice(0, 6).map((edge) => {
    const from = map.nodeById.get(edge.from);
    const to = map.nodeById.get(edge.to);
    const targetPath = edge.targetPath ?? to?.path;
    const edgeClasses = `map-legend-edge${targetPath ? ' selectable-impact' : ''}${targetPath === selectedPath ? ' selected-impact' : ''}`;
    const edgeAttrs = targetPath
      ? ` class="${escapeHtml(edgeClasses)}" tabindex="0" role="button" data-impact-path="${escapeHtml(targetPath)}" data-filter-text="${escapeHtml(`${from?.label ?? edge.from} ${edge.label} ${to?.label ?? edge.to}`)}"`
      : ` class="${escapeHtml(edgeClasses)}"`;
    return `
      <li${edgeAttrs}>
        <strong>${escapeHtml(from?.label ?? edge.from)}</strong>
        <span>${escapeHtml(edge.label)}</span>
        <strong>${escapeHtml(to?.label ?? edge.to)}</strong>
      </li>
    `;
  }).join('');

  return `
    <section class="panel map-panel">
      <div class="panel-heading">
        <h2>${escapeHtml(m.impactMap)}</h2>
        <div class="panel-chips">${chips}</div>
      </div>
      <div class="map-content">
        <div class="map-frame">
          ${insight}
          ${routeStrip}
          <div class="map-svg-scroll">
            ${svg}
          </div>
        </div>
        <aside class="map-legend" aria-label="${escapeHtml(m.ariaImpactMapLegend)}">
          ${renderImpactInspector(firstImpact, report, m, sourceContext)}
          <div class="map-legend-key" aria-label="${escapeHtml(m.ariaImpactMapSymbols)}">
            <span><b class="legend-swatch changed"></b>${escapeHtml(m.changedRoot)}</span>
            <span><b class="legend-swatch affected"></b>${escapeHtml(m.affectedTargetRole)}</span>
            <span><b class="legend-swatch context"></b>${escapeHtml(m.contextNode)}</span>
          </div>
          <ol class="map-route-list" aria-label="${escapeHtml(m.ariaVisibleRoutes)}">${edgeRows || `<li>${escapeHtml(m.emptyNoVisiblePaths)}</li>`}</ol>
        </aside>
      </div>
    </section>
  `;
}

export function renderImpactRouteStrip(map: ReturnType<typeof buildImpactMap>, m: UiMessages, selectedPath?: string): string {
  const rows = map.affectedNodes.slice(0, 4).map((node, index) => {
    const edge = map.edges.find((item) => item.to === node.id);
    const pathValue = node.path ?? node.label;
    const selectedClass = node.path === selectedPath ? ' selected-impact' : '';
    const attrs = node.path
      ? ` class="impact-route-card selectable-impact${selectedClass}" tabindex="0" role="button" data-impact-path="${escapeHtml(node.path)}" data-filter-text="${escapeHtml(`${node.label} ${edge?.label ?? ''} ${node.laneLabel ?? ''} ${node.confidence ?? ''}`)}"`
      : ` class="impact-route-card"`;
    return `
      <li${attrs}>
        <b>${escapeHtml(String(index + 1))}</b>
        <strong>${escapeHtml(compactMapLabel(pathValue, 34))}</strong>
        <span>${escapeHtml(edge?.label ?? 'IMPACTS')} · ${escapeHtml(node.laneLabel ?? node.kind)}</span>
        <em class="confidence-${escapeHtml(node.confidence ?? 'unknown')}">${escapeHtml(node.confidence ?? 'unknown')}</em>
      </li>
    `;
  }).join('');
  return `<ol class="impact-route-strip" aria-label="${escapeHtml(m.ariaRankedRoutes)}">${rows}</ol>`;
}

export function renderImpactMapInsight(
  map: ReturnType<typeof buildImpactMap>,
  totalAffectedCount: number,
  displayedPathCount: number,
  m: UiMessages,
  selectedPath?: string,
  action?: ImpactAction
): string {
  const primaryChange = map.changedNodes[0]?.label ?? m.changedRoot;
  const primaryTarget = selectedPath
    ? map.affectedNodes.find((node) => node.path === selectedPath) ?? map.affectedNodes[0]
    : map.affectedNodes[0];
  const primaryTargetLabel = primaryTarget?.label ?? m.affectedTargetEmpty;
  const primaryEdge = map.edges.find((edge) => edge.from === map.changedNodes[0]?.id && edge.to === primaryTarget?.id) ?? map.edges[0];
  const relation = primaryEdge?.label ?? 'IMPACTS';
  const confidence = primaryTarget?.confidence ?? primaryEdge?.confidence ?? 'unknown';
  return `
    <div class="map-insight" aria-label="${escapeHtml(m.ariaPrimaryImpactFlow)}" data-primary-change="${escapeHtml(primaryChange)}" data-affected-count="${escapeHtml(String(totalAffectedCount))}" data-displayed-path-count="${escapeHtml(String(displayedPathCount))}">
      <div class="map-flow-text">
        <span>${escapeHtml(m.primaryImpactFlow)}</span>
        <strong id="mapFlowPath">${escapeHtml(shortenMiddle(primaryChange, 34))} <em>&rarr;</em> ${escapeHtml(shortenMiddle(primaryTargetLabel, 34))}</strong>
        <small id="mapFlowMeta">${escapeHtml(relation)} · ${escapeHtml(String(totalAffectedCount))} ${escapeHtml(m.totalTargets)} · ${escapeHtml(String(displayedPathCount))} ${escapeHtml(m.mappedPaths)} · ${escapeHtml(confidence)} ${escapeHtml(m.confidenceInline)}</small>
      </div>
      ${renderMapNextAction(action, m)}
    </div>
  `;
}

export function renderMapNextAction(action: ImpactAction | undefined, m: UiMessages): string {
  const command = action ? actionCommandText(action) : undefined;
  if (!command) {
    return `
      <div id="mapNextAction" class="map-next-action map-next-action-empty" aria-label="${escapeHtml(m.ariaNextVerificationCommand)}">
        <span>${escapeHtml(m.nextVerification)}</span>
        <small>${escapeHtml(m.noVerificationActionShort)}</small>
      </div>
    `;
  }
  return `
    <div id="mapNextAction" class="map-next-action" aria-label="${escapeHtml(m.ariaNextVerificationCommand)}">
      <span>${escapeHtml(m.nextVerification)}</span>
      <code>${escapeHtml(command)}</code>
      <button class="copy-command" type="button" data-command="${escapeHtml(command)}" aria-label="${escapeHtml(m.ariaCopyMapCommand)}">${escapeHtml(m.copy)}</button>
    </div>
  `;
}

export function buildImpactMap(
  graph: UiGraphPreview | null,
  report: UiReportPreview | null
): {
  changedNodes: ImpactMapNode[];
  affectedNodes: ImpactMapNode[];
  edges: ImpactMapEdge[];
  nodeById: Map<string, ImpactMapNode>;
} {
  const changedNodes = uniqueImpactMapNodes([
    ...(report?.changed ?? []).map((entity): ImpactMapNode => ({
      id: entity.id,
      label: entityLabel(entity),
      kind: entity.kind,
      group: 'changed'
    })),
    ...(graph?.nodes ?? []).filter((node) => node.group === 'changed').map(graphNodeForImpactMap)
  ]).slice(0, 5);
  const actionTargets = new Set((report?.actions ?? []).map((action) => action.target.path).filter((value): value is string => Boolean(value)));
  const affectedNodes = uniqueImpactMapNodes([
    ...(report ? topAffectedFilesForSummary(report) : []).map((item): ImpactMapNode => {
      const lane = impactLaneDisplay(classifyImpactLane(item.path, item.reason, actionTargets));
      return {
        id: `file:${item.path}`,
        label: item.path,
        kind: 'file',
        group: 'affected',
        confidence: item.confidence,
        laneLabel: lane.label,
        laneTone: lane.tone,
        path: item.path
      };
    }),
    ...(graph?.nodes ?? []).filter((node) => node.group !== 'changed').map(graphNodeForImpactMap)
  ]).slice(0, 8);
  const nodeById = new Map([...changedNodes, ...affectedNodes].map((node) => [node.id, node]));
  const changedIds = new Set(changedNodes.map((node) => node.id));
  const affectedIds = new Set(affectedNodes.map((node) => node.id));
  const affectedFilesByNodeId = new Map((report?.affectedFiles ?? []).map((item) => [`file:${item.path}`, item]));
  const edges: ImpactMapEdge[] = [];
  const seenEdges = new Set<string>();
  for (const edge of graph?.edges ?? []) {
    const oriented = orientImpactEdge(edge, changedIds, affectedIds);
    if (!oriented) continue;
    const key = `${oriented.from}:${oriented.to}:${oriented.label}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const targetPath = nodeById.get(oriented.to)?.path;
    const affectedFile = affectedFilesByNodeId.get(oriented.to);
    edges.push({
      ...oriented,
      label: affectedFile ? impactPathLabel(affectedFile, actionTargets) : oriented.label,
      confidence: affectedFile?.confidence ?? oriented.confidence,
      ...(targetPath ? { targetPath } : {})
    });
  }
  if (changedNodes[0]) {
    for (const node of affectedNodes) {
      if (edges.some((edge) => edge.to === node.id)) continue;
      const affectedFile = affectedFilesByNodeId.get(node.id);
      edges.push({
        from: changedNodes[0].id,
        to: node.id,
        label: affectedFile ? impactPathLabel(affectedFile, actionTargets) : 'IMPACTS',
        confidence: node.confidence ?? affectedFile?.confidence ?? 'unknown',
        ...(node.path ? { targetPath: node.path } : {})
      });
    }
  }
  return { changedNodes, affectedNodes, edges: edges.slice(0, 12), nodeById };
}

function renderImpactMapSvg(map: ReturnType<typeof buildImpactMap>, selectedPath: string | undefined, m: UiMessages): string {
  const width = 760;
  const leftX = 38;
  const rightX = 462;
  const nodeWidth = 238;
  const nodeHeight = 60;
  const rowCount = Math.max(map.changedNodes.length, map.affectedNodes.length, 1);
  const height = Math.max(420, 132 + rowCount * 64);
  const affectedPositions = impactNodePositions(map.affectedNodes, height);
  const changedPositions = map.changedNodes.length === 1 && map.affectedNodes.length > 1
    ? [affectedPositions[0] ?? 96]
    : impactNodePositions(map.changedNodes, height);
  const yByNode = new Map<string, number>([
    ...map.changedNodes.map((node, index): [string, number] => [node.id, changedPositions[index] ?? 92]),
    ...map.affectedNodes.map((node, index): [string, number] => [node.id, affectedPositions[index] ?? 92])
  ]);
  const edges = map.edges.map((edge) => {
    const fromY = yByNode.get(edge.from);
    const toY = yByNode.get(edge.to);
    if (fromY === undefined || toY === undefined) return '';
    const startX = leftX + nodeWidth;
    const endX = rightX;
    const controlX = (startX + endX) / 2;
    const labelY = Math.min(height - 32, Math.max(78, (fromY + toY) / 2 - 8));
    const edgeClass = `map-edge-group${edge.targetPath ? ' selectable-impact' : ''}${edge.targetPath === selectedPath ? ' selected-impact' : ''}`;
    const edgeAttrs = edge.targetPath
      ? ` class="${escapeHtml(edgeClass)}" data-impact-path="${escapeHtml(edge.targetPath)}" tabindex="0" role="button" aria-label="${escapeHtml(`${m.ariaInspectImpactPath}: ${edge.targetPath}`)}"`
      : ' class="map-edge-group"';
    return `
      <g${edgeAttrs}>
        <path class="map-edge confidence-${escapeHtml(edge.confidence)}" d="M ${startX} ${fromY} C ${controlX} ${fromY}, ${controlX} ${toY}, ${endX} ${toY}" marker-end="url(#impactArrow)" />
        <text class="map-edge-label" x="${controlX}" y="${labelY}" text-anchor="middle">${escapeHtml(shortenMiddle(edge.label, 18))}</text>
      </g>
    `;
  }).join('');
  const changedNodes = map.changedNodes.map((node, index) =>
    renderImpactMapNode(node, leftX, (changedPositions[index] ?? 92) - nodeHeight / 2, nodeWidth, nodeHeight, m, selectedPath)
  ).join('');
  const affectedNodes = map.affectedNodes.map((node, index) =>
    renderImpactMapNode(node, rightX, (affectedPositions[index] ?? 92) - nodeHeight / 2, nodeWidth, nodeHeight, m, selectedPath)
  ).join('');

  return `
    <svg class="impact-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="${escapeHtml(m.ariaMapSvg)}">
      <defs>
        <marker id="impactArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path class="map-arrow" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <rect class="map-stage map-stage-changed" x="24" y="52" width="290" height="${height - 74}" rx="16" />
      <rect class="map-stage map-stage-affected" x="438" y="52" width="290" height="${height - 74}" rx="16" />
      <text class="map-column-label" x="${leftX}" y="36">${escapeHtml(m.changedRoot)}</text>
      <text class="map-route-label" x="${(leftX + nodeWidth + rightX) / 2}" y="36" text-anchor="middle">${escapeHtml(m.impactPathLabel)}</text>
      <text class="map-column-label" x="${rightX}" y="36">${escapeHtml(m.affectedTargets)}</text>
      <g>${edges}</g>
      <g>${changedNodes}</g>
      <g>${affectedNodes}</g>
    </svg>
  `;
}

function renderImpactMapNode(node: ImpactMapNode, x: number, y: number, width: number, height: number, m: UiMessages, selectedPath?: string): string {
  const label = compactMapLabel(node.label, node.group === 'affected' ? 30 : 34);
  const roleLabel = node.group === 'affected'
    ? (node.laneLabel ?? m.affectedTargetRole)
    : node.group === 'changed'
      ? m.changedInput
      : node.kind;
  const confidenceLabel = node.group === 'affected' ? (node.confidence ?? 'unknown') : '';
  const confidenceText = confidenceLabel
    ? `<text class="map-node-confidence confidence-text-${escapeHtml(node.confidence ?? 'unknown')}" x="${width - 14}" y="47" text-anchor="end">${escapeHtml(confidenceLabel)}</text>`
    : '';
  const impactAttrs = node.group === 'affected' && node.path
    ? ` data-impact-path="${escapeHtml(node.path)}" tabindex="0" role="button" aria-label="${escapeHtml(`${m.ariaInspectImpactPath}: ${node.path}`)}"`
    : '';
  const selectableClass = impactAttrs ? ` selectable-impact${node.path === selectedPath ? ' selected-impact' : ''}` : '';
  const laneClass = node.laneTone ? ` map-node-lane-${escapeHtml(node.laneTone)}` : '';
  return `
    <g class="map-node${selectableClass} map-node-${escapeHtml(node.group)} confidence-node-${escapeHtml(node.confidence ?? 'unknown')}${laneClass}" transform="translate(${x} ${y})"${impactAttrs}>
      <title>${escapeHtml(node.label)}</title>
      <rect width="${width}" height="${height}" rx="8" />
      <circle cx="20" cy="26" r="5" />
      <text class="map-node-label" x="36" y="25">${escapeHtml(label)}</text>
      <text class="map-node-kind" x="36" y="47">${escapeHtml(roleLabel)}</text>
      ${confidenceText}
    </g>
  `;
}

function impactNodePositions(nodes: ImpactMapNode[], height: number): number[] {
  if (nodes.length === 0) return [];
  const top = 96;
  const bottom = height - 54;
  if (nodes.length === 1) return [(top + bottom) / 2];
  const step = (bottom - top) / (nodes.length - 1);
  return nodes.map((_, index) => top + step * index);
}

function graphNodeForImpactMap(node: UiGraphPreview['nodes'][number]): ImpactMapNode {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    group: node.group,
    ...(node.path ? { path: node.path } : {}),
    ...(node.confidence ? { confidence: node.confidence } : {})
  };
}

function orientImpactEdge(
  edge: UiGraphPreview['edges'][number],
  changedIds: ReadonlySet<string>,
  affectedIds: ReadonlySet<string>
): ImpactMapEdge | null {
  if (changedIds.has(edge.source) && affectedIds.has(edge.target)) {
    return { from: edge.source, to: edge.target, label: edge.label, confidence: edge.confidence };
  }
  if (changedIds.has(edge.target) && affectedIds.has(edge.source)) {
    return { from: edge.target, to: edge.source, label: edge.label, confidence: edge.confidence };
  }
  return null;
}

function uniqueImpactMapNodes(nodes: ImpactMapNode[]): ImpactMapNode[] {
  const byId = new Map<string, ImpactMapNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) continue;
    byId.set(node.id, node);
  }
  return [...byId.values()];
}

function impactLaneDisplay(id: ImpactLaneId): Pick<ImpactLane, 'label' | 'tone'> {
  if (id === 'tests') return { label: 'Tests to verify', tone: 'amber' };
  if (id === 'knowledge') return { label: 'Docs & policy', tone: 'teal' };
  if (id === 'contracts') return { label: 'Contracts', tone: 'red' };
  if (id === 'config') return { label: 'Config & infra', tone: 'blue' };
  return { label: 'Runtime code', tone: 'green' };
}

function impactPathLabel(item: UiReportPreview['affectedFiles'][number], actionTargets: ReadonlySet<string> = new Set()): string {
  const lane = classifyImpactLane(item.path, item.reason, actionTargets);
  if (lane === 'tests') return 'VERIFY';
  if (lane === 'knowledge') return 'DOCUMENTS';
  if (lane === 'contracts') return 'CONTRACT';
  if (lane === 'config') return 'CONFIG';
  const relationCount = item.relationPath?.length ?? 0;
  if (relationCount > 1) return `${relationCount} hops`;
  return item.reason.split(' ')[0]?.toUpperCase() ?? 'IMPACTS';
}

function initialImpactForUi(report: UiReportPreview): UiReportPreview['affectedFiles'][number] | undefined {
  const affectedFiles = [...report.affectedFiles].sort(compareAffectedFilesForUi);
  const actionTargets = new Set(report.actions.map((action) => action.target.path).filter((pathValue): pathValue is string => Boolean(pathValue)));
  return affectedFiles.find((item) => actionTargets.has(item.path)) ?? affectedFiles[0];
}

function renderImpactInspector(
  item: UiReportPreview['affectedFiles'][number] | undefined,
  report: UiReportPreview | null,
  m: UiMessages,
  sourceContext: SourceLinkContext = {}
): string {
  const evidence = item && report ? impactEvidenceForPath(report.evidence, item.path) : [];
  const action = item && report ? actionByTargetPath(report.actions).get(item.path) : undefined;
  return `
    <section class="impact-inspector" aria-live="polite" aria-label="${escapeHtml(m.ariaImpactInspector)}">
      <h3>${escapeHtml(m.impactInspector)}</h3>
      <strong id="inspectorPath">${escapeHtml(item?.path ?? m.noAffectedTargetSelected)}</strong>
      <span id="inspectorReason">${escapeHtml(item?.reason ?? m.selectAffectedTarget)}</span>
      <section class="inspector-action">
        <h4>${escapeHtml(m.nextVerification)}</h4>
        <div id="inspectorAction">${renderInspectorAction(action, m)}</div>
      </section>
      <dl>
        <div>
          <dt>${escapeHtml(m.confidence)}</dt>
          <dd id="inspectorConfidence">${escapeHtml(item?.confidence ?? 'unknown')}</dd>
        </div>
        <div>
          <dt>${escapeHtml(m.relationPath)}</dt>
          <dd id="inspectorRelation">${escapeHtml(item?.relationPath?.join(' -> ') ?? m.directOrNotRecorded)}</dd>
        </div>
        <div>
          <dt>${escapeHtml(m.evidenceHits)}</dt>
          <dd id="inspectorEvidence">${escapeHtml(String(evidence.length))}</dd>
        </div>
        <div>
          <dt>${escapeHtml(m.source)}</dt>
          <dd id="inspectorSource">${renderInspectorSource(evidence[0], m, sourceContext)}</dd>
        </div>
      </dl>
      <section class="inspector-evidence">
        <h4>${escapeHtml(m.topEvidence)}</h4>
        <ul id="inspectorEvidenceList">${renderInspectorEvidenceList(evidence, m, sourceContext)}</ul>
      </section>
    </section>
  `;
}

function renderInspectorAction(action: ImpactAction | undefined, m: UiMessages): string {
  if (!action) return `<span class="inspector-empty">${escapeHtml(m.noVerificationActionRecorded)}</span>`;
  const command = actionCommandText(action);
  if (!command) return `<span class="inspector-empty">${escapeHtml(m.noCommandRecorded)}</span>`;
  return `
    <code>${escapeHtml(command)}</code>
    <button class="copy-command" type="button" data-command="${escapeHtml(command)}" aria-label="${escapeHtml(m.ariaCopyInspectorCommand)}">${escapeHtml(m.copy)}</button>
  `;
}

function renderInspectorSource(
  evidence: UiEvidencePreview | undefined,
  m: UiMessages,
  sourceContext: SourceLinkContext
): string {
  if (!evidence) return escapeHtml(m.noSourceSpanRecorded);
  const source = evidenceSourceLocation(evidence, sourceContext);
  if (!source) return escapeHtml(m.noSourceSpanRecorded);
  return `<a class="source-link" href="${escapeHtml(source.href)}" target="_blank" rel="noreferrer">${escapeHtml(`${m.ariaOpenSourceLabel} ${source.label}`)}</a>`;
}

function renderInspectorEvidenceList(
  evidence: readonly UiEvidencePreview[],
  m: UiMessages,
  sourceContext: SourceLinkContext
): string {
  if (evidence.length === 0) return `<li class="inspector-empty">${escapeHtml(m.noMatchingEvidence)}</li>`;
  return evidence.slice(0, 3).map((item) => {
    const source = evidenceSourceLocation(item, sourceContext);
    return `
      <li>
        <strong>${escapeHtml(item.file)}</strong>
        <span>${escapeHtml(item.kind)} · ${escapeHtml(item.confidence)}</span>
        ${source ? `<a class="source-link" href="${escapeHtml(source.href)}" target="_blank" rel="noreferrer">${escapeHtml(source.label)}</a>` : ''}
        <pre>${escapeHtml(shortenMiddle(item.snippet, 120))}</pre>
      </li>
    `;
  }).join('');
}

function impactEvidenceForPath(evidence: readonly UiEvidencePreview[], pathValue: string): UiEvidencePreview[] {
  return evidence.filter((item) => impactEvidenceMatchesPath(item, pathValue));
}

function compactMapLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const pathParts = value.split('/').filter(Boolean);
  if (pathParts.length > 2) {
    const tail = pathParts.slice(-2).join('/');
    if (tail.length <= maxLength) return tail;
  }
  return shortenMiddle(value, maxLength);
}

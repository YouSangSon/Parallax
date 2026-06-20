// A deliberately small, READ-ONLY Cypher subset over the canonical
// entities/relations graph. Supports an optional relationship hop (forward or
// reverse, fixed or variable-length `*min..max`), node labels, WHERE
// equality/CONTAINS on properties, projection, and LIMIT, and rejects
// everything else (writes, procedures, bidirectional) with a clear error. The
// parser is pure; the executor translates to parameterized SQL (a recursive CTE
// for variable-length paths).

import { getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { normalizeRepoRoot } from './security.js';

export type GraphQueryPathLength = { min: number; max: number };
export type GraphQueryNode = { variable: string; label?: string };
export type GraphQueryRel = { variable?: string; type?: string; pathLength?: GraphQueryPathLength };
export type GraphQueryCondition = {
  variable: string;
  property: string;
  op: '=' | 'CONTAINS';
  value: string;
};
export type GraphQueryReturn = { variable: string; property?: string };
export type ParsedGraphQuery = {
  source: GraphQueryNode;
  relationship?: GraphQueryRel;
  target?: GraphQueryNode;
  where: GraphQueryCondition[];
  returns: GraphQueryReturn[];
  limit?: number;
};
export type GraphQueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  // The completed index run the query executed against — makes a query result
  // measurable and pins it to a point in graph history.
  indexRunId: number;
  // Distinct entity ids the result projected, navigable via the
  // `parallax://entities/{id}` resource template. Populated only when a node's
  // `id` is actually returned (`RETURN a` / `RETURN a.id`) — you can only
  // navigate ids you returned.
  resources: { entities: string[] };
};

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const MAX_HOPS = 8;

export function parseGraphQuery(input: string): ParsedGraphQuery {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!/^MATCH\b/i.test(text)) {
    throw new Error('unsupported query: only read-only MATCH ... RETURN is supported');
  }
  if (/\b(CREATE|MERGE|DELETE|SET|REMOVE|DETACH|CALL|FOREACH|LOAD|UNWIND|WITH)\b/i.test(text)) {
    throw new Error('unsupported query: write, procedure, and projection clauses are not allowed (read-only subset)');
  }

  const returnSplit = text.split(/\bRETURN\b/i);
  if (returnSplit.length !== 2) {
    throw new Error('query must contain exactly one RETURN clause');
  }
  const matchPart = returnSplit[0]!.replace(/^MATCH\b/i, '').trim();
  let returnPart = returnSplit[1]!.trim();

  let limit: number | undefined;
  const limitMatch = returnPart.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (limitMatch) {
    limit = Math.min(Number(limitMatch[1]), MAX_LIMIT);
    returnPart = returnPart.slice(0, limitMatch.index).trim();
  }

  const whereSplit = matchPart.split(/\bWHERE\b/i);
  if (whereSplit.length > 2) throw new Error('unsupported query: multiple WHERE clauses');
  const patternPart = whereSplit[0]!.trim();
  const wherePart = whereSplit.length === 2 ? whereSplit[1]!.trim() : '';

  const pattern = parsePattern(patternPart);
  const where = parseWhere(wherePart);
  const returns = parseReturns(returnPart);

  // A variable-length path has no single relationship binding, so its rel
  // variable is not projectable — omit it so RETURN/WHERE references error.
  const relVariable = pattern.relationship?.pathLength ? undefined : pattern.relationship?.variable;
  const variables = new Set(
    [pattern.source.variable, relVariable, pattern.target?.variable].filter(
      (value): value is string => typeof value === 'string'
    )
  );
  for (const condition of where) {
    if (!variables.has(condition.variable)) {
      throw new Error(`unknown variable in WHERE: ${condition.variable}`);
    }
  }
  for (const item of returns) {
    if (!variables.has(item.variable)) {
      throw new Error(`unknown variable in RETURN: ${item.variable}`);
    }
  }

  return {
    source: pattern.source,
    ...(pattern.relationship ? { relationship: pattern.relationship } : {}),
    ...(pattern.target ? { target: pattern.target } : {}),
    where,
    returns,
    ...(limit !== undefined ? { limit } : {})
  };
}

const NODE = '\\(\\s*([A-Za-z_]\\w*)\\s*(?::\\s*([A-Za-z_]\\w*))?\\s*\\)';
// Relationship: optional variable, optional :TYPE, optional *min..max length.
const REL = '\\[\\s*([A-Za-z_]\\w*)?\\s*(?::\\s*([A-Za-z_]\\w*))?\\s*(\\*\\d*(?:\\.\\.\\d+)?)?\\s*\\]';
const FORWARD_HOP = new RegExp(`^${NODE}\\s*-\\s*${REL}\\s*->\\s*${NODE}$`);
const REVERSE_HOP = new RegExp(`^${NODE}\\s*<-\\s*${REL}\\s*-\\s*${NODE}$`);
const NODE_ONLY = new RegExp(`^${NODE}$`);

function relationship(variable: string | undefined, type: string | undefined, pathToken: string | undefined): GraphQueryRel {
  const pathLength = parsePathLength(pathToken);
  return {
    ...(variable ? { variable } : {}),
    ...(type ? { type } : {}),
    ...(pathLength ? { pathLength } : {})
  };
}

// `*` → 1..MAX_HOPS, `*N` → N..N, `*min..max` → min..max, `*..max` → 1..max.
function parsePathLength(token: string | undefined): GraphQueryPathLength | undefined {
  if (!token) return undefined;
  const body = token.slice(1); // strip leading '*'
  if (body === '') return { min: 1, max: MAX_HOPS };
  const range = body.match(/^(\d*)\.\.(\d+)$/);
  if (range) {
    const min = range[1] === '' ? 1 : Number(range[1]);
    const max = Math.min(Number(range[2]), MAX_HOPS);
    if (min < 1 || max < min) throw new Error(`invalid path length: ${token}`);
    return { min, max };
  }
  const exact = Number(body);
  if (!Number.isInteger(exact) || exact < 1) throw new Error(`invalid path length: ${token}`);
  return { min: exact, max: Math.min(exact, MAX_HOPS) };
}

function parsePattern(text: string): Pick<ParsedGraphQuery, 'source' | 'relationship' | 'target'> {
  if (text.includes('<-') && text.includes('->')) {
    throw new Error('unsupported query: bidirectional relationships are not supported');
  }
  const forward = text.match(FORWARD_HOP);
  if (forward) {
    return {
      source: { variable: forward[1]!, ...(forward[2] ? { label: forward[2] } : {}) },
      relationship: relationship(forward[3], forward[4], forward[5]),
      target: { variable: forward[6]!, ...(forward[7] ? { label: forward[7] } : {}) }
    };
  }
  // Reverse: (head)<-[r]-(tail) means tail -> head; normalize so the executor
  // sees the relation's true source (tail) and target (head).
  const reverse = text.match(REVERSE_HOP);
  if (reverse) {
    return {
      source: { variable: reverse[6]!, ...(reverse[7] ? { label: reverse[7] } : {}) },
      relationship: relationship(reverse[3], reverse[4], reverse[5]),
      target: { variable: reverse[1]!, ...(reverse[2] ? { label: reverse[2] } : {}) }
    };
  }
  const nodeOnly = text.match(NODE_ONLY);
  if (nodeOnly) {
    return { source: { variable: nodeOnly[1]!, ...(nodeOnly[2] ? { label: nodeOnly[2] } : {}) } };
  }
  throw new Error('unsupported MATCH pattern: expected (a), (a:Label), (a)-[r:TYPE]->(b), (a)<-[r:TYPE]-(b), or variable-length (a)-[r:TYPE*1..3]->(b)');
}

function parseWhere(text: string): GraphQueryCondition[] {
  if (!text) return [];
  return text
    .split(/\bAND\b/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s+(=|CONTAINS)\s+'([^']*)'$/i);
      if (!match) {
        throw new Error(
          `unsupported WHERE condition: ${part} (expected var.prop = 'value' or var.prop CONTAINS 'value')`
        );
      }
      const op = match[3]!.toUpperCase() === 'CONTAINS' ? 'CONTAINS' : '=';
      return { variable: match[1]!, property: match[2]!, op, value: match[4]! };
    });
}

function parseReturns(text: string): GraphQueryReturn[] {
  if (!text) throw new Error('RETURN requires at least one item');
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/);
      if (!match) throw new Error(`unsupported RETURN item: ${item}`);
      return { variable: match[1]!, ...(match[2] ? { property: match[2] } : {}) };
    });
}

function entityColumn(property: string | undefined): string {
  switch (property) {
    case undefined:
    case 'id':
      return 'id';
    case 'path':
      return 'path';
    case 'kind':
      return 'kind';
    case 'name':
    case 'displayName':
    case 'display_name':
      return 'display_name';
    case 'symbol':
      return 'symbol';
    case 'language':
    case 'languageId':
      return 'language_id';
    default:
      throw new Error(`unsupported node property: ${property}`);
  }
}

function relationshipColumn(property: string | undefined): string {
  switch (property) {
    case undefined:
    case 'kind':
      return 'kind';
    case 'confidence':
      return 'confidence';
    case 'provenance':
      return 'provenance';
    default:
      throw new Error(`unsupported relationship property: ${property}`);
  }
}

export function executeGraphQuery(repoRoot: string, input: string): GraphQueryResult {
  const query = parseGraphQuery(input);
  const root = normalizeRepoRoot(repoRoot);
  const db = openDatabase(root, { readOnly: true });
  try {
    const repoId = getRepoId(db, root);
    const indexRunId = latestCompletedIndexRun(db, repoId);
    const params: Array<string | number> = [];

    const aliasFor = (variable: string): { alias: string; table: 'entity' | 'relationship' } => {
      if (variable === query.source.variable) return { alias: 'src', table: 'entity' };
      if (query.target && variable === query.target.variable) return { alias: 'tgt', table: 'entity' };
      if (query.relationship && variable === query.relationship.variable) {
        return { alias: 'r', table: 'relationship' };
      }
      throw new Error(`unknown variable: ${variable}`);
    };

    const columnExpr = (variable: string, property: string | undefined): string => {
      const { alias, table } = aliasFor(variable);
      return `${alias}.${table === 'entity' ? entityColumn(property) : relationshipColumn(property)}`;
    };

    const columns = query.returns.map((item) =>
      item.property ? `${item.variable}.${item.property}` : item.variable
    );
    const selectList = query.returns
      .map((item, index) => `${columnExpr(item.variable, item.property)} AS c${index}`)
      .join(', ');

    const conditions: string[] = [];
    const addLabel = (target: string[], node: GraphQueryNode | undefined, alias: string): void => {
      if (node?.label) {
        target.push(`LOWER(${alias}.kind) = LOWER(?)`);
        params.push(node.label);
      }
    };
    const addWhere = (target: string[]): void => {
      for (const condition of query.where) {
        const { alias, table } = aliasFor(condition.variable);
        const column = `${alias}.${
          table === 'entity'
            ? entityColumn(condition.property)
            : relationshipColumn(condition.property)
        }`;
        if (condition.op === 'CONTAINS') {
          target.push(`${column} LIKE ?`);
          params.push(`%${condition.value}%`);
        } else {
          target.push(`${column} = ?`);
          params.push(condition.value);
        }
      }
    };

    let sql: string;
    if (query.relationship?.pathLength && query.target) {
      // Variable-length path: transitive closure of `kind` from src to a
      // reachable node, bounded by [min, max]. UNION (not UNION ALL) dedups and
      // stops cycles; the depth cap is a hard backstop.
      const { min, max } = query.relationship.pathLength;
      const typeClause = query.relationship.type ? ' AND UPPER(r.kind) = UPPER(?)' : '';
      params.push(repoId, indexRunId);
      if (query.relationship.type) params.push(query.relationship.type);
      params.push(repoId, indexRunId);
      if (query.relationship.type) params.push(query.relationship.type);
      params.push(max);
      const outer: string[] = ['reach.depth >= ?'];
      params.push(min);
      addLabel(outer, query.source, 'src');
      addLabel(outer, query.target, 'tgt');
      addWhere(outer);
      sql =
        'WITH RECURSIVE reach(start_id, node_id, depth) AS ( ' +
        'SELECT r.source_entity_id, r.target_entity_id, 1 FROM relations r ' +
        `WHERE r.repo_id = ? AND r.index_run_id = ?${typeClause} ` +
        'UNION ' +
        'SELECT reach.start_id, r.target_entity_id, reach.depth + 1 FROM reach ' +
        'JOIN relations r ON r.source_entity_id = reach.node_id ' +
        `WHERE r.repo_id = ? AND r.index_run_id = ?${typeClause} AND reach.depth < ? ` +
        ') ' +
        `SELECT ${selectList} FROM reach ` +
        'JOIN entities src ON src.id = reach.start_id ' +
        'JOIN entities tgt ON tgt.id = reach.node_id ' +
        `WHERE ${outer.join(' AND ')} ` +
        'ORDER BY src.path, tgt.path';
    } else if (query.relationship && query.target) {
      conditions.push('r.repo_id = ?');
      params.push(repoId);
      conditions.push('r.index_run_id = ?');
      params.push(indexRunId);
      if (query.relationship.type) {
        conditions.push('UPPER(r.kind) = UPPER(?)');
        params.push(query.relationship.type);
      }
      addLabel(conditions, query.source, 'src');
      addLabel(conditions, query.target, 'tgt');
      addWhere(conditions);
      sql =
        `SELECT ${selectList} FROM relations r ` +
        'JOIN entities src ON src.id = r.source_entity_id ' +
        'JOIN entities tgt ON tgt.id = r.target_entity_id ' +
        `WHERE ${conditions.join(' AND ')} ` +
        'ORDER BY src.path, tgt.path, r.kind';
    } else {
      conditions.push('src.repo_id = ?');
      params.push(repoId);
      conditions.push('src.updated_index_run_id = ?');
      params.push(indexRunId);
      addLabel(conditions, query.source, 'src');
      addWhere(conditions);
      sql =
        `SELECT ${selectList} FROM entities src WHERE ${conditions.join(' AND ')} ORDER BY src.path`;
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    sql += ' LIMIT ?';
    params.push(limit);

    const raw = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const rows = raw.map((row) => {
      const mapped: Record<string, unknown> = {};
      columns.forEach((name, index) => {
        mapped[name] = row[`c${index}`];
      });
      return mapped;
    });

    // Which projected columns are entity ids? Those map to an entity table and
    // resolve to the `id` column. Their values are navigable resource ids.
    const entityIdColumnIndexes = query.returns
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => aliasFor(item.variable).table === 'entity' && entityColumn(item.property) === 'id')
      .map(({ index }) => index);
    const entities: string[] = [];
    const seen = new Set<string>();
    for (const row of raw) {
      for (const index of entityIdColumnIndexes) {
        const value = row[`c${index}`];
        if (typeof value === 'string' && value.length > 0 && !seen.has(value)) {
          seen.add(value);
          entities.push(value);
        }
      }
    }

    return { columns, rows, indexRunId, resources: { entities } };
  } finally {
    db.close();
  }
}

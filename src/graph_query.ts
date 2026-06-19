// A deliberately small, READ-ONLY Cypher subset over the canonical
// entities/relations graph. Supports a single optional relationship hop, node
// labels, WHERE equality/CONTAINS on properties, projection, and LIMIT, and
// rejects everything else (writes, procedures, reverse direction) with a clear
// error. The parser is pure; the executor translates to parameterized SQL.

import { getRepoId, latestCompletedIndexRun, openDatabase } from './store.js';
import { normalizeRepoRoot } from './security.js';

export type GraphQueryNode = { variable: string; label?: string };
export type GraphQueryRel = { variable?: string; type?: string };
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
export type GraphQueryResult = { columns: string[]; rows: Array<Record<string, unknown>> };

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

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

  const variables = new Set(
    [pattern.source.variable, pattern.relationship?.variable, pattern.target?.variable].filter(
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

function parsePattern(text: string): Pick<ParsedGraphQuery, 'source' | 'relationship' | 'target'> {
  if (text.includes('<-')) {
    throw new Error('unsupported query: only left-to-right (->) relationship direction is supported');
  }
  const hop = text.match(
    /^\(\s*([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*))?\s*\)\s*-\s*\[\s*([A-Za-z_]\w*)?\s*(?::\s*([A-Za-z_]\w*))?\s*\]\s*->\s*\(\s*([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*))?\s*\)$/
  );
  if (hop) {
    return {
      source: { variable: hop[1]!, ...(hop[2] ? { label: hop[2] } : {}) },
      relationship: { ...(hop[3] ? { variable: hop[3] } : {}), ...(hop[4] ? { type: hop[4] } : {}) },
      target: { variable: hop[5]!, ...(hop[6] ? { label: hop[6] } : {}) }
    };
  }
  const nodeOnly = text.match(/^\(\s*([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*))?\s*\)$/);
  if (nodeOnly) {
    return { source: { variable: nodeOnly[1]!, ...(nodeOnly[2] ? { label: nodeOnly[2] } : {}) } };
  }
  throw new Error('unsupported MATCH pattern: expected (a), (a:Label), or (a)-[r:TYPE]->(b)');
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
    const addLabel = (node: GraphQueryNode | undefined, alias: string): void => {
      if (node?.label) {
        conditions.push(`LOWER(${alias}.kind) = LOWER(?)`);
        params.push(node.label);
      }
    };
    const addWhere = (): void => {
      for (const condition of query.where) {
        const { alias, table } = aliasFor(condition.variable);
        const column = `${alias}.${
          table === 'entity'
            ? entityColumn(condition.property)
            : relationshipColumn(condition.property)
        }`;
        if (condition.op === 'CONTAINS') {
          conditions.push(`${column} LIKE ?`);
          params.push(`%${condition.value}%`);
        } else {
          conditions.push(`${column} = ?`);
          params.push(condition.value);
        }
      }
    };

    let sql: string;
    if (query.relationship && query.target) {
      conditions.push('r.repo_id = ?');
      params.push(repoId);
      conditions.push('r.index_run_id = ?');
      params.push(indexRunId);
      if (query.relationship.type) {
        conditions.push('UPPER(r.kind) = UPPER(?)');
        params.push(query.relationship.type);
      }
      addLabel(query.source, 'src');
      addLabel(query.target, 'tgt');
      addWhere();
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
      addLabel(query.source, 'src');
      addWhere();
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
    return { columns, rows };
  } finally {
    db.close();
  }
}

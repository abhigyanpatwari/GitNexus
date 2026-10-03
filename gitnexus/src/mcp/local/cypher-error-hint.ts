import {
  EMBEDDING_TABLE_NAME,
  NODE_TABLES,
  REL_TABLE_NAME,
  REL_TYPES,
  SCHEMA_QUERIES,
} from '../../core/lbug/schema.js';

// Use the DDL's actual columns, not a second hand-maintained schema. The binder
// names the failing variable, not its table, so these are only possible matches.
const PROPERTY_NAMES = [
  ...new Set(
    SCHEMA_QUERIES.flatMap((ddl) =>
      [
        ...ddl.matchAll(
          /^\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:STRING|INT64|INT32|DOUBLE|FLOAT|BOOLEAN)\b/gm,
        ),
      ].map((match) => match[1]),
    ),
  ),
];
const TABLE_NAMES = [...NODE_TABLES, REL_TABLE_NAME, EMBEDDING_TABLE_NAME];

/** Return one unambiguous, nearby spelling; never guess from a long prefix. */
function closestName(input: string, candidates: readonly string[]): string | undefined {
  if (input.length < 3 || input.length > 64) return undefined;
  const lower = input.toLowerCase();
  // A valid name on the wrong table is not a spelling error.
  if (candidates.some((candidate) => candidate.toLowerCase() === lower)) return undefined;
  let bestDistance = input.length < 5 ? 1 : 2;
  let best: string | undefined;
  let tied = false;
  for (const candidate of candidates) {
    const target = candidate.toLowerCase();
    if (Math.abs(target.length - lower.length) > bestDistance) continue;
    let previous = Array.from({ length: target.length + 1 }, (_, i) => i);
    for (let i = 1; i <= lower.length; i++) {
      const row = [i];
      for (let j = 1; j <= target.length; j++) {
        row[j] = Math.min(
          row[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (lower[i - 1] === target[j - 1] ? 0 : 1),
        );
      }
      previous = row;
    }
    const distance = previous[target.length];
    if (distance > bestDistance) continue;
    if (distance < bestDistance || best === undefined) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

/** Add guidance only for native schema errors; execution/recovery stays with the caller. */
export function getCypherErrorHint(message: string, repoName: string): string | undefined {
  const schema = `Read gitnexus://repo/${encodeURIComponent(repoName)}/schema for the schema.`;
  const property = message.match(
    /^(?:Prepare failed: )?Binder exception: Cannot find property ([A-Za-z_][A-Za-z0-9_]*) for /i,
  )?.[1];
  if (property) {
    const suggestion = closestName(property, PROPERTY_NAMES);
    return `${suggestion ? `Did you mean '${suggestion}'? ` : ''}Schema properties vary by table. ${schema}`;
  }

  const table = message.match(
    /^(?:Prepare failed: )?Binder exception: Table ([A-Za-z_][A-Za-z0-9_]*) does not exist\./i,
  )?.[1];
  if (!table) return undefined;
  const relation = REL_TYPES.find((type) => type.toLowerCase() === table.toLowerCase());
  if (relation) {
    return `Relationships use :${REL_TABLE_NAME} {type: '${relation}'}, not a '${relation}' table. ${schema}`;
  }
  const suggestion = closestName(table, TABLE_NAMES);
  return `${suggestion ? `Did you mean '${suggestion}'? ` : ''}${schema}`;
}

import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import {
  decodeSpringAopReason,
  type SpringAopReason,
} from '../../core/ingestion/frameworks/spring/aop.js';

type SpringAopBehaviorReason = Extract<SpringAopReason, { kind: 'behavior' }>;
type SpringAopAdviceReason = Extract<SpringAopReason, { kind: 'advice' }>;
type SpringAopAspectReason = Extract<SpringAopReason, { kind: 'aspect' }>;

export interface SpringAopBehaviorMetadata {
  readonly annotation: string;
  readonly behavior: SpringAopBehaviorReason['behavior'];
  readonly declaredOn: SpringAopBehaviorReason['declaredOn'];
  readonly activation: SpringAopBehaviorReason['activation'];
  readonly evidenceId: string;
}

export interface SpringAopAdviceMetadata {
  readonly annotation: string;
  readonly advice: SpringAopAdviceReason['advice'];
  readonly pointcut: string;
  readonly match: SpringAopAdviceReason['match'];
  readonly activation: SpringAopAdviceReason['activation'];
  readonly adviceId: string;
  readonly adviceName?: string;
  readonly adviceFilePath?: string;
  readonly advisedId: string;
  readonly advisedName?: string;
  readonly advisedFilePath?: string;
}

export interface SpringAopUnresolvedPointcutMetadata {
  readonly annotation: string;
  readonly pointcut: string | null;
  readonly adviceId: string;
  readonly adviceName?: string;
  readonly adviceFilePath?: string;
  readonly evidenceId: string;
}

export interface SpringAopAspectMetadata {
  readonly annotation: string;
  readonly activation: SpringAopAspectReason['activation'];
  readonly registration: SpringAopAspectReason['registration'];
  readonly evidenceId: string;
}

export interface SpringAopMetadata {
  readonly framework: 'spring';
  readonly proxied?: 'possible';
  readonly truncated?: true;
  readonly aspect?: SpringAopAspectMetadata;
  readonly behaviors: readonly SpringAopBehaviorMetadata[];
  readonly advices: readonly SpringAopAdviceMetadata[];
  readonly unresolvedPointcuts: readonly SpringAopUnresolvedPointcutMetadata[];
}

interface RelationshipRow {
  readonly sourceId: string;
  readonly sourceName?: string;
  readonly sourceFilePath?: string;
  readonly targetId: string;
  readonly targetName?: string;
  readonly targetFilePath?: string;
  readonly reason: unknown;
}

const SUPPORTED_SYMBOL_TYPES = new Set(['Class', 'Interface', 'Method', 'CodeElement']);
const QUERY_RESULT_LIMIT = 1_000;
const QUERY_FETCH_LIMIT = QUERY_RESULT_LIMIT + 1;

function readRowValue(row: unknown, name: string, index: number): unknown {
  if (typeof row === 'object' && row !== null && name in row) {
    return (row as Record<string, unknown>)[name];
  }
  return Array.isArray(row) ? row[index] : undefined;
}

function readRequiredString(row: unknown, name: string, index: number): string | undefined {
  const value = readRowValue(row, name, index);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalString(row: unknown, name: string, index: number): string | undefined {
  const value = readRowValue(row, name, index);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeRelationshipRow(row: unknown): RelationshipRow | undefined {
  const sourceId = readRequiredString(row, 'sourceId', 0);
  const targetId = readRequiredString(row, 'targetId', 3);
  if (sourceId === undefined || targetId === undefined) return undefined;

  const sourceName = readOptionalString(row, 'sourceName', 1);
  const sourceFilePath = readOptionalString(row, 'sourceFilePath', 2);
  const targetName = readOptionalString(row, 'targetName', 4);
  const targetFilePath = readOptionalString(row, 'targetFilePath', 5);

  return {
    sourceId,
    ...optionalField('sourceName', sourceName),
    ...optionalField('sourceFilePath', sourceFilePath),
    targetId,
    ...optionalField('targetName', targetName),
    ...optionalField('targetFilePath', targetFilePath),
    reason: readRowValue(row, 'reason', 6),
  };
}

function optionalField<const Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [K in Key]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { readonly [K in Key]?: string });
}

function stableDedupe<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(keyOf(value), value);
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}

const RELATIONSHIP_PROJECTION = `
  RETURN source.id AS sourceId, source.name AS sourceName, source.filePath AS sourceFilePath,
         target.id AS targetId, target.name AS targetName, target.filePath AS targetFilePath,
         r.reason AS reason
`;

/**
 * Read additive Spring proxy/advice metadata for context and impact results.
 *
 * The helper intentionally trusts only versioned reasons accepted by the
 * shared decoder. Other DECLARES edges (for example Spring Bean factories)
 * and malformed/forward-version evidence are ignored. Query failures are
 * fail-soft because older or partially upgraded indexes must remain readable.
 */
export async function querySpringAopMetadata(
  lbugPath: string,
  symbolId: string,
  symbolType: string,
): Promise<SpringAopMetadata | undefined> {
  if (!SUPPORTED_SYMBOL_TYPES.has(symbolType)) return undefined;

  try {
    const [outgoingAdviceRows, incomingAdviceRows, outgoingPointcutRows, incomingPointcutRows] =
      await Promise.all([
        executeParameterized(
          lbugPath,
          `MATCH (source {id: $symbolId})-[r:CodeRelation]->(target)
           WHERE r.type = 'ADVISED_BY'
             AND r.reason STARTS WITH 'spring-aop:v1:'
           ${RELATIONSHIP_PROJECTION}
           LIMIT 1001`,
          { symbolId },
        ),
        executeParameterized(
          lbugPath,
          `MATCH (source)-[r:CodeRelation]->(target {id: $symbolId})
           WHERE r.type = 'ADVISED_BY'
             AND r.reason STARTS WITH 'spring-aop:v1:'
           ${RELATIONSHIP_PROJECTION}
           LIMIT 1001`,
          { symbolId },
        ),
        executeParameterized(
          lbugPath,
          `MATCH (source {id: $symbolId})-[r:CodeRelation]->(target:CodeElement)
           WHERE r.type = 'DECLARES'
             AND r.reason STARTS WITH 'spring-aop:v1:'
           ${RELATIONSHIP_PROJECTION}
           LIMIT 1001`,
          { symbolId },
        ),
        executeParameterized(
          lbugPath,
          `MATCH (source)-[r:CodeRelation]->(target:CodeElement {id: $symbolId})
           WHERE r.type = 'DECLARES'
             AND r.reason STARTS WITH 'spring-aop:v1:'
           ${RELATIONSHIP_PROJECTION}
           LIMIT 1001`,
          { symbolId },
        ),
      ]);

    const behaviors: SpringAopBehaviorMetadata[] = [];
    const advices: SpringAopAdviceMetadata[] = [];
    const unresolvedPointcuts: SpringAopUnresolvedPointcutMetadata[] = [];
    const aspects: SpringAopAspectMetadata[] = [];
    const truncated = [
      outgoingAdviceRows,
      incomingAdviceRows,
      outgoingPointcutRows,
      incomingPointcutRows,
    ].some((rows) => rows.length >= QUERY_FETCH_LIMIT);
    let queriedSymbolIsAdvisedSource = false;

    for (const [rows, isOutgoing] of [
      [outgoingAdviceRows, true],
      [incomingAdviceRows, false],
    ] as const) {
      for (const rawRow of rows.slice(0, QUERY_RESULT_LIMIT)) {
        const row = normalizeRelationshipRow(rawRow);
        if (row === undefined) continue;
        const reason = decodeSpringAopReason(row.reason);
        if (reason?.kind === 'behavior') {
          if (isOutgoing) queriedSymbolIsAdvisedSource = true;
          behaviors.push({
            annotation: reason.annotation,
            behavior: reason.behavior,
            declaredOn: reason.declaredOn,
            activation: reason.activation,
            evidenceId: row.targetId,
          });
        } else if (reason?.kind === 'advice') {
          if (isOutgoing) queriedSymbolIsAdvisedSource = true;
          advices.push({
            annotation: reason.annotation,
            advice: reason.advice,
            pointcut: reason.pointcut,
            match: reason.match,
            activation: reason.activation,
            adviceId: row.targetId,
            ...optionalField('adviceName', row.targetName),
            ...optionalField('adviceFilePath', row.targetFilePath),
            advisedId: row.sourceId,
            ...optionalField('advisedName', row.sourceName),
            ...optionalField('advisedFilePath', row.sourceFilePath),
          });
        }
      }
    }

    for (const rows of [outgoingPointcutRows, incomingPointcutRows]) {
      for (const rawRow of rows.slice(0, QUERY_RESULT_LIMIT)) {
        const row = normalizeRelationshipRow(rawRow);
        if (row === undefined) continue;
        const reason = decodeSpringAopReason(row.reason);
        if (reason?.kind === 'aspect') {
          aspects.push({
            annotation: reason.annotation,
            activation: reason.activation,
            registration: reason.registration,
            evidenceId: row.targetId,
          });
        } else if (reason?.kind === 'pointcut' && reason.match === 'unresolved') {
          unresolvedPointcuts.push({
            annotation: reason.annotation,
            pointcut: reason.pointcut,
            adviceId: row.sourceId,
            ...optionalField('adviceName', row.sourceName),
            ...optionalField('adviceFilePath', row.sourceFilePath),
            evidenceId: row.targetId,
          });
        }
      }
    }

    const dedupedAspects = stableDedupe(aspects, (aspect) =>
      JSON.stringify([aspect.annotation, aspect.evidenceId]),
    );

    const dedupedBehaviors = stableDedupe(behaviors, (behavior) =>
      JSON.stringify([
        behavior.behavior,
        behavior.annotation,
        behavior.declaredOn,
        behavior.evidenceId,
      ]),
    );
    const dedupedAdvices = stableDedupe(advices, (advice) =>
      JSON.stringify([advice.advisedId, advice.adviceId, advice.advice, advice.pointcut]),
    );
    const dedupedPointcuts = stableDedupe(unresolvedPointcuts, (pointcut) =>
      JSON.stringify([
        pointcut.adviceId,
        pointcut.evidenceId,
        pointcut.annotation,
        pointcut.pointcut,
      ]),
    );

    if (
      dedupedAspects.length === 0 &&
      dedupedBehaviors.length === 0 &&
      dedupedAdvices.length === 0 &&
      dedupedPointcuts.length === 0
    ) {
      return undefined;
    }

    return {
      framework: 'spring',
      ...(queriedSymbolIsAdvisedSource ? { proxied: 'possible' as const } : {}),
      ...(truncated ? { truncated: true as const } : {}),
      ...(dedupedAspects[0] === undefined ? {} : { aspect: dedupedAspects[0] }),
      behaviors: dedupedBehaviors,
      advices: dedupedAdvices,
      unresolvedPointcuts: dedupedPointcuts,
    };
  } catch {
    return undefined;
  }
}

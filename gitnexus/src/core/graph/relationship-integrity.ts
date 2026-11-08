import fs from 'node:fs';
import path from 'node:path';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { logger } from '../logger.js';

/** Counts describe ingestion checks, not final database row counts. */
export interface RelationshipIntegrityReceipt {
  version: 1;
  checkedSites: number;
  unverifiedEdges: number;
  duplicatesSuppressed: number;
}

const REFERENCE_TYPES = new Set(['CALLS', 'ACCESSES', 'USES', 'EXTENDS', 'IMPLEMENTS', 'INHERITS']);

/** Validate before either writer discards the source span encoded in a reference ID.
 * Non-reference and legacy/derived IDs have no source-site claim to validate.
 * They must never acquire a verified source-site receipt by inference.
 */
export function createRelationshipIntegrityCollector(
  repoPath: string,
  getNode: (id: string) => GraphNode | undefined,
  referenceSourceText?: (filePath: string, sourceText: string) => string | null | undefined,
) {
  const receipt: RelationshipIntegrityReceipt = {
    version: 1,
    checkedSites: 0,
    unverifiedEdges: 0,
    duplicatesSuppressed: 0,
  };
  const unverifiedByReason = {
    opaqueIdentity: 0,
    collapsedIdentity: 0,
    pointOnly: 0,
    extractedCoordinates: 0,
    partialMapping: 0,
  };
  const unverified = (
    rel: GraphRelationship,
    duplicate: boolean,
    reason: keyof typeof unverifiedByReason,
  ) => {
    if (duplicate) {
      receipt.duplicatesSuppressed++;
      return;
    }
    receipt.unverifiedEdges++;
    unverifiedByReason[reason]++;
    // At most one example per reason per analysis, even with debug enabled.
    if (unverifiedByReason[reason] === 1)
      logger.debug(
        {
          event: 'graph_reference_unverified',
          repoPath,
          reason,
          relationshipId: rel.id,
          relationshipType: rel.type,
          sourceId: rel.sourceId,
          targetId: rel.targetId,
          sourceFile: getNode(rel.sourceId)?.properties.filePath,
          emissionReason: rel.reason,
        },
        'Source-reference provenance is unverified',
      );
  };
  // Emission is normally grouped by source file. Keep only bounded line-size
  // metadata, and compute UTF-8 lengths once even for long/minified lines.
  const sourceLines = new Map<
    string,
    { byteLengths: number[] | null; originalCoordinates: boolean }
  >();
  const root = path.resolve(repoPath);
  let failure: Error | undefined;

  const inspect = (
    rel: GraphRelationship,
    duplicate: boolean,
    conflictingIdentity = false,
  ): void => {
    if (failure) throw failure;
    const fail = (reason: string): never => {
      // The stack identifies the emitting pass as well as the writer.
      failure ??= new Error(
        `Invalid graph reference ${rel.id}: ${reason}; source=${rel.sourceId}; target=${rel.targetId}`,
      );
      logger.error(
        {
          event: 'graph_reference_rejected',
          repoPath,
          reason,
          relationshipId: rel.id,
          relationshipType: rel.type,
          sourceId: rel.sourceId,
          targetId: rel.targetId,
          sourceFile: getNode(rel.sourceId)?.properties.filePath,
          emissionReason: rel.reason,
          err: failure,
        },
        'Rejected invalid graph relationship before writing',
      );
      throw failure;
    };
    if (conflictingIdentity) fail('relationship identity contradicts an existing record');
    if (
      !REFERENCE_TYPES.has(rel.type) &&
      !/^rel:(CALLS|ACCESSES|USES|EXTENDS|IMPLEMENTS|INHERITS):/.test(rel.id)
    )
      return;
    const prefix = `rel:${rel.type}:`;
    if (!rel.id.startsWith(prefix)) {
      if (/^rel:(CALLS|ACCESSES|USES|EXTENDS|IMPLEMENTS|INHERITS):/.test(rel.id)) {
        fail('relationship identity contradicts its type');
      }
      unverified(rel, duplicate, 'opaqueIdentity');
      return;
    }
    const pair = `${prefix}${rel.sourceId}->${rel.targetId}`;
    if (!rel.id.startsWith(pair) || (rel.id.length > pair.length && rel.id[pair.length] !== ':')) {
      fail('relationship identity contradicts its endpoints');
    }
    let tail = rel.id.slice(pair.length);
    if (rel.type === 'ACCESSES') {
      const access = /^:(read|write)/.exec(tail);
      if (access) tail = tail.slice(access[0].length);
      else if (tail) fail('source access identity is missing its read/write kind');
    }
    // Explicit caller/target aggregation has no site span. Existing indexes
    // and emitters with only a start position also remain unverified.
    if (!tail) {
      unverified(rel, duplicate, 'collapsedIdentity');
      return;
    }
    const parts = tail.slice(1).split(':');
    if (parts.length !== 2 && parts.length !== 4) fail('invalid source-span identity');
    if (parts.some((part) => !/^\d+$/.test(part))) fail('source coordinates must be integers');
    const [line, col, endLine = line, endCol = col] = parts.map(Number);
    if (parts.some((part) => String(Number(part)) !== part))
      fail('non-canonical source coordinates');
    if (
      ![line, col, endLine, endCol].every(Number.isSafeInteger) ||
      line < 1 ||
      col < 0 ||
      endLine < 1 ||
      endCol < 0
    )
      fail('invalid source coordinates (lines are one-based, columns zero-based)');
    const source = getNode(rel.sourceId);
    const filePath = source?.properties.filePath;
    if (!filePath || !getNode(rel.targetId)) fail('source or target node is missing');
    const fullPath = path.resolve(root, filePath!);
    const relative = path.relative(root, fullPath);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      fail('source file is outside the indexed repository');
    }
    let sourceBuffer = sourceLines.get(fullPath);
    if (!sourceBuffer) {
      try {
        const text = fs.readFileSync(fullPath, 'utf8');
        const extracted = referenceSourceText?.(filePath!, text);
        sourceBuffer = {
          byteLengths:
            extracted === null
              ? null
              : (extracted ?? text).split('\n').map((line) => Buffer.byteLength(line, 'utf8')),
          originalCoordinates: extracted === undefined,
        };
      } catch {
        fail(`source file cannot be read: ${filePath}`);
      }
      if (sourceLines.size >= 4) sourceLines.delete(sourceLines.keys().next().value!);
      sourceLines.set(fullPath, sourceBuffer!);
    }
    const { byteLengths, originalCoordinates } = sourceBuffer!;
    // Partially mapped coordinates do not describe a range in one buffer.
    // Keep their identity, but never certify their ordering or source bounds.
    if (byteLengths === null) {
      unverified(rel, duplicate, 'partialMapping');
      return;
    }
    if (endLine < line || (endLine === line && endCol < col))
      fail('invalid source coordinate ordering');
    if (
      endLine > byteLengths.length ||
      col > (byteLengths[line - 1] ?? 0) ||
      endCol > (byteLengths[endLine - 1] ?? 0)
    )
      fail(`source span is outside ${filePath}:${line}:${col}-${endLine}:${endCol}`);
    if (parts.length !== 4 || !originalCoordinates) {
      unverified(rel, duplicate, originalCoordinates ? 'pointOnly' : 'extractedCoordinates');
    } else if (duplicate) receipt.duplicatesSuppressed++;
    else receipt.checkedSites++;
  };
  return {
    inspect,
    logSummary: (): void => {
      if (failure) throw failure;
      logger.info(
        {
          event: 'graph_reference_integrity',
          repoPath,
          ...receipt,
          status: receipt.unverifiedEdges === 0 ? 'verified' : 'unverified',
          unverifiedByReason: { ...unverifiedByReason },
        },
        'Source-reference ingestion checks completed (not a database publication receipt)',
      );
    },
    snapshot: (): RelationshipIntegrityReceipt => {
      // A caller may isolate a failed pass. It still cannot publish a clean
      // receipt for a graph whose validator rejected a record.
      if (failure) throw failure;
      return { ...receipt };
    },
  };
}

/** Old/malformed receipts must not turn absent provenance into an all-clear. */
export function relationshipIntegrityForCaller(value: unknown) {
  const record = value as Partial<RelationshipIntegrityReceipt> | null | undefined;
  const valid =
    record?.version === 1 &&
    [record.checkedSites, record.unverifiedEdges, record.duplicatesSuppressed].every(
      (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
    );
  if (!valid) {
    return {
      status: 'unverified' as const,
      scope: 'source-reference-ingestion' as const,
      note: 'This index has no valid ingestion provenance receipt. Distinct context references do not prove that stored edges came from different source locations. Run analyze --force to run ingestion checks.',
    };
  }
  return {
    status: record!.unverifiedEdges === 0 ? ('verified' as const) : ('unverified' as const),
    scope: 'source-reference-ingestion' as const,
    checkedSites: record!.checkedSites!,
    unverifiedEdges: record!.unverifiedEdges!,
    duplicatesSuppressed: record!.duplicatesSuppressed!,
    note:
      record!.unverifiedEdges === 0
        ? 'Source-reference identities and source spans were checked before writing. This validates ingestion provenance, not resolution accuracy or query completeness.'
        : 'Some reference edges have only a caller/target identity, extracted-buffer coordinates, or incomplete source provenance. Their original source-site distinctness is unverified; query deduplication is not an integrity check.',
  };
}

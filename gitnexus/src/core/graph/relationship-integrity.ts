import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
const REFERENCE_ID_PREFIX = new RegExp(`^rel:(${[...REFERENCE_TYPES].join('|')}):`);

export class GraphReferenceIntegrityError extends Error {}

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
    sourceChanged: 0,
    sourceUnavailable: 0,
    missingSourceSnapshot: 0,
  };
  const unverified = (
    rel: GraphRelationship,
    duplicate: boolean,
    reason: keyof typeof unverifiedByReason,
    readErrorCode?: string,
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
          readErrorCode,
        },
        'Source-reference provenance is unverified',
      );
  };
  // Emission is normally grouped by source file. Keep only bounded line-size
  // metadata in node-tree-sitter's UTF-16 column units.
  const sourceLines = new Map<
    string,
    { columnLengths: number[] | null; originalCoordinates: boolean }
  >();
  // Hash the exact worker/cache input, never a later scan of the working tree.
  // Bounds remain a bounded cache; retaining every source line would scale
  // memory with the entire repository.
  const sourceHashes = new Map<string, string>();
  const unavailableSources = new Map<
    string,
    { reason: 'sourceChanged' | 'sourceUnavailable'; code?: string }
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
      failure ??= new GraphReferenceIntegrityError(
        `Invalid graph reference ${rel.id}: ${reason}; source=${rel.sourceId}; target=${rel.targetId}`.replace(
          /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
          (char) => {
            const hex = char.codePointAt(0)!.toString(16);
            return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
          },
        ),
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
    const hasReferenceIdentity = REFERENCE_ID_PREFIX.test(rel.id);
    if (!REFERENCE_TYPES.has(rel.type) && !hasReferenceIdentity) return;
    const prefix = `rel:${rel.type}:`;
    if (!rel.id.startsWith(prefix)) {
      if (hasReferenceIdentity) {
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
      const access = /^:(read|write)(?=:|$)/.exec(tail);
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
    // Even partially mapped coordinates must preserve line order.
    if (endLine < line) fail('invalid source coordinate ordering');
    const sourceHash = sourceHashes.get(filePath!);
    if (sourceHash === undefined) {
      unverified(rel, duplicate, 'missingSourceSnapshot');
      return;
    }
    const unavailable = unavailableSources.get(fullPath);
    if (unavailable) {
      unverified(rel, duplicate, unavailable.reason, unavailable.code);
      return;
    }
    let sourceBuffer = sourceLines.get(fullPath);
    if (!sourceBuffer) {
      let text: string;
      try {
        text = fs.readFileSync(fullPath, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        unavailableSources.set(fullPath, { reason: 'sourceUnavailable', code });
        unverified(rel, duplicate, 'sourceUnavailable', code);
        return;
      }
      if (createHash('sha256').update(text).digest('hex') !== sourceHash) {
        unavailableSources.set(fullPath, { reason: 'sourceChanged' });
        unverified(rel, duplicate, 'sourceChanged');
        return;
      }
      const extracted = referenceSourceText?.(filePath!, text);
      sourceBuffer = {
        columnLengths:
          extracted === null ? null : (extracted ?? text).split('\n').map((line) => line.length),
        originalCoordinates: extracted === undefined,
      };
      if (sourceLines.size >= 4) sourceLines.delete(sourceLines.keys().next().value!);
      sourceLines.set(fullPath, sourceBuffer!);
    }
    const { columnLengths, originalCoordinates } = sourceBuffer!;
    // Partially mapped coordinates do not describe a range in one buffer.
    // Keep their identity, but never certify their columns or source bounds.
    if (columnLengths === null) {
      unverified(rel, duplicate, 'partialMapping');
      return;
    }
    if (endLine === line && endCol < col) fail('invalid source coordinate ordering');
    if (
      endLine > columnLengths.length ||
      col > (columnLengths[line - 1] ?? 0) ||
      endCol > (columnLengths[endLine - 1] ?? 0)
    )
      fail(`source span is outside ${filePath}:${line}:${col}-${endLine}:${endCol}`);
    if (parts.length !== 4 || !originalCoordinates) {
      unverified(rel, duplicate, originalCoordinates ? 'pointOnly' : 'extractedCoordinates');
    } else if (duplicate) receipt.duplicatesSuppressed++;
    else receipt.checkedSites++;
  };
  return {
    inspect,
    recordSourceHash: (filePath: string, hash: string): void => {
      sourceHashes.set(filePath, hash);
      sourceLines.delete(path.resolve(root, filePath));
      unavailableSources.delete(path.resolve(root, filePath));
    },
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
export function relationshipIntegrityForCaller(
  value: unknown,
  unavailable?: 'generation-changed' | 'metadata-unreadable',
) {
  if (unavailable) {
    return {
      status: 'unverified' as const,
      scope: 'source-reference-ingestion' as const,
      note:
        unavailable === 'generation-changed'
          ? 'The index generation changed during this call. Retry the tool to obtain a result and provenance receipt from the same generation.'
          : 'The ingestion provenance metadata could not be read. Retry the tool; if this persists, inspect the index metadata and filesystem permissions.',
    };
  }
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

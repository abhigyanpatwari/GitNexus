import path from 'node:path';
import { createHash } from 'node:crypto';
import { executeParameterized } from '../lbug/pool-adapter.js';
import { assertQueryIdentity, assertSymbolFilePath } from '../lbug/query-result-integrity.js';
import type { TypeImportAttribution } from '../ingestion/language-provider.js';
import { isTestFilePath } from '../ingestion/utils/test-file-path.js';
import { readSafeBoundedBytes } from '../group/extractors/fs-utils.js';
import { contentRetentionFromMeta } from '../content-retention.js';
import { DOCUMENTATION_LINK_REASON } from '../graph/edge-reasons.js';
import { segmentCjkSpans } from '../search/cjk-segmentation.js';
import { chunk } from '../../lib/utils.js';
import { loadMeta } from '../../storage/repo-meta.js';
import { metadataMatchesGraph } from '../../storage/vector-generation.js';

// A module IMPORTS edge has no member identity. Inspect only incoming files
// whose retained source could import the named type, using source from the same index.
const maxCandidates = 8192;
const maxFileBytes = 128 * 1024;
const maxTotalChars = 8 * 1024 * 1024;
const maxImportPaths = 65_536;

interface Importer {
  id: string;
  name: string;
  filePath: string;
  confidence: number | null;
  chars: number;
}

interface Snapshot {
  lbugPath: string;
  repoPath: string;
  indexedAt: string;
  generationUnknown?: boolean;
}

async function indexedHashes(repo: Snapshot, candidates: Importer[], ownerPath: string) {
  const dir = path.dirname(repo.lbugPath);
  const meta = await loadMeta(dir);
  if (
    repo.generationUnknown ||
    !meta?.fileHashes ||
    meta.indexedAt !== repo.indexedAt ||
    !metadataMatchesGraph(dir, meta, repo.lbugPath) ||
    contentRetentionFromMeta(meta) !== 'full'
  )
    return;
  // The full ingestion manifest can be large. Retain only the requested receipts
  // while reading source and traversing the remaining candidate batches.
  const hashes = meta.fileHashes;
  return new Map(
    [ownerPath, ...candidates.map((row) => row.filePath)].map((file) => [file, hashes[file]]),
  );
}

export async function findTypeImporters(
  repo: Snapshot,
  attribution: TypeImportAttribution,
  ownerId: string,
  ownerPath: string,
  name: string,
  includeTests: boolean,
  minConfidence: number,
) {
  const db = repo.lbugPath;
  const implicit = attribution.implicitImportSyntax;
  // The primary-key lookup on owner narrows both traversals. Inspect the
  // importer's other resolved modules to distinguish same-named imports.
  const rows = (await executeParameterized(
    db,
    `
    MATCH (caller:File)-[link:CodeRelation]->(owner:File {id:$ownerId})
    WHERE link.type = 'IMPORTS' AND (link.reason IS NULL OR link.reason <> $documentationLink)
      ${minConfidence > 0 ? 'AND link.confidence >= $minConfidence' : ''}
      AND (caller.content IS NULL OR caller.content = '' OR caller.content CONTAINS $name
           ${implicit ? 'OR (caller.content CONTAINS $marker AND regexp_matches(caller.content, $pattern))' : ''})
    WITH caller, link.confidence AS confidence, size(coalesce(caller.content, '')) AS chars
    ORDER BY caller.id LIMIT ${maxCandidates + 1}
    MATCH (caller)-[r:CodeRelation]->(other:File)
    WHERE r.type = 'IMPORTS' AND (r.reason IS NULL OR r.reason <> $documentationLink)
    RETURN caller.id AS id, caller.name AS name, caller.filePath AS filePath, confidence, chars, other.filePath AS importedPath
    ORDER BY caller.id, other.id LIMIT ${maxImportPaths + 1}`,
    {
      ownerId,
      // Each token occurs in both raw and bigram-indexed content. Use the longest
      // as a selective prefilter, then verify the full name in hashed source.
      name: segmentCjkSpans(name)
        .trim()
        .split(/\s+/)
        .reduce((best, token) => (token.length > best.length ? token : best)),
      documentationLink: DOCUMENTATION_LINK_REASON,
      ...(implicit && { marker: implicit.marker, pattern: implicit.pattern }),
      ...(minConfidence > 0 && { minConfidence }),
    },
  )) as (Importer & { importedPath: string })[];
  // The sentinel's caller might have additional paths past the limit. Every
  // earlier caller group is complete because the two limits are ordered.
  const incompleteCaller = rows[maxImportPaths]?.id;
  const candidates: (Importer & { paths: Set<string> })[] = [];
  for (const row of rows) {
    assertQueryIdentity(row, 'id', 0, [
      ['name', 1],
      ['filePath', 2],
      ['importedPath', 5],
    ]);
    assertSymbolFilePath(row.id, row.filePath);
    if (row.id === incompleteCaller) break;
    const previous = candidates.at(-1);
    if (previous?.id === row.id) previous.paths.add(row.importedPath);
    else candidates.push({ ...row, paths: new Set([row.importedPath]) });
  }
  let complete = incompleteCaller === undefined && candidates.length <= maxCandidates;
  const matches: Importer[] = [];
  let charsRemaining = maxTotalChars;
  const selected = candidates.slice(0, maxCandidates).filter((row) => {
    if (!includeTests && isTestFilePath(row.filePath)) return false;
    const chars = Number(row.chars);
    if (
      !attribution.supportsFile(row.filePath) ||
      !chars ||
      chars > maxFileBytes ||
      chars > charsRemaining
    ) {
      complete = false;
      return false;
    }
    charsRemaining -= chars;
    return true;
  });
  if (selected.length === 0) return { matches, complete };
  // Bulk-loaded File.content can have flattened line endings. Use it only as a
  // candidate filter. Parse checkout bytes only when the same graph generation's
  // SHA-256 receipt proves their identity, including in a dirty or shared checkout.
  const hashes = await indexedHashes(repo, selected, ownerPath);
  if (!hashes) return { matches, complete: false };
  const readIndexed = async (file: string, maxBytes = maxFileBytes) => {
    const hash = hashes.get(file);
    if (!hash) return undefined;
    const bytes = await readSafeBoundedBytes(repo.repoPath, file, maxBytes);
    if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== hash)
      return undefined;
    return bytes.toString('utf8');
  };
  const classify = await attribution.createClassifier({
    ownerPath,
    name,
    readOwner: () => readIndexed(ownerPath),
  });
  // Bound open descriptors and resident source independently of the graph limit.
  for (const files of chunk(selected, 32)) {
    // UTF-8 uses at most four bytes per character. A changed checkout cannot
    // turn the bounded indexed character budget into an unbounded disk read.
    const sources = await Promise.all(
      files.map((row) => readIndexed(row.filePath, Math.min(maxFileBytes, 4 * Number(row.chars)))),
    );
    for (const [index, row] of files.entries()) {
      const source = sources[index];
      const result = source ? await classify(row.filePath, source, row.paths) : undefined;
      if (result === true) matches.push(row);
      else if (result === undefined) complete = false;
    }
  }
  return { matches, complete };
}

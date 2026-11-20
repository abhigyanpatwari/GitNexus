import path from 'node:path';
import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { assertQueryIdentity, assertSymbolFilePath } from '../../core/lbug/query-result-integrity.js';
import { splitImportStatement } from '../../core/ingestion/languages/python/import-decomposer.js';
import { interpretPythonImport } from '../../core/ingestion/languages/python/interpret.js';
import {
  resolvePythonImportTarget,
  isPythonImportedModule,
} from '../../core/ingestion/languages/python/import-target.js';
import { pythonLiteralAll } from '../../core/ingestion/languages/python/module-accessors.js';
import { walkNamedNodes } from '../../core/ingestion/languages/rename-tree-sitter.js';
import { isTestFilePath } from '../../core/ingestion/utils/test-file-path.js';
import { createParserForLanguage } from '../../core/tree-sitter/parser-loader.js';
import { parseSourceSafe, ParseTimeoutError } from '../../core/tree-sitter/safe-parse.js';
import { chunk } from '../../lib/utils.js';
import { readSafeBounded } from '../../core/group/extractors/fs-utils.js';
import { contentRetentionFromMeta } from '../../core/content-retention.js';
import { loadMeta } from '../../storage/repo-meta.js';
import { metadataMatchesGraph } from '../../storage/vector-generation.js';

// A module IMPORTS edge has no member identity. Inspect only its incoming Python
// files that could spell the class or use a wildcard, using source from the same index.
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

async function importsClass(
  root: Parser.SyntaxNode,
  fromFile: string,
  importedPaths: Set<string>,
  owner: string,
  className: string,
  wildcardExport: () => Promise<boolean | undefined>,
): Promise<boolean | undefined> {
  if (root.hasError) return undefined;
  const context = { fromFile, allFilePaths: importedPaths };
  const moduleAliases = new Map<string, Set<number>>();
  const receivers = new Map<string, Parser.SyntaxNode[]>();
  const otherBindings = new Set<string>();
  const importScope = (node: Parser.SyntaxNode): Parser.SyntaxNode => {
    while (
      node.parent &&
      !['function_definition', 'class_definition', 'lambda'].includes(node.type)
    )
      node = node.parent;
    return node;
  };
  let endOfImport = -1;
  let wildcard = false;
  for (const node of walkNamedNodes(root)) {
    // Visiting imports in syntax order lets us skip their child identifiers:
    // their bindings are accounted for by the provider's import decomposer.
    if (node.startIndex < endOfImport) continue;
    if (
      node.type === 'identifier' &&
      node.parent?.type !== 'attribute' &&
      node.parent?.type !== 'dotted_name' &&
      node.parent?.type !== 'keyword_argument'
    )
      otherBindings.add(node.text);
    if (node.type === 'attribute' && node.childForFieldName('attribute')?.text === className) {
      const receiver = node.childForFieldName('object')?.text;
      if (receiver) {
        const uses = receivers.get(receiver);
        if (uses) uses.push(node);
        else receivers.set(receiver, [node]);
      }
    }
    if (node.type !== 'import_statement' && node.type !== 'import_from_statement') continue;
    endOfImport = node.endIndex;
    for (const match of splitImportStatement(node)) {
      const imp = interpretPythonImport(match);
      if (!imp) continue;
      let alias: string | undefined;
      if (imp.kind === 'named' || imp.kind === 'alias') {
        if (
          imp.importedName === className &&
          resolvePythonImportTarget({ ...imp, targetIncludesImportedName: true }, context) === owner
        )
          return true;
        if (
          resolvePythonImportTarget(imp, context) === owner &&
          isPythonImportedModule(imp, owner, fromFile)
        )
          alias = imp.localName;
      } else if (imp.kind === 'namespace' && resolvePythonImportTarget(imp, context) === owner) {
        alias = imp.explicitAlias ? imp.localName : imp.targetRaw;
      } else if (imp.kind === 'wildcard' && resolvePythonImportTarget(imp, context) === owner) {
        wildcard = true;
      }
      if (alias) {
        const scopes = moduleAliases.get(alias);
        const scopeId = importScope(node).id;
        if (scopes) scopes.add(scopeId);
        else moduleAliases.set(alias, new Set([scopeId]));
      } else if ('localName' in imp) {
        otherBindings.add(imp.localName);
      }
    }
  }
  let uncertain = false;
  for (const [alias, scopes] of moduleAliases) {
    const uses = receivers.get(alias);
    if (!uses) continue;
    // Only admit a qualified use with a visible import and an unambiguous
    // receiver. Other bare uses may be bindings (a parameter, assignment, etc.).
    if (
      !otherBindings.has(alias.split('.')[0]) &&
      (scopes.has(root.id) || uses.some((use) => scopes.has(importScope(use).id)))
    )
      return true;
    uncertain = true;
  }
  if (wildcard) {
    const exported = await wildcardExport();
    if (exported !== false) return exported;
  }
  return uncertain ? undefined : false;
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

export async function pythonClassImporters(
  repo: Snapshot,
  ownerId: string,
  ownerPath: string,
  className: string,
  includeTests: boolean,
  minConfidence: number,
) {
  const db = repo.lbugPath;
  // The primary-key lookup on owner narrows both traversals. Inspect the
  // importer's other resolved modules to distinguish same-named imports.
  const rows = (await executeParameterized(
    db,
    `
    MATCH (caller:File)-[link:CodeRelation]->(owner:File {id:$ownerId})
    WHERE link.type = 'IMPORTS'
      ${minConfidence > 0 ? 'AND link.confidence >= $minConfidence' : ''}
      AND (caller.content IS NULL OR caller.content = '' OR caller.content CONTAINS $className
           OR (caller.content CONTAINS '*' AND regexp_matches(caller.content, $wildcardPattern)))
    WITH caller, link.confidence AS confidence, size(coalesce(caller.content, '')) AS chars
    ORDER BY caller.id LIMIT ${maxCandidates + 1}
    MATCH (caller)-[r:CodeRelation]->(other:File)
    WHERE r.type = 'IMPORTS'
    RETURN caller.id AS id, caller.name AS name, caller.filePath AS filePath, confidence, chars, other.filePath AS importedPath
    ORDER BY caller.id, other.id LIMIT ${maxImportPaths + 1}`,
    {
      ownerId,
      className,
      wildcardPattern: 'import[^a-zA-Z0-9_]*[*]',
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
    if (!row.filePath.endsWith('.py') || !chars || chars > maxFileBytes || chars > charsRemaining) {
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
    const source = await readSafeBounded(repo.repoPath, file, maxBytes);
    if (source === null || createHash('sha256').update(source).digest('hex') !== hash)
      return undefined;
    return source;
  };
  const parser = await createParserForLanguage(SupportedLanguages.Python);
  const parseRoot = (source: string) => {
    try {
      return parseSourceSafe(parser, source).rootNode;
    } catch (error) {
      if (error instanceof ParseTimeoutError) return undefined;
      throw error;
    }
  };
  let wildcard: Promise<boolean | undefined> | undefined;
  const wildcardExport = async () => {
    const source = await readIndexed(ownerPath);
    if (!source) return undefined;
    if (!source.includes('__all__')) return !className.startsWith('_');
    const root = parseRoot(source);
    if (!root || root.hasError) return undefined;
    return pythonLiteralAll(root)?.includes(className);
  };
  // Bound open descriptors and resident source independently of the graph limit.
  for (const files of chunk(selected, 32)) {
    // UTF-8 uses at most four bytes per character. A changed checkout cannot
    // turn the bounded indexed character budget into an unbounded disk read.
    const sources = await Promise.all(
      files.map((row) => readIndexed(row.filePath, Math.min(maxFileBytes, 4 * Number(row.chars)))),
    );
    for (const [index, row] of files.entries()) {
      const source = sources[index];
      const root = source ? parseRoot(source) : undefined;
      const result = root
        ? await importsClass(
            root,
            row.filePath,
            row.paths,
            ownerPath,
            className,
            () => (wildcard ??= wildcardExport()),
          )
        : undefined;
      if (result === true) matches.push(row);
      else if (result === undefined) complete = false;
    }
  }
  return { matches, complete };
}

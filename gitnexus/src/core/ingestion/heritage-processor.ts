/**
 * Heritage Processor
 *
 * Extracts class inheritance relationships:
 * - EXTENDS: Class extends another Class (TS, JS, Python, C#, C++)
 * - IMPLEMENTS: Class implements an Interface (TS, C#, Java, Kotlin, PHP)
 *
 * Languages like C# use a single `base_list` for both class and interface parents.
 * We resolve the correct edge type by checking the symbol table: if the parent is
 * registered as an Interface, we emit IMPLEMENTS; otherwise EXTENDS. For unresolved
 * external symbols, the fallback heuristic is language-gated:
 *   - C# / Java: apply the `I[A-Z]` naming convention (e.g. IDisposable → IMPLEMENTS)
 *   - Swift: default to IMPLEMENTS (protocol conformance is more common than class inheritance)
 *   - All other languages: default to EXTENDS
 */

import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import Parser from 'tree-sitter';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename } from './utils/language-detection.js';
import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { yieldToEventLoop } from './utils/event-loop.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { getProvider } from './languages/index.js';
import { getTreeSitterBufferSize } from './constants.js';
import type { ExtractedHeritage } from './workers/parse-worker.js';
import { collectGoImplementsHeritage, collectGoCompositionHeritage, collectGoMethodsFromAST, collectGoInterfaceMethods, collectGoImplementsCrossFile, type GoInterfaceMethodEntry, type GoCrossFileImplementsHeritageItem } from './workers/go-relationships.js';
import type { ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE } from './resolution-context.js';

/**
 * Determine whether a heritage.extends capture is actually an IMPLEMENTS relationship.
 * Uses the symbol table first (authoritative — Tier 1); falls back to provider-defined
 * heuristics for external symbols not present in the graph:
 *   - interfaceNamePattern: matched against parent name (e.g., /^I[A-Z]/ for C#/Java)
 *   - heritageDefaultEdge: 'IMPLEMENTS' causes all unresolved parents to map to IMPLEMENTS
 *   - All others: default EXTENDS
 */
const resolveExtendsType = (
  parentName: string,
  currentFilePath: string,
  ctx: ResolutionContext,
  language: SupportedLanguages,
): { type: 'EXTENDS' | 'IMPLEMENTS'; idPrefix: string } => {
  const resolved = ctx.resolve(parentName, currentFilePath);
  if (resolved && resolved.candidates.length > 0) {
    const isInterface = resolved.candidates[0].type === 'Interface';
    return isInterface
      ? { type: 'IMPLEMENTS', idPrefix: 'Interface' }
      : { type: 'EXTENDS', idPrefix: 'Class' };
  }
  // Unresolved symbol — fall back to provider-defined heuristics
  const provider = getProvider(language);
  if (provider.interfaceNamePattern?.test(parentName)) {
    return { type: 'IMPLEMENTS', idPrefix: 'Interface' };
  }
  if (provider.heritageDefaultEdge === 'IMPLEMENTS') {
    return { type: 'IMPLEMENTS', idPrefix: 'Interface' };
  }
  return { type: 'EXTENDS', idPrefix: 'Class' };
};

/**
 * Resolve a symbol ID for heritage, with fallback to generated ID.
 * Uses ctx.resolve() → pick first candidate's nodeId → generate synthetic ID.
 */
interface ResolvedHeritage {
  readonly id: string;
  readonly confidence: number;
}

/**
 * WI-4 (#159 P3 Mode A — heritage feed) — one element of the
 * heritage candidate feed passed into the session funnel.
 *
 * The reconciler re-resolves a heuristic heritage edge via
 * `textDocument/definition` at the **parent identifier**
 * position (line, character) and either confirms (same target),
 * corrects (different target), or refuses (label out of gate).
 *
 * Populated ONLY when ALL gates hold (WI-4 design contract):
 *   - `opts?.lsp && opts.heritageFeed` (the LSP gate)
 *   - TS-family file (the language gate)
 *   - `parent.confidence === 0.5` (the global/unresolved gate)
 *   - Position available (`line !== undefined`)
 *   - The edge was actually emitted (the dedup gate)
 *
 * `oldRelId` carries the exact heuristic edge id so a `correct`
 * action can remove that specific row even when multiple
 * (source, target) edges of the same type exist (the WI-1
 * line-aware multiplicity).
 */
export interface HeritageFeedItem {
  /** The child class node id (the `from` of the IMPLEMENTS / EXTENDS edge). */
  sourceId: string;
  /** The parent name as written at the heritage clause (e.g. `IUserRepo` in `class A implements IUserRepo`). */
  parentName: string;
  /** The heuristic target id (the synthetic or resolved parent node id). */
  oldTargetId: string;
  /** The id of the existing heuristic edge (used by `applyDecisions` to remove it on `correct`). */
  oldRelId: string;
  /** Edge family discriminator; matches `Candidate.relType`. */
  relType: 'IMPLEMENTS' | 'EXTENDS';
  /** Repo-relative POSIX file path. */
  file: string;
  /** 0-indexed line of the parent identifier. */
  line: number;
  /** 0-indexed character offset of the parent identifier start. */
  character: number;
}

/**
 * WI-4 (#159 P3 Mode A — heritage feed) — optional behaviors
 * gated behind `opts.lsp` so the default `analyze` (no flag)
 * stays byte-identical. The heritage feed is only pushed to
 * when `lsp:true` is passed.
 */
export interface ProcessHeritageOpts {
  /** When true, push heritage-feed entries for TS-family global/unresolved parents. */
  lsp?: boolean;
  /** Sink for heritage correction candidates. Required when `lsp:true` for the feed. */
  heritageFeed?: HeritageFeedItem[];
}

/**
 * WI-4 (#159 P3 Mode A — heritage feed) — TS-family gate.
 *
 * Heritage feed entries are ONLY pushed for TypeScript and
 * JavaScript files. The heritage LSP reconciliation is
 * TypeScript-only per the design (P3 of #159); a future slice
 * can extend this to other tree-sitter languages. The check is
 * a strict equality against the enum (not a regex on the
 * filename) so a non-TS-family language CANNOT accidentally
 * fall into the feed even when a file has a `.ts` extension
 * but parses as a different language.
 */
const isTsFamilyLanguage = (language: SupportedLanguages): boolean =>
  language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript;

/**
 * Type-1 (polish MAJOR) — narrow the
 * `collectGoImplementsCrossFile` return without an
 * unchecked `as` cast. Per the polish review: the bare
 * cast `crossFileItems as GoCrossFileImplementsHeritageItem[]`
 * masked future drift (a return-shape change would
 * silently flow into the graph mutator). The guard
 * narrows on the documented shape (the same shape the
 * producer is typed to mint) and refuses anything that
 * does not conform — the future-drift call site gets a
 * `tsc` error rather than a runtime surprise. The
 * guard is co-located near `isTsFamilyLanguage`; the
 * `GoCrossFileImplementsHeritageItem` interface itself
 * is in `workers/go-relationships.ts` (no need to move
 * it — it's the producer's contract).
 */
function isGoCrossFileImplementsHeritageItem(
  x: unknown,
): x is GoCrossFileImplementsHeritageItem {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.filePath === 'string' &&
    typeof r.className === 'string' &&
    typeof r.parentName === 'string' &&
    typeof r.parentFilePath === 'string' &&
    r.kind === 'cross-file-implements' &&
    typeof r.confidence === 'number'
  );
}

const resolveHeritageId = (
  name: string,
  filePath: string,
  ctx: ResolutionContext,
  fallbackLabel: string,
  fallbackKey?: string,
): ResolvedHeritage => {
  const resolved = ctx.resolve(name, filePath);
  if (resolved && resolved.candidates.length > 0) {
    // For global with multiple candidates, refuse (a wrong edge is worse than no edge)
    if (resolved.tier === 'global' && resolved.candidates.length > 1) {
      return { id: generateId(fallbackLabel, fallbackKey ?? name), confidence: TIER_CONFIDENCE['global'] };
    }
    return { id: resolved.candidates[0].nodeId, confidence: TIER_CONFIDENCE[resolved.tier] };
  }
  // Unresolved: use global-tier confidence as fallback
  return { id: generateId(fallbackLabel, fallbackKey ?? name), confidence: TIER_CONFIDENCE['global'] };
};

export const processHeritage = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  opts?: ProcessHeritageOpts,
) => {
  const parser = await loadParser();
  const logSkipped = isVerboseIngestionEnabled();
  const skippedByLang = logSkipped ? new Map<string, number>() : null;

  // Pre-pass (WI-H85): parse all .go files up front and build a global
  // registry of Go interface method sets. The per-file loop below
  // reuses the ASTCache entries populated here, avoiding a second parse.
  // This registry enables the cross-file IMPLEMENTS detector to match
  // structs against interfaces defined in other files. The per-file
  // `collectGoImplementsHeritage` pass remains authoritative for
  // same-file pairs; this registry is additive.
  const goRootNodes = new Map<string, Parser.SyntaxNode>();
  const goGlobalRegistry: GoInterfaceMethodEntry[] = [];
  for (const f of files) {
    if (getLanguageFromFilename(f.path) !== SupportedLanguages.Go) continue;
    let tree = astCache.get(f.path);
    if (!tree) {
      try {
        tree = parser.parse(f.content, undefined, {
          bufferSize: getTreeSitterBufferSize(f.content.length),
        });
        astCache.set(f.path, tree);
      } catch {
        continue;
      }
    }
    goRootNodes.set(f.path, tree.rootNode);
  }
  if (goRootNodes.size > 0) {
    const registryEntries: Array<{ path: string; rootNode: Parser.SyntaxNode }> = [];
    for (const [p, rn] of goRootNodes) registryEntries.push({ path: p, rootNode: rn });
    goGlobalRegistry.push(...collectGoInterfaceMethods(registryEntries));
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);
    if (i % 20 === 0) await yieldToEventLoop();

    // 1. Check language support
    const language = getLanguageFromFilename(file.path);
    if (!language) continue;
    if (!isLanguageAvailable(language)) {
      if (skippedByLang) {
        skippedByLang.set(language, (skippedByLang.get(language) ?? 0) + 1);
      }
      continue;
    }

    const provider = getProvider(language);
    const queryStr = provider.treeSitterQueries;
    if (!queryStr) continue;

    // 2. Load the language
    await loadLanguage(language, file.path);

    // 3. Get AST
    let tree = astCache.get(file.path);
    if (!tree) {
      // Use larger bufferSize for files > 32KB
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
      } catch (parseError) {
        // Skip files that can't be parsed
        continue;
      }
      // Cache re-parsed tree for potential future use
      astCache.set(file.path, tree);
    }

    let query;
    let matches;
    try {
      const language = parser.getLanguage();
      query = new Parser.Query(language, queryStr);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Heritage query error for ${file.path}:`, queryError);
      continue;
    }

    // 4. Process heritage matches
    matches.forEach(match => {
      const captureMap: Record<string, any> = {};
      match.captures.forEach(c => {
        captureMap[c.name] = c.node;
      });

      // EXTENDS or IMPLEMENTS: resolve via symbol table for languages where
      // the tree-sitter query can't distinguish classes from interfaces (C#, Java)
      if (captureMap['heritage.class'] && captureMap['heritage.extends']) {
        // Go struct embedding: skip named fields (only anonymous fields are embedded)
        const extendsNode = captureMap['heritage.extends'];
        const fieldDecl = extendsNode.parent;
        if (fieldDecl?.type === 'field_declaration' && fieldDecl.childForFieldName('name')) {
          return; // Named field, not struct embedding
        }

        const className = captureMap['heritage.class'].text;
        const parentClassName = captureMap['heritage.extends'].text;

        // For Go (issue #26), anonymous struct fields emit a COMPOSITION edge
        // rather than EXTENDS. The composition pass below handles this for
        // the AST-based path. Skip the EXTENDS branch entirely for Go so
        // we don't double-emit.
        if (language === SupportedLanguages.Go) {
          return;
        }

        const { type: relType, idPrefix } = resolveExtendsType(parentClassName, file.path, ctx, language);

        const child = resolveHeritageId(className, file.path, ctx, 'Class', `${file.path}:${className}`);
        const parent = resolveHeritageId(parentClassName, file.path, ctx, idPrefix);

        if (child.id && parent.id && child.id !== parent.id) {
          const edgeId = generateId(relType, `${child.id}->${parent.id}`);
          graph.addRelationship({
            id: edgeId,
            sourceId: child.id,
            targetId: parent.id,
            type: relType,
            confidence: Math.sqrt(child.confidence * parent.confidence),
            reason: '',
            source: 'heuristic',
          });
          // WI-4 (#159 P3 Mode A — heritage feed): when the
          // LSP gate is on AND the file is TS-family AND the
          // parent resolved at the global/unresolved tier
          // (confidence 0.5) AND the parent-identifier position
          // is available, push a `HeritageFeedItem` so the
          // reconciler can re-resolve this edge against the
          // language server. The push is additive — the
          // default `analyze` (no `opts.lsp`) is byte-identical.
          if (
            opts?.lsp &&
            opts.heritageFeed &&
            parent.confidence === TIER_CONFIDENCE['global'] &&
            isTsFamilyLanguage(language) &&
            extendsNode.startPosition
          ) {
            opts.heritageFeed.push({
              sourceId: child.id,
              parentName: parentClassName,
              oldTargetId: parent.id,
              oldRelId: edgeId,
              relType,
              file: file.path,
              line: extendsNode.startPosition.row,
              character: extendsNode.startPosition.column,
            });
          }
        }
      }

      // IMPLEMENTS: Class implements Interface (TypeScript only)
      if (captureMap['heritage.class'] && captureMap['heritage.implements']) {
        const className = captureMap['heritage.class'].text;
        const interfaceName = captureMap['heritage.implements'].text;
        const implementsNode = captureMap['heritage.implements'];

        const cls = resolveHeritageId(className, file.path, ctx, 'Class', `${file.path}:${className}`);
        const iface = resolveHeritageId(interfaceName, file.path, ctx, 'Interface');

        if (cls.id && iface.id) {
          const edgeId = generateId('IMPLEMENTS', `${cls.id}->${iface.id}`);
          graph.addRelationship({
            id: edgeId,
            sourceId: cls.id,
            targetId: iface.id,
            type: 'IMPLEMENTS',
            confidence: Math.sqrt(cls.confidence * iface.confidence),
            reason: '',
            source: 'heuristic',
          });
          // WI-4 (#159 P3 Mode A — heritage feed): see the
          // extends branch above. Same gate. The position
          // is the implements-identifier start, not the
          // class start.
          if (
            opts?.lsp &&
            opts.heritageFeed &&
            iface.confidence === TIER_CONFIDENCE['global'] &&
            isTsFamilyLanguage(language) &&
            implementsNode.startPosition
          ) {
            opts.heritageFeed.push({
              sourceId: cls.id,
              parentName: interfaceName,
              oldTargetId: iface.id,
              oldRelId: edgeId,
              relType: 'IMPLEMENTS',
              file: file.path,
              line: implementsNode.startPosition.row,
              character: implementsNode.startPosition.column,
            });
          }
        }
      }

      // IMPLEMENTS (Rust): impl Trait for Struct
      if (captureMap['heritage.trait'] && captureMap['heritage.class']) {
        const structName = captureMap['heritage.class'].text;
        const traitName = captureMap['heritage.trait'].text;

        const strct = resolveHeritageId(structName, file.path, ctx, 'Struct', `${file.path}:${structName}`);
        const trait = resolveHeritageId(traitName, file.path, ctx, 'Trait');

        if (strct.id && trait.id) {
          graph.addRelationship({
            id: generateId('IMPLEMENTS', `${strct.id}->${trait.id}`),
            sourceId: strct.id,
            targetId: trait.id,
            type: 'IMPLEMENTS',
            confidence: Math.sqrt(strct.confidence * trait.confidence),
            reason: 'trait-impl',
            source: 'heuristic',
          });
        }
      }
    });

    // Go-specific post-pass for the AST-based path (issue #20 + #26).
    // The worker-based path runs the same helpers in parse-worker.ts; this
    // branch covers repos too small to spawn the worker pool
    // (MIN_FILES_FOR_WORKERS / MIN_BYTES_FOR_WORKERS not met).
    if (language === SupportedLanguages.Go) {
      // Build file symbols from the AST (Method nodes with receiver type).
      // The AST-based path doesn't have a global SymbolTable, so we compute
      // per-file method ownership inline.
      const fileSymbols = collectGoMethodsFromAST(tree.rootNode, file.path);
      const implementsItems = collectGoImplementsHeritage(file.path, tree.rootNode, fileSymbols);
      // Track same-file pairs for cross-file dedup (invariant 7).
      const sameFilePairs = new Set<string>();
      for (const it of implementsItems) {
        sameFilePairs.add(`${it.className}->${it.parentName}`);
        const child = resolveHeritageId(it.className, file.path, ctx, 'Struct', `${file.path}:${it.className}`);
        const iface = resolveHeritageId(it.parentName, file.path, ctx, 'Interface', `${file.path}:${it.parentName}`);
        if (child.id && iface.id && child.id !== iface.id) {
          graph.addRelationship({
            id: generateId('IMPLEMENTS', `${child.id}->${iface.id}`),
            sourceId: child.id,
            targetId: iface.id,
            type: 'IMPLEMENTS',
            confidence: Math.sqrt(child.confidence * iface.confidence),
            reason: 'method-set',
            source: 'heuristic',
          });
        }
      }
      // WI-H85 / Issue #85: cross-file Go IMPLEMENTS second pass.
      // The same-file pass above is authoritative for same-file pairs.
      // This second pass adds cross-file pairs at confidence 0.7 and
      // tags them with reason 'cross-file-structural-match' so callers
      // can distinguish the two sources.
      const crossFileItems = collectGoImplementsCrossFile(
        file.path,
        tree.rootNode,
        fileSymbols,
        goGlobalRegistry,
        sameFilePairs,
      );
      // Type-1 (polish MAJOR): filter the producer's
      // return through a type guard instead of a bare
      // `as` cast. Items that do not conform to the
      // documented `GoCrossFileImplementsHeritageItem`
      // shape (e.g. a future return-shape change) are
      // silently dropped here — the alternative is a
      // silent field-read of `undefined.className` that
      // would crash the ingestion with a confusing
      // message downstream. The guard is co-located
      // with `isTsFamilyLanguage` above; see its doc.
      for (const it of crossFileItems.filter(isGoCrossFileImplementsHeritageItem)) {
        const child = resolveHeritageId(it.className, file.path, ctx, 'Struct', `${file.path}:${it.className}`);
        const iface = resolveHeritageId(it.parentName, it.parentFilePath, ctx, 'Interface', `${it.parentFilePath}:${it.parentName}`);
        if (child.id && iface.id && child.id !== iface.id) {
          graph.addRelationship({
            id: generateId('IMPLEMENTS', `${child.id}->${iface.id}`),
            sourceId: child.id,
            targetId: iface.id,
            type: 'IMPLEMENTS',
            confidence: it.confidence,
            reason: 'cross-file-structural-match',
            source: 'heuristic',
          });
        }
      }
      const compositionItems = collectGoCompositionHeritage(file.path, tree.rootNode);
      for (const it of compositionItems) {
        const owner = resolveHeritageId(it.className, file.path, ctx, 'Struct', `${file.path}:${it.className}`);
        let embedded = resolveHeritageId(it.parentName, file.path, ctx, 'Struct', `${file.path}:${it.parentName}`);
        if (!embedded.id) {
          embedded = resolveHeritageId(it.parentName, file.path, ctx, 'Interface', `${file.path}:${it.parentName}`);
        }
        if (owner.id && embedded.id && owner.id !== embedded.id) {
          graph.addRelationship({
            id: generateId('COMPOSITION', `${owner.id}->${embedded.id}`),
            sourceId: owner.id,
            targetId: embedded.id,
            type: 'COMPOSITION',
            confidence: Math.sqrt(owner.confidence * embedded.confidence),
            reason: 'anonymous-field',
            source: 'heuristic',
          });
        }
      }
    }

    // Tree is now owned by the LRU cache — no manual delete needed
  }

  if (skippedByLang && skippedByLang.size > 0) {
    for (const [lang, count] of skippedByLang.entries()) {
      console.warn(
        `[ingestion] Skipped ${count} ${lang} file(s) in heritage processing — ${lang} parser not available.`
      );
    }
  }
};

/**
 * Fast path: resolve pre-extracted heritage from workers.
 * No AST parsing — workers already extracted className + parentName + kind.
 */
export const processHeritageFromExtracted = async (
  graph: KnowledgeGraph,
  extractedHeritage: ExtractedHeritage[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
  opts?: ProcessHeritageOpts,
) => {
  const total = extractedHeritage.length;

  for (let i = 0; i < extractedHeritage.length; i++) {
    if (i % 500 === 0) {
      onProgress?.(i, total);
      await yieldToEventLoop();
    }

    const h = extractedHeritage[i];

    if (h.kind === 'extends') {
      const fileLanguage = getLanguageFromFilename(h.filePath);
      if (!fileLanguage) continue;
      const { type: relType, idPrefix } = resolveExtendsType(h.parentName, h.filePath, ctx, fileLanguage);

      const child = resolveHeritageId(h.className, h.filePath, ctx, 'Class', `${h.filePath}:${h.className}`);
      const parent = resolveHeritageId(h.parentName, h.filePath, ctx, idPrefix);

      if (child.id && parent.id && child.id !== parent.id) {
        const edgeId = generateId(relType, `${child.id}->${parent.id}`);
        graph.addRelationship({
          id: edgeId,
          sourceId: child.id,
          targetId: parent.id,
          type: relType,
          confidence: Math.sqrt(child.confidence * parent.confidence),
          reason: '',
          source: 'heuristic',
        });
        // WI-4 (#159 P3 Mode A — heritage feed): see the
        // AST-path branch in `processHeritage`. Same gate.
        // The worker path is the one that drives most real
        // ingestion (large repos), so the feed population
        // here is the production-load path.
        if (
          opts?.lsp &&
          opts.heritageFeed &&
          parent.confidence === TIER_CONFIDENCE['global'] &&
          isTsFamilyLanguage(fileLanguage) &&
          h.line !== undefined
        ) {
          opts.heritageFeed.push({
            sourceId: child.id,
            parentName: h.parentName,
            oldTargetId: parent.id,
            oldRelId: edgeId,
            relType,
            file: h.filePath,
            line: h.line,
            character: h.character ?? 0,
          });
        }
      }
    } else if (h.kind === 'implements') {
      const cls = resolveHeritageId(h.className, h.filePath, ctx, 'Class', `${h.filePath}:${h.className}`);
      const iface = resolveHeritageId(h.parentName, h.filePath, ctx, 'Interface');

      if (cls.id && iface.id) {
        const edgeId = generateId('IMPLEMENTS', `${cls.id}->${iface.id}`);
        graph.addRelationship({
          id: edgeId,
          sourceId: cls.id,
          targetId: iface.id,
          type: 'IMPLEMENTS',
          confidence: Math.sqrt(cls.confidence * iface.confidence),
          reason: '',
          source: 'heuristic',
        });
        // WI-4 (#159 P3 Mode A — heritage feed): see the
        // AST-path branch in `processHeritage`. Same gate.
        const fileLanguage = getLanguageFromFilename(h.filePath);
        if (
          opts?.lsp &&
          opts.heritageFeed &&
          iface.confidence === TIER_CONFIDENCE['global'] &&
          fileLanguage !== undefined &&
          isTsFamilyLanguage(fileLanguage) &&
          h.line !== undefined
        ) {
          opts.heritageFeed.push({
            sourceId: cls.id,
            parentName: h.parentName,
            oldTargetId: iface.id,
            oldRelId: edgeId,
            relType: 'IMPLEMENTS',
            file: h.filePath,
            line: h.line,
            character: h.character ?? 0,
          });
        }
      }
    } else if (h.kind.startsWith('cross-file-implements|')) {
      // WI-H85 / Issue #85: cross-file Go IMPLEMENTS (worker path).
      // The kind encodes parentFilePath and confidence:
      //   `cross-file-implements|<parentFilePath>|<confidence>`
      const parts = h.kind.split('|');
      const parentFilePath = parts[1] ?? h.filePath;
      // Malformed confidence strings (e.g. a corrupt or future-mutated
      // kind) would yield NaN via `Number.parseFloat`, which would then
      // flow into the graph and CSV/Kùzu serialization. Guard the parse
      // with a finiteness check; non-finite values fall back to the
      // cross-file confidence (0.7) — the same default the original
      // `'0.7'` fallback used.
      const parsedConfidence = Number.parseFloat(parts[2] ?? '0.7');
      const confidence = Number.isFinite(parsedConfidence) ? parsedConfidence : 0.7;
      const strct = resolveHeritageId(h.className, h.filePath, ctx, 'Struct', `${h.filePath}:${h.className}`);
      const iface = resolveHeritageId(h.parentName, parentFilePath, ctx, 'Interface', `${parentFilePath}:${h.parentName}`);

      if (strct.id && iface.id && strct.id !== iface.id) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${strct.id}->${iface.id}`),
          sourceId: strct.id,
          targetId: iface.id,
          type: 'IMPLEMENTS',
          confidence,
          reason: 'cross-file-structural-match',
          source: 'heuristic',
        });
      }
    } else if (h.kind === 'trait-impl' || h.kind === 'include' || h.kind === 'extend' || h.kind === 'prepend') {
      const strct = resolveHeritageId(h.className, h.filePath, ctx, 'Struct', `${h.filePath}:${h.className}`);
      const trait = resolveHeritageId(h.parentName, h.filePath, ctx, 'Trait');

      if (strct.id && trait.id) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${strct.id}->${trait.id}:${h.kind}`),
          sourceId: strct.id,
          targetId: trait.id,
          type: 'IMPLEMENTS',
          confidence: Math.sqrt(strct.confidence * trait.confidence),
          reason: h.kind,
          source: 'heuristic',
        });
      }
    } else if (h.kind === 'composition') {
      // Go anonymous struct field (issue #26). Emit a COMPOSITION edge
      // from the owner struct to the embedded type. The owner type is
      // resolved as Struct (anonymous fields are typed identifiers in Go);
      // the embedded type is resolved against Struct and Interface since
      // it could be either. We try both — first match wins.
      const owner = resolveHeritageId(h.className, h.filePath, ctx, 'Struct', `${h.filePath}:${h.className}`);

      // Try Struct first (most common for embedding)
      let embedded = resolveHeritageId(h.parentName, h.filePath, ctx, 'Struct', `${h.filePath}:${h.parentName}`);
      if (!embedded.id || embedded.confidence === 0) {
        embedded = resolveHeritageId(h.parentName, h.filePath, ctx, 'Interface', `${h.filePath}:${h.parentName}`);
      }

      if (owner.id && embedded.id && owner.id !== embedded.id) {
        graph.addRelationship({
          id: generateId('COMPOSITION', `${owner.id}->${embedded.id}`),
          sourceId: owner.id,
          targetId: embedded.id,
          type: 'COMPOSITION',
          confidence: Math.sqrt(owner.confidence * embedded.confidence),
          reason: 'anonymous-field',
          source: 'heuristic',
        });
      }
    }
  }

  onProgress?.(total, total);
};

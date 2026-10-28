/** Fixture similarity is a retrieval hint, never evidence of equivalent test inputs. */
import path from 'node:path';
import type Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProviderForFileContent } from '../../../src/core/ingestion/languages/index.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { extractVueScript } from '../../../src/core/ingestion/vue-sfc-extractor.js';
import { getTreeSitterBufferSize } from '../../../src/core/ingestion/constants.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { byText, sha1, sortedUnique } from '../util.js';
import { MAX_SOURCE_CHARS, type SourceReader } from './source-shape.js';

export interface FixtureProfile {
  /** Keys into the coverage artifact's immutable fixture source table, when captured. */
  sourceKeys?: string[];
  /** Repository paths, retained for a reviewer to inspect. */
  roots: string[];
  files: string[];
  languages: string[];
  /** All bytes AND relative paths, including non-source assets; null if incomplete. */
  contentKey: string | null;
  /** Language-neutral, counted features from ingestion providers. */
  features: [string, number][];
  /** Extraction gaps. A partial profile cannot retrieve structural matches. */
  unresolved: string[];
}

export interface FixtureSimilarity {
  kind: 'content' | 'structure';
  score: number;
  crossLanguage: boolean;
}

const MAX_FILES = 200;
const MAX_TOTAL_CHARS = 2_000_000;
export const FIXTURE_SIMILARITY_THRESHOLD = 0.9;

/** Run-local cache: one parse per file, including fixtures shared by hundreds of cases. */
export class FixtureProfiler {
  private readonly files = new Map<
    string,
    Promise<{
      content: string | null;
      completeContent: boolean;
      language: string | null;
      features: string[];
      unresolved: string[];
    }>
  >();
  private readonly parsers = new Map<string, Promise<Parser>>();
  private readonly profiles = new Map<string, Promise<FixtureProfile>>();

  constructor(private readonly reader: SourceReader) {}

  profile(roots: readonly string[]): Promise<FixtureProfile> {
    const normalized = sortedUnique(roots).filter(
      (root, _, all) => !all.some((other) => root.startsWith(`${other}/`)),
    );
    const key = JSON.stringify(normalized);
    let result = this.profiles.get(key);
    if (result === undefined) {
      result = this.build(normalized);
      this.profiles.set(key, result);
    }
    return result;
  }

  private async read(file: string) {
    let result = this.files.get(file);
    if (result !== undefined) return result;
    result = (async () => {
      // Fixture trees can contain credential-shaped samples; never read a real .env.
      const excluded =
        /^\.env(?:\.|$)/.test(path.posix.basename(file)) && !file.endsWith('.example');
      const content = excluded ? null : this.reader.read(file);
      const features: string[] = [];
      const unresolved: string[] = [];
      const provider = content === null ? null : getProviderForFileContent(file, content);
      const language = provider?.id ?? null;
      if (content === null) unresolved.push(`${file}: unreadable`);
      else if (content.length >= MAX_SOURCE_CHARS) unresolved.push(`${file}: size limit`);
      else if (content.includes('\uFFFD')) unresolved.push(`${file}: text decoding may be lossy`);
      else if (provider !== null && content.trim() !== '') {
        let tree: Parser.Tree | undefined;
        try {
          const embedded =
            provider.id === SupportedLanguages.Vue ? extractVueScript(content) : null;
          const parseContent = embedded?.scriptContent ?? content;
          // Standalone providers (e.g. COBOL) own parsing. Providers with CFG support
          // share this tree between capture extraction and control-flow extraction.
          if (provider.cfgVisitor !== undefined) {
            const parserKey = `${provider.id}:${path.posix.extname(file)}:${embedded?.lang ?? ''}`;
            let parser = this.parsers.get(parserKey);
            if (parser === undefined) {
              parser = createParserForLanguage(provider.id, file);
              this.parsers.set(parserKey, parser);
            }
            const nativeParser = await parser;
            const grammar =
              embedded === null ? undefined : provider.selectEmbeddedGrammar?.(embedded.lang);
            if (grammar !== undefined) nativeParser.setLanguage(grammar);
            const text = provider.preprocessSource?.(parseContent, file) ?? parseContent;
            tree = nativeParser.parse(text, null, { bufferSize: getTreeSitterBufferSize(text) });
            if (tree.rootNode.hasError) unresolved.push(`${file}: parse errors`);
          }
          const parsed = extractParsedFile(
            provider,
            parseContent,
            file,
            (warning) => unresolved.push(warning),
            tree,
            embedded === null ? 'full-file' : 'pre-extracted-script',
            undefined,
            embedded?.lineOffset,
            embedded?.lang,
            embedded?.sourceLineMap,
          );
          if (parsed === undefined) unresolved.push(`${file}: no scope captures`);
          else {
            const scopes = new Map(parsed.scopes.map((scope) => [scope.id, scope]));
            const owners = new Map(
              parsed.scopes.flatMap((scope) =>
                scope.ownedDefs.map((def) => [def.nodeId, scope.kind] as const),
              ),
            );
            for (const def of parsed.localDefs) {
              features.push(
                `def:${def.type}:owner=${owners.get(def.nodeId) ?? '?'}:arity=${def.parameterCount ?? '?'}`,
              );
            }
            // Ownership and call form matter; declaration spelling and source language do not.
            for (const ref of parsed.referenceSites) {
              if (ref.kind === 'read' || ref.kind === 'write' || ref.kind === 'type-reference')
                continue;
              features.push(
                `ref:${scopes.get(ref.inScope)?.kind ?? '?'}:${ref.kind}:${ref.callForm ?? '-'}:${ref.arity ?? '?'}`,
              );
            }
            for (const entry of parsed.parsedImports) features.push(`import:${entry.kind}`);
          }
          if (tree !== undefined && provider.cfgVisitor !== undefined) {
            const { cfgs, skipped } = collectFunctionCfgs(
              tree.rootNode,
              provider.cfgVisitor,
              file,
              2000,
            );
            if (Object.values(skipped).some((count) => count > 0))
              unresolved.push(`${file}: incomplete control flow`);
            for (const cfg of cfgs) {
              // Refinement by directed, labeled neighbors preserves branch/loop topology,
              // independent of block ids, line numbers, names and literal values.
              let colors = new Map(cfg.blocks.map((block) => [block.index, block.kind as string]));
              const outgoing = new Map<number, { kind: string; other: number }[]>();
              const incoming = new Map<number, { kind: string; other: number }[]>();
              for (const edge of cfg.edges) {
                const from = outgoing.get(edge.from) ?? [];
                from.push({ kind: edge.kind, other: edge.to });
                outgoing.set(edge.from, from);
                const to = incoming.get(edge.to) ?? [];
                to.push({ kind: edge.kind, other: edge.from });
                incoming.set(edge.to, to);
              }
              for (let round = 0; round < 3; round++) {
                const previous = colors;
                colors = new Map(
                  cfg.blocks.map((block) => [
                    block.index,
                    sha1(
                      JSON.stringify([
                        previous.get(block.index),
                        (outgoing.get(block.index) ?? [])
                          .map((edge) => `${edge.kind}:${previous.get(edge.other)}`)
                          .sort(),
                        (incoming.get(block.index) ?? [])
                          .map((edge) => `${edge.kind}:${previous.get(edge.other)}`)
                          .sort(),
                      ]),
                    ),
                  ]),
                );
              }
              features.push(`cfg:${sha1(JSON.stringify([...colors.values()].sort()))}`);
            }
          }
        } catch (error) {
          unresolved.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const completeContent =
        content !== null && content.length < MAX_SOURCE_CHARS && !content.includes('\uFFFD');
      return { content, completeContent, language, features, unresolved };
    })();
    this.files.set(file, result);
    return result;
  }

  private async build(roots: string[]): Promise<FixtureProfile> {
    const files = sortedUnique(
      roots.flatMap((root) => {
        const children = this.reader.list(root);
        return children.length > 0 ? children : [root];
      }),
    );
    const unresolved: string[] = [];
    const counts = new Map<string, number>();
    const identities: string[][] = [];
    const languages = new Set<string>();
    if (files.length > MAX_FILES)
      unresolved.push(`fixture file limit (${files.length} > ${MAX_FILES})`);
    let completeContent = files.length <= MAX_FILES;
    let chars = 0;
    for (const file of files.slice(0, MAX_FILES)) {
      const item = await this.read(file);
      completeContent &&= item.completeContent;
      chars += item.content?.length ?? 0;
      if (chars > MAX_TOTAL_CHARS) {
        unresolved.push('fixture total size limit');
        completeContent = false;
        break;
      }
      unresolved.push(...item.unresolved);
      if (item.language !== null) languages.add(item.language);
      if (item.content !== null) {
        const root = roots.find((root) => file === root || file.startsWith(`${root}/`));
        if (root === undefined) {
          unresolved.push(`${file}: outside fixture roots`);
          completeContent = false;
          continue;
        }
        identities.push([
          String(roots.indexOf(root)),
          file === root ? path.posix.basename(file) : path.posix.relative(root, file),
          sha1(item.content),
        ]);
      }
      for (const feature of item.features) counts.set(feature, (counts.get(feature) ?? 0) + 1);
    }
    return {
      roots,
      files,
      languages: [...languages].sort(),
      contentKey: completeContent ? sha1(JSON.stringify(identities)) : null,
      features: [...counts].sort(([a], [b]) => byText(a, b)),
      unresolved: sortedUnique(unresolved),
    };
  }
}

/** Counted Jaccard. CFG topology carries extra weight so a loop does not look like a branch. */
export function compareFixtureProfiles(
  a: FixtureProfile,
  b: FixtureProfile,
): FixtureSimilarity | null {
  if (a.files.length === 0 || b.files.length === 0) return null;
  const crossLanguage = a.languages.join() !== b.languages.join();
  if (a.contentKey !== null && a.contentKey === b.contentKey)
    return { kind: 'content', score: 1, crossLanguage };
  if (
    a.unresolved.length > 0 ||
    b.unresolved.length > 0 ||
    a.features.length === 0 ||
    b.features.length === 0
  )
    return null;
  const right = new Map(b.features);
  let shared = 0;
  let total = 0;
  for (const [feature, count] of a.features) {
    const other = right.get(feature) ?? 0;
    const weight = feature.startsWith('cfg:') ? 4 : 1;
    shared += Math.min(count, other) * weight;
    total += Math.max(count, other) * weight;
    right.delete(feature);
  }
  for (const [feature, count] of right) total += count * (feature.startsWith('cfg:') ? 4 : 1);
  const score = total === 0 ? 0 : shared / total;
  return score >= FIXTURE_SIMILARITY_THRESHOLD ? { kind: 'structure', score, crossLanguage } : null;
}

/** Reviewable fixture evidence, deduplicated across the tests that share setup. */
export function fixtureSimilarityReport(
  tests: readonly { id: string; fixture?: FixtureProfile | null }[],
  pairs: readonly { a: string; b: string; fixtureSimilarity?: FixtureSimilarity }[],
) {
  const profiles = new Map<string, { profile: FixtureProfile; tests: string[] }>();
  for (const test of tests) {
    if (test.fixture == null) continue;
    const key = JSON.stringify(test.fixture);
    const entry = profiles.get(key) ?? { profile: test.fixture, tests: [] };
    entry.tests.push(test.id);
    profiles.set(key, entry);
  }
  const matches = pairs
    .filter((pair) => pair.fixtureSimilarity !== undefined)
    .map((pair) => ({
      a: pair.a,
      b: pair.b,
      ...pair.fixtureSimilarity,
    }));
  return {
    version: 1,
    basis:
      'Pre-resolution declarations, references, and control-flow topology. Similarity is not semantic equivalence or permission to remove a test.',
    threshold: FIXTURE_SIMILARITY_THRESHOLD,
    summary: {
      tests: tests.length,
      withFixtureInputs: tests.filter((test) => (test.fixture?.files.length ?? 0) > 0).length,
      unresolvedTests: tests.filter((test) => (test.fixture?.unresolved.length ?? 0) > 0).length,
      profiles: profiles.size,
      matches: matches.length,
      crossLanguageMatches: matches.filter((match) => match.crossLanguage).length,
    },
    profiles: [...profiles.values()],
    matches,
  };
}

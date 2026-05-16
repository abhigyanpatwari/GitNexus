import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { glob } from 'glob';
import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import { buildSuffixIndex, type SuffixIndex } from '../../ingestion/import-resolvers/utils.js';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import { getMaxFileSizeBytes } from '../../ingestion/utils/max-file-size.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { logger } from '../../logger.js';

/**
 * Cross-repo C/C++ `#include` dependency extractor.
 *
 * **Provider side:** registers every `.h/.hpp/.hxx/.hh` file in the repo
 * as a provider contract with `include::<relative-path>`.
 *
 * **Consumer side:** parses all C/C++ source/header files for `#include "…"`
 * directives, attempts suffix-based resolution against the repo's own file
 * list (reusing the same algorithm as the single-repo ingestion pipeline),
 * and emits unresolved include paths as consumer contracts.
 *
 * Matching: a consumer's `include::map/base/dice_map_view.h` in repo A
 * matches a provider's `include::map/base/dice_map_view.h` in repo B via
 * exact contract-id equality in `runExactMatch`.
 */

// ---------- constants ----------

const HEADER_EXTENSIONS = new Set(['.h', '.hpp', '.hxx', '.hh']);

// Source = headers (provider-eligible) ∪ implementation files (.c/.cpp/.cc/.cxx).
// Spread keeps the subset relationship explicit so a future contributor adding
// a new header extension to HEADER_EXTENSIONS does not have to remember to
// also add it here.
const SOURCE_EXTENSIONS = new Set<string>([...HEADER_EXTENSIONS, '.c', '.cpp', '.cc', '.cxx']);

const INCLUDE_QUERY_SRC = '(preproc_include path: (_) @import.source) @import';

/**
 * Well-known C/C++ standard library headers that can appear in `#include "…"`
 * form (some projects use quotes for system headers).
 */
const SYSTEM_HEADERS = new Set([
  // C standard
  'assert.h',
  'complex.h',
  'ctype.h',
  'errno.h',
  'fenv.h',
  'float.h',
  'inttypes.h',
  'iso646.h',
  'limits.h',
  'locale.h',
  'math.h',
  'setjmp.h',
  'signal.h',
  'stdalign.h',
  'stdarg.h',
  'stdatomic.h',
  'stdbool.h',
  'stddef.h',
  'stdint.h',
  'stdio.h',
  'stdlib.h',
  'stdnoreturn.h',
  'string.h',
  'tgmath.h',
  'threads.h',
  'time.h',
  'uchar.h',
  'wchar.h',
  'wctype.h',
  // C++ standard (extensionless)
  'algorithm',
  'any',
  'array',
  'atomic',
  'barrier',
  'bit',
  'bitset',
  'cassert',
  'cctype',
  'cerrno',
  'cfenv',
  'cfloat',
  'charconv',
  'chrono',
  'cinttypes',
  'climits',
  'clocale',
  'cmath',
  'codecvt',
  'compare',
  'complex',
  'concepts',
  'condition_variable',
  'coroutine',
  'csetjmp',
  'csignal',
  'cstdarg',
  'cstddef',
  'cstdint',
  'cstdio',
  'cstdlib',
  'cstring',
  'ctime',
  'cuchar',
  'cwchar',
  'cwctype',
  'deque',
  'exception',
  'execution',
  'expected',
  'filesystem',
  'format',
  'forward_list',
  'fstream',
  'functional',
  'future',
  'generator',
  'initializer_list',
  'iomanip',
  'ios',
  'iosfwd',
  'iostream',
  'istream',
  'iterator',
  'latch',
  'limits',
  'list',
  'locale',
  'map',
  'mdspan',
  'memory',
  'memory_resource',
  'mutex',
  'new',
  'numbers',
  'numeric',
  'optional',
  'ostream',
  'print',
  'queue',
  'random',
  'ranges',
  'ratio',
  'regex',
  'scoped_allocator',
  'semaphore',
  'set',
  'shared_mutex',
  'source_location',
  'span',
  'spanstream',
  'sstream',
  'stack',
  'stacktrace',
  'stdexcept',
  'stdfloat',
  'stop_token',
  'streambuf',
  'string',
  'string_view',
  'strstream',
  'syncstream',
  'system_error',
  'thread',
  'tuple',
  'type_traits',
  'typeindex',
  'typeinfo',
  'unordered_map',
  'unordered_set',
  'utility',
  'valarray',
  'variant',
  'vector',
  'version',
]);

/** Path prefixes that indicate system/kernel headers. */
const SYSTEM_PATH_PREFIXES = [
  'sys/',
  'net/',
  'netinet/',
  'arpa/',
  'linux/',
  'asm/',
  'bits/',
  'gnu/',
  'mach/',
  'machine/',
  'xlocale/',
];

/** Regex fallback for files that exceed tree-sitter's 32 KB parse limit. */
const INCLUDE_REGEX = /^[ \t]*#\s*include\s*"([^"]+)"/gm;

// ---------- helpers ----------

/**
 * Normalize an include path to a canonical lowercase forward-slash form.
 *
 * IMPORTANT — case-folding caveat (PR #1156 review finding #3):
 *   Header paths are lowercased so consumer `#include "Foo/Bar.h"` and
 *   provider file `Foo/Bar.h` normalize to the same contract-id. This is
 *   the right trade-off on case-insensitive filesystems (macOS, Windows)
 *   but on case-sensitive Linux filesystems two distinct headers `Foo.h`
 *   and `foo.h` in the same repo will collide onto the same provider
 *   contract-id; only one survives `dedupe()`. The gain (reliable
 *   cross-platform matching) outweighs the cost (extremely rare header
 *   casing collisions inside a single repo).
 */
function normalizeIncludePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}

/**
 * Strip C/C++ block comments from a source blob. Used only by the
 * regex-fallback path to avoid emitting consumer contracts for
 * commented-out #include directives. Line comments (`// …`) cannot hide
 * #include directives because the regex anchors on start-of-line.
 * See PR #1156 review finding #5.
 */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

function isAngleBracketInclude(rawNodeText: string): boolean {
  const trimmed = rawNodeText.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>');
}

function isSystemHeader(cleanedPath: string): boolean {
  // Check well-known standard headers
  if (SYSTEM_HEADERS.has(cleanedPath)) return true;
  // Check system path prefixes
  const lower = cleanedPath.toLowerCase();
  return SYSTEM_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isHeaderFile(filePath: string): boolean {
  return HEADER_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getLanguageForFile(filePath: string): unknown | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.c':
    case '.h':
      return C;
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
    case '.hxx':
    case '.hh':
      return Cpp;
    default:
      return null;
  }
}

/**
 * Check whether an include path resolves to a file inside the local repo.
 *
 * Uses *exact full-path* matching on the suffix index — we never accept a
 * truncated suffix match. For `#include "foo/bar.h"` this checks:
 *   (a) a file whose path ends with the full `foo/bar.h`
 *   (b) if the include omitted the extension, a file whose path ends with
 *       the include + one of the C/C++ header extensions
 *
 * Returns `true` when a local file matches — caller should suppress the
 * cross-repo consumer contract.
 *
 * See PR #1156 review finding #4 (suffixResolve ambiguity).
 */
function isLocalInclude(cleaned: string, suffixIndex: SuffixIndex): boolean {
  const candidates = [cleaned];
  if (!/\.[a-zA-Z0-9]+$/.test(cleaned)) {
    for (const ext of ['.h', '.hpp', '.hxx', '.hh']) candidates.push(cleaned + ext);
  }
  for (const c of candidates) {
    if (suffixIndex.get(c) || suffixIndex.getInsensitive(c)) return true;
  }
  return false;
}

// ---------- main class ----------

export class IncludeExtractor implements ContractExtractor {
  type = 'include' as const;

  /**
   * Always returns `true`. NOT called by `sync.ts`, which gates extraction via
   * `config.detect.includes` instead (see `sync.ts:174`). Kept solely to satisfy
   * the `ContractExtractor` interface so the type stays uniform across extractors.
   */
  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    // 1. Build the local file list using the same discovery as ingestion
    //    (createIgnoreFilter + getMaxFileSizeBytes). This guarantees the
    //    universe of provider/consumer paths matches the universe of File
    //    nodes in the LadybugDB graph — so no cross-link points at a UID
    //    that group impact cannot fan out to.
    //    (PR #1156 Codex follow-up: discovery aligned with ingestion.)
    const allFiles = await this.discoverIndexableFiles(repoPath);
    const normalizedFiles = allFiles.map((f) => f.replace(/\\/g, '/'));
    const suffixIndex = buildSuffixIndex(normalizedFiles, allFiles);

    // 2. Provider: register all header files
    const providers = await this.extractProviders(dbExecutor, repoPath, allFiles);

    // 3. Consumer: filter the shared discovery list for source extensions
    //    and parse #include directives in those files.
    const sourceFiles = allFiles.filter((f) =>
      SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase()),
    );
    const consumers = await this.extractConsumers(repoPath, sourceFiles, suffixIndex);

    return this.dedupe([...providers, ...consumers]);
  }

  /**
   * Discover repo-relative file paths using exactly the same rules the
   * ingestion pipeline uses (`walkRepositoryPaths` in
   * `gitnexus/src/core/ingestion/filesystem-walker.ts`):
   *   - `createIgnoreFilter` honors `.gitignore`, `.gitnexusignore`, the
   *     hardcoded ignore list, and `.gitnexusignore` last-match-wins
   *     negation.
   *   - `getMaxFileSizeBytes()` drops files larger than the cap so we
   *     never emit `File:<rel>` UIDs for files ingestion would skip.
   *
   * Uses sequential stat — there is no `READ_CONCURRENCY` batching here
   * because group sync runs at startup-time, not the ingestion hot path,
   * and parallelism gains are not worth the import-graph weight.
   *
   * MAINTENANCE: if `walkRepositoryPaths` changes its glob options, ignore
   * filter shape, or size-cap logic, mirror those changes here. The two
   * implementations exist because the consumers need different return
   * shapes (string[] vs ScannedFile[]) and different concurrency, but
   * they MUST agree on which files are reachable — that is what makes
   * `File:<rel>` UIDs in cross-links correspond to graph File nodes.
   */
  private async discoverIndexableFiles(repoPath: string): Promise<string[]> {
    const ignoreFilter = await createIgnoreFilter(repoPath);
    const maxFileSizeBytes = getMaxFileSizeBytes();

    const candidates = await glob('**/*', {
      cwd: repoPath,
      nodir: true,
      dot: false,
      ignore: ignoreFilter,
    });

    const survivors: string[] = [];
    for (const rel of candidates) {
      try {
        const stat = await fs.stat(path.join(repoPath, rel));
        if (stat.size > maxFileSizeBytes) continue;
        survivors.push(rel);
      } catch (err) {
        // ENOENT is the documented benign race (glob enumerated a file
        // that was deleted before we stat'd it — same race
        // walkRepositoryPaths absorbs via Promise.allSettled). Anything
        // else (EACCES, EMFILE, EIO) deserves a warning so an operator
        // can spot a permission/resource problem instead of silently
        // shipping fewer contracts than expected.
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT') {
          logger.warn(
            { err: (err as Error).message, file: rel, repoPath },
            '⚠️ IncludeExtractor: stat failed during discovery; skipping file',
          );
        }
      }
    }
    return survivors;
  }

  // ---------- provider extraction ----------

  private async extractProviders(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    allFiles: string[],
  ): Promise<ExtractedContract[]> {
    // Strategy A: graph-assisted
    if (dbExecutor) {
      const graphProviders = await this.extractProvidersGraph(dbExecutor, repoPath);
      if (graphProviders.length > 0) return graphProviders;
    }
    // Strategy B: filesystem fallback
    return this.extractProvidersFallback(repoPath, allFiles);
  }

  private async extractProvidersGraph(
    db: CypherExecutor,
    repoPath: string,
  ): Promise<ExtractedContract[]> {
    try {
      const rows = await db(
        `MATCH (f:File)
         WHERE f.filePath =~ '.*\\\\.(h|hpp|hxx|hh)$'
         RETURN f.filePath AS filePath, f.id AS fileId`,
      );
      // gitnexus analyze stores absolute paths in the File.filePath column.
      // Provider contract IDs MUST be repo-relative — otherwise the consumer
      // emits `include::map/base/view.h` and the provider emits
      // `include::/abs/path/to/repo/map/base/view.h`, which never match
      // through runExactMatch and the cross-link silently disappears.
      // (PR #1156 follow-up review: graph provider absolute-path bug.)
      const normalizedRepoPath = path.resolve(repoPath);
      const out: ExtractedContract[] = [];
      for (const r of rows) {
        if (typeof r.filePath !== 'string' || !r.filePath) continue;
        const absolute = r.filePath as string;
        const rel = path.relative(normalizedRepoPath, absolute);
        // Skip rows that resolve outside the repo (e.g., system headers
        // somehow indexed, or stale absolute paths from a different machine).
        // path.relative returns a `..`-prefixed path or an absolute path
        // when the target is outside the base — both are wrong for our IDs.
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const normalizedRel = rel.replace(/\\/g, '/');
        out.push({
          contractId: `include::${normalizeIncludePath(normalizedRel)}`,
          type: 'include' as const,
          role: 'provider' as const,
          symbolUid: String(r.fileId ?? ''),
          symbolRef: { filePath: normalizedRel, name: path.basename(normalizedRel) },
          symbolName: path.basename(normalizedRel),
          confidence: 1.0,
          meta: { source: 'graph' },
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private extractProvidersFallback(_repoPath: string, allFiles: string[]): ExtractedContract[] {
    return allFiles
      .filter((f) => isHeaderFile(f))
      .map((f) => {
        const filePath = f.replace(/\\/g, '/');
        return {
          contractId: `include::${normalizeIncludePath(filePath)}`,
          type: 'include' as const,
          role: 'provider' as const,
          symbolUid: `File:${filePath}`,
          symbolRef: { filePath, name: path.basename(filePath) },
          symbolName: path.basename(filePath),
          confidence: 0.95,
          meta: { source: 'filesystem' },
        };
      });
  }

  // ---------- consumer extraction ----------

  private async extractConsumers(
    repoPath: string,
    sourceFiles: string[],
    suffixIndex: SuffixIndex,
  ): Promise<ExtractedContract[]> {
    const parser = new Parser();
    const out: ExtractedContract[] = [];
    // Compile the include query once per grammar to avoid re-compilation per file
    const queryCache = new Map<unknown, Parser.Query>();

    for (const rel of sourceFiles) {
      const lang = getLanguageForFile(rel);
      if (!lang) continue;

      const content = readSafe(repoPath, rel);
      if (!content) continue;

      let query = queryCache.get(lang);
      if (!query) {
        try {
          query = new Parser.Query(lang, INCLUDE_QUERY_SRC);
          queryCache.set(lang, query);
        } catch {
          continue;
        }
      }

      // Collect raw include paths: tree-sitter first, regex fallback for large files.
      // `extractionSource` is stamped on each emitted consumer contract so
      // regex-fallback contracts stay auditable post-hoc (PR #1156 review finding #6).
      let rawIncludes: string[];
      let extractionSource: 'tree_sitter' | 'regex_fallback';
      try {
        parser.setLanguage(lang);
        const tree = parseSourceSafe(parser, content);
        let matches: Parser.QueryMatch[];
        try {
          matches = query.matches(tree.rootNode);
        } catch {
          matches = [];
        }
        rawIncludes = [];
        extractionSource = 'tree_sitter';
        for (const match of matches) {
          const sourceNode = match.captures.find((c) => c.name === 'import.source');
          if (!sourceNode) continue;
          const rawText = sourceNode.node.text;
          if (isAngleBracketInclude(rawText)) continue;
          const cleaned = rawText.replace(/['"<>]/g, '');
          if (cleaned && cleaned.length <= 2048) rawIncludes.push(cleaned);
        }
      } catch {
        // tree-sitter failed (e.g. file > 32 KB) — fall back to regex.
        // Strip block comments first so we don't emit a consumer contract
        // for a commented-out #include (PR #1156 review finding #5).
        rawIncludes = [];
        extractionSource = 'regex_fallback';
        const scanTarget = stripBlockComments(content);
        INCLUDE_REGEX.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = INCLUDE_REGEX.exec(scanTarget)) !== null) {
          if (m[1] && m[1].length <= 2048) rawIncludes.push(m[1]);
        }
      }

      for (const cleaned of rawIncludes) {
        // Filter: skip known system headers and system path prefixes
        if (isSystemHeader(cleaned)) continue;

        // Skip relative-up includes: `#include "../include/foo.h"` is
        // almost always an intra-repo reference. The suffix index is built
        // from repo-relative paths, so isLocalInclude can never match
        // `../foo.h`, and emitting it as a consumer contract just pollutes
        // the registry with an entry no provider can ever satisfy.
        // (PR #1156 follow-up review: `../` relative includes produce
        // spurious consumer contracts.)
        if (cleaned.startsWith('../') || cleaned.startsWith('..\\')) continue;

        // Skip macro-style includes: `#include PLATFORM_HEADER` parses as an
        // identifier under tree-sitter's `(_) @import.source` wildcard. The
        // identifier text passes the strip/clean step unchanged, so without
        // this guard we would emit `include::platform_header` as a consumer
        // contract — and no provider in any repo will ever expose a contract
        // for a macro identifier (no file is named `PLATFORM_HEADER`). The
        // contract would sit permanently orphaned in the registry. Real
        // header references always contain a path separator (`/`, `\`) or an
        // extension dot (`foo.h`), so an absent both is a reliable signal we
        // are looking at a macro identifier. (PR #1156 follow-up review:
        // macro includes emit orphaned consumer contracts.)
        if (!/[./\\]/.test(cleaned)) continue;

        // Local resolution (PR #1156 review finding #4): only accept an
        // exact-suffix match on the *full* include path. The generic
        // suffixResolve() iterates all truncated suffixes, which would
        // silently suppress a cross-repo `#include "map/base/view.h"`
        // when the local repo has any `internal/view.h` — a realistic
        // false-negative in large C++ codebases. Here we only resolve
        // locally if a file path ends with the complete include string
        // (optionally re-appending one of the C/C++ header extensions
        // when the include already omits it).
        if (isLocalInclude(cleaned, suffixIndex)) continue;

        // Unresolved: emit as consumer contract
        const normalizedRel = rel.replace(/\\/g, '/');
        out.push({
          contractId: `include::${normalizeIncludePath(cleaned)}`,
          type: 'include' as const,
          role: 'consumer' as const,
          symbolUid: `File:${normalizedRel}`,
          symbolRef: { filePath: normalizedRel, name: cleaned },
          symbolName: cleaned,
          confidence: 0.85,
          meta: {
            source: extractionSource,
            includePath: cleaned,
          },
        });
      }
    }

    return out;
  }

  // ---------- deduplication ----------

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    const out: ExtractedContract[] = [];
    for (const c of items) {
      const k = `${c.contractId}|${c.role}|${c.symbolRef.filePath}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }
}

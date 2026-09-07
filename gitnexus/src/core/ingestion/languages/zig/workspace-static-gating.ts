import type { ParsedFile, ReferenceSite } from 'gitnexus-shared';
import { getTreeSitterBufferSize } from '../../constants.js';
import type { ZigBuildZonConfig } from '../../language-config.js';
import { resolveZigImportInternal } from '../../import-resolvers/zig.js';
import {
  buildZigBoolConstMap,
  collectZigStaticGatedRanges,
  isPositionStaticGated,
  type ZigImportAliasMap,
} from '../../call-extractors/zig-static-gating.js';
import { parseSourceSafe, ParseTimeoutError } from '../../../tree-sitter/safe-parse.js';
import { getZigParser } from './query.js';

type ZigTree = ReturnType<ReturnType<typeof getZigParser>['parse']>;

export function populateZigWorkspaceStaticGating(
  parsedFiles: ParsedFile[],
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly treeCache?: { get(filePath: string): unknown };
    readonly resolutionConfig?: unknown;
  },
): void {
  const parser = getZigParser();
  const trees = new Map<string, ZigTree>();
  const bools = new Map<string, ReturnType<typeof buildZigBoolConstMap>>();

  for (const parsed of parsedFiles) {
    const source = ctx.fileContents.get(parsed.filePath);
    if (source === undefined) continue;
    let tree = ctx.treeCache?.get(parsed.filePath) as ZigTree | undefined;
    if (tree === undefined) {
      try {
        tree = parseSourceSafe(parser, source, undefined, {
          bufferSize: getTreeSitterBufferSize(source),
        });
      } catch (err) {
        if (err instanceof ParseTimeoutError) continue;
        throw err;
      }
    }
    trees.set(parsed.filePath, tree);
    bools.set(parsed.filePath, buildZigBoolConstMap(tree.rootNode));
  }

  const knownPaths = new Set(trees.keys());
  for (const [index, parsed] of parsedFiles.entries()) {
    const tree = trees.get(parsed.filePath);
    if (tree === undefined) continue;
    const aliases = collectImportAliases(
      tree,
      parsed.filePath,
      knownPaths,
      ctx.resolutionConfig as ZigBuildZonConfig | null | undefined,
    );
    if (aliases.size === 0) continue;
    const ranges = collectZigStaticGatedRanges(
      tree.rootNode,
      bools.get(parsed.filePath) ?? new Map(),
      aliases,
      (filePath) => bools.get(filePath),
    );
    if (ranges.length === 0) continue;
    const next = parsed.referenceSites.map((site) =>
      site.kind === 'call' &&
      site.staticGated !== true &&
      isPositionStaticGated(site.atRange.startLine, site.atRange.startCol, ranges)
        ? ({ ...site, staticGated: true } satisfies ReferenceSite)
        : site,
    );
    parsedFiles[index] = Object.freeze({ ...parsed, referenceSites: Object.freeze(next) });
  }
}

function collectImportAliases(
  tree: ZigTree,
  fromFile: string,
  knownPaths: ReadonlySet<string>,
  resolutionConfig?: ZigBuildZonConfig | null,
): ZigImportAliasMap {
  const candidates = new Map<string, string>();
  const declarationCounts = new Map<string, number>();
  for (const decl of tree.rootNode.descendantsOfType('variable_declaration')) {
    const names = decl.namedChildren.filter((node) => node.type === 'identifier');
    const binding = names[0]?.text;
    if (binding === undefined) continue;
    declarationCounts.set(binding, (declarationCounts.get(binding) ?? 0) + 1);
    const builtin = decl.namedChildren.find(
      (node) => node.type === 'builtin_function' && node.text.startsWith('@import('),
    );
    const raw = builtin?.descendantsOfType('string').at(0)?.text;
    if (raw === undefined) continue;
    const specifier = raw.replace(/^['"]|['"]$/g, '');
    const target = resolveZigImportInternal(fromFile, specifier, knownPaths, resolutionConfig);
    if (target !== null) candidates.set(binding, target);
  }

  const aliases = new Map<string, string>();
  for (const [binding, target] of candidates) {
    // Alias lookup below is name-based rather than position-aware. If a name
    // is redeclared in another lexical scope, fail open instead of applying
    // either module's constants to every use of that spelling.
    if (declarationCounts.get(binding) === 1) aliases.set(binding, target);
  }
  return aliases;
}

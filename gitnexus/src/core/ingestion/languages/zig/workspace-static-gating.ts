import path from 'node:path';
import type { ParsedFile, ReferenceSite } from 'gitnexus-shared';
import { getTreeSitterBufferSize } from '../../constants.js';
import {
  buildZigBoolConstMap,
  collectZigStaticGatedRanges,
  isPositionStaticGated,
  type ZigImportAliasMap,
} from '../../call-extractors/zig-static-gating.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { getZigParser } from './query.js';

type ZigTree = ReturnType<ReturnType<typeof getZigParser>['parse']>;

export function populateZigWorkspaceStaticGating(
  parsedFiles: readonly ParsedFile[],
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly treeCache?: { get(filePath: string): unknown };
  },
): void {
  const parser = getZigParser();
  const trees = new Map<string, ZigTree>();
  const bools = new Map<string, ReturnType<typeof buildZigBoolConstMap>>();

  for (const parsed of parsedFiles) {
    const source = ctx.fileContents.get(parsed.filePath);
    if (source === undefined) continue;
    const tree =
      (ctx.treeCache?.get(parsed.filePath) as ZigTree | undefined) ??
      parseSourceSafe(parser, source, undefined, { bufferSize: getTreeSitterBufferSize(source) });
    trees.set(parsed.filePath, tree);
    bools.set(parsed.filePath, buildZigBoolConstMap(tree.rootNode));
  }

  const knownPaths = new Set(trees.keys());
  for (const parsed of parsedFiles) {
    const tree = trees.get(parsed.filePath);
    if (tree === undefined) continue;
    const aliases = collectImportAliases(tree, parsed.filePath, knownPaths);
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
    (parsed as { referenceSites: readonly ReferenceSite[] }).referenceSites = next;
  }
}

function collectImportAliases(
  tree: ZigTree,
  fromFile: string,
  knownPaths: ReadonlySet<string>,
): ZigImportAliasMap {
  const aliases = new Map<string, string>();
  for (const decl of tree.rootNode.descendantsOfType('variable_declaration')) {
    const names = decl.namedChildren.filter((node) => node.type === 'identifier');
    const binding = names[0]?.text;
    const builtin = decl.namedChildren.find(
      (node) => node.type === 'builtin_function' && node.text.startsWith('@import('),
    );
    const raw = builtin?.descendantsOfType('string').at(0)?.text;
    if (binding === undefined || raw === undefined) continue;
    const specifier = raw.replace(/^['"]|['"]$/g, '');
    if (!specifier.endsWith('.zig')) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    if (knownPaths.has(resolved)) aliases.set(binding, resolved);
  }
  return aliases;
}

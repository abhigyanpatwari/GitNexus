/** Workspace-only annotation identity correction; never serialized into parse caches. */
import type Parser from 'tree-sitter';
import type { ParsedFile, Range, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import { isJvmSourceVisible } from '../jvm/source-visibility.js';
import { javaProvider } from '../java.js';
import { getJavaParser } from './query.js';
import { getJavaPackageFact } from './package-facts.js';
import {
  getJavaOverloadFacts,
  type JavaOverloadFileFacts,
  type JavaOverloadTypeFact,
} from './overload-argument-facts.js';
import { eraseJavaTypeArguments } from './type-spelling.js';
import {
  synthesizeLombokAccessors,
  withJavaLombokWorkspaceProof,
  type JavaLombokAnnotationWorkspaceProof,
} from './lombok-synthesizer.js';

const TYPE_NODES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);
const LOMBOK_NAMES = new Set([
  'Value',
  'Data',
  'Getter',
  'Setter',
  'RequiredArgsConstructor',
  'AllArgsConstructor',
  'NoArgsConstructor',
  'NonNull',
  'Accessors',
  'NonFinal',
  'Builder',
  'SuperBuilder',
  'Tolerate',
]);
const rangeKey = (range: Range) =>
  `${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
const nodeRange = (node: Parser.SyntaxNode): Range => ({
  startLine: node.startPosition.row + 1,
  startCol: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endCol: node.endPosition.column,
});

/** Sorted annotation lines are a conservative positional filter: columns,
 * CRLF and UTF-16/native byte offsets cannot exclude a same-line candidate. */
function hasAnnotationInLines(lines: readonly number[] | undefined, range: Range): boolean {
  if (lines === undefined) return false;
  let low = 0,
    high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]! < range.startLine) low = middle + 1;
    else high = middle;
  }
  return low < lines.length && lines[low]! <= range.endLine;
}

interface TypeEntry {
  readonly filePath: string;
  readonly packageName: string;
  readonly fact: JavaOverloadTypeFact;
  readonly facts: JavaOverloadFileFacts;
  readonly memberNames: Set<string>;
  parent?: TypeEntry;
}
interface InheritedNames {
  readonly names: ReadonlySet<string>;
  readonly unknown: boolean;
}
interface Correction {
  readonly tree: Parser.Tree;
  readonly proof: JavaLombokAnnotationWorkspaceProof;
  readonly removed: readonly SymbolDefinition[];
}
const corrections = new WeakMap<ParsedFile, Correction>();

function workspaceInventory(parsedFiles: readonly ParsedFile[]) {
  const byFile = new Map<string, Map<string, TypeEntry>>();
  const byFqn = new Map<string, TypeEntry[]>();
  const packageTypes = new Map<string, TypeEntry[]>();
  for (const parsed of parsedFiles) {
    const pkg = getJavaPackageFact(parsed.filePath);
    const facts = getJavaOverloadFacts(parsed.filePath);
    if (pkg?.status !== 'known' || facts === undefined) continue;
    const scopes = new Map(parsed.scopes.map((scope) => [rangeKey(scope.range), scope]));
    const byScope = new Map<string, TypeEntry>();
    const entries = new Map<string, TypeEntry>();
    for (const fact of facts.types) {
      const scope = scopes.get(rangeKey(fact.range));
      if (scope?.kind !== 'Class') continue;
      const entry: TypeEntry = {
        filePath: parsed.filePath,
        packageName: pkg.packageName,
        fact,
        facts,
        memberNames: new Set(),
      };
      entries.set(rangeKey(fact.range), entry);
      byScope.set(scope.id, entry);
      const fqn = pkg.packageName === '' ? fact.name : `${pkg.packageName}.${fact.name}`;
      const candidates = byFqn.get(fqn) ?? [];
      candidates.push(entry);
      byFqn.set(fqn, candidates);
      if (scope.parent === parsed.moduleScope) {
        const top = packageTypes.get(pkg.packageName) ?? [];
        top.push(entry);
        packageTypes.set(pkg.packageName, top);
      }
    }
    for (const [key, entry] of entries) {
      const parentId = scopes.get(key)?.parent;
      const parent = parentId == null ? undefined : byScope.get(parentId);
      if (parent !== undefined) {
        entry.parent = parent;
        parent.memberNames.add(entry.fact.simpleName);
      }
    }
    byFile.set(parsed.filePath, entries);
  }

  const visible = (from: TypeEntry, target: TypeEntry) =>
    isJvmSourceVisible(from.filePath, target.filePath) &&
    (from.packageName === target.packageName || target.fact.modifiers?.includes('public') === true);
  const resolveBase = (entry: TypeEntry, written: string): TypeEntry | 'object' | undefined => {
    const raw = eraseJavaTypeArguments(written).replace(/\s+/g, '');
    if (!/^[\w$.]+$/.test(raw)) return undefined;
    const imports = entry.facts.imports.filter((item) => !item.static && !item.wildcard);
    const head = raw.split('.')[0]!;
    const explicit = imports.filter((item) => item.name.split('.').pop() === head);
    let spellings: string[];
    if (explicit.length > 1) return undefined;
    if (explicit.length === 1) spellings = [explicit[0]!.name + raw.slice(head.length)];
    else if (raw.includes('.')) spellings = [raw];
    else {
      spellings = [];
      for (let owner = entry.parent; owner !== undefined; owner = owner.parent) {
        if (owner.memberNames.has(raw)) {
          spellings.push(
            `${owner.packageName === '' ? '' : owner.packageName + '.'}${owner.fact.name}.${raw}`,
          );
          break;
        }
      }
      if (spellings.length === 0) {
        const same = `${entry.packageName === '' ? '' : entry.packageName + '.'}${raw}`;
        if (byFqn.has(same)) spellings.push(same);
        else
          spellings.push(
            ...entry.facts.imports
              .filter((item) => item.wildcard && !item.static)
              .map((item) => `${item.name.replace(/\.\*$/, '')}.${raw}`),
          );
      }
    }
    const candidates = [
      ...new Set(
        spellings
          .flatMap((spelling) => byFqn.get(spelling) ?? [])
          .filter((target) => visible(entry, target)),
      ),
    ];
    if (candidates.length === 1) return candidates[0];
    if (
      candidates.length === 0 &&
      (raw === 'java.lang.Object' ||
        (raw === 'Object' && explicit.length === 0 && !byFqn.has(`${entry.packageName}.Object`)))
    )
      return 'object';
    return undefined;
  };
  const inherited = new Map<TypeEntry, InheritedNames>();
  const visiting = new Set<TypeEntry>();
  const namesOf = (entry: TypeEntry): InheritedNames => {
    const cached = inherited.get(entry);
    if (cached !== undefined) return cached;
    if (visiting.has(entry)) return { names: new Set(), unknown: true };
    visiting.add(entry);
    const names = new Set<string>();
    let unknown = false;
    for (const base of entry.fact.bases) {
      const target = resolveBase(entry, base);
      if (target === 'object') continue;
      if (target === undefined) {
        unknown = true;
        continue;
      }
      for (const name of target.memberNames) names.add(name);
      const ancestors = namesOf(target);
      for (const name of ancestors.names) names.add(name);
      unknown ||= ancestors.unknown;
    }
    visiting.delete(entry);
    const result = { names, unknown };
    inherited.set(entry, result);
    return result;
  };
  return { byFile, packageTypes, namesOf };
}

/** Reconcile only files whose file-local annotation proof can be shadowed by siblings. */
export function reconcileJavaLombokWorkspaceProof(
  parsedFiles: ParsedFile[],
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly treeCache?: { get(filePath: string): unknown };
  },
): void {
  const inventory = workspaceInventory(parsedFiles);
  for (let i = 0; i < parsedFiles.length; i++) {
    const original = parsedFiles[i]!;
    corrections.delete(original);
    const pkg = getJavaPackageFact(original.filePath);
    const facts = getJavaOverloadFacts(original.filePath);
    const entries = inventory.byFile.get(original.filePath);
    const source = ctx.fileContents.get(original.filePath);
    if (
      pkg?.status !== 'known' ||
      facts === undefined ||
      entries === undefined ||
      source === undefined
    )
      continue;
    const annotations: string[] = [];
    const annotationLines: number[] = [];
    const linesByRoot = new Map<string, number[]>();
    let cursor = 0,
      line = 1;
    for (const match of source.matchAll(/@\s*([\w$]+(?:\.[\w$]+)*)/g)) {
      const name = match[1]!;
      if (!LOMBOK_NAMES.has(name.split('.').pop()!)) continue;
      // One forward scan for every relevant annotation, never prefix slicing
      // per site. Tree-sitter rows and this filter both advance on LF.
      while (cursor < match.index) if (source.charCodeAt(cursor++) === 10) line++;
      annotations.push(name);
      annotationLines.push(line);
      const root = name.split('.')[0]!;
      const lines = linesByRoot.get(root) ?? [];
      lines.push(line);
      linesByRoot.set(root, lines);
    }
    if (annotations.length === 0) continue;
    const siblings = new Set(
      (inventory.packageTypes.get(pkg.packageName) ?? [])
        .filter((entry) => isJvmSourceVisible(original.filePath, entry.filePath))
        .map((entry) => entry.fact.simpleName),
    );
    // The leaf import proof already sees declarations in its own file. Only
    // foreign siblings can change that part of the annotation decision.
    const foreignSiblings = new Set(
      (inventory.packageTypes.get(pkg.packageName) ?? [])
        .filter(
          (entry) =>
            entry.filePath !== original.filePath &&
            isJvmSourceVisible(original.filePath, entry.filePath),
        )
        .map((entry) => entry.fact.simpleName),
    );
    const named = new Map(
      facts.imports
        .filter((item) => !item.static && !item.wildcard)
        .map((item) => [item.name.split('.').pop()!, item.name]),
    );
    const packageCanShadow = annotations.some((name) =>
      name.includes('.')
        ? foreignSiblings.has(name.split('.')[0]!)
        : foreignSiblings.has(name) && !named.has(name),
    );
    // Anonymous/local type facts can lack an equal-range extracted scope.
    // Keep the prior trigger in that case; narrower coverage is not proof.
    const completeTypeCoverage = facts.types.length === entries.size;
    const inheritedCanShadow = [...entries.values()].some((entry) => {
      const inherited = inventory.namesOf(entry);
      if (!completeTypeCoverage)
        return (
          inherited.unknown || annotations.some((name) => inherited.names.has(name.split('.')[0]!))
        );
      if (inherited.unknown) return hasAnnotationInLines(annotationLines, entry.fact.range);
      for (const name of inherited.names)
        if (hasAnnotationInLines(linesByRoot.get(name), entry.fact.range)) return true;
      return false;
    });
    if (!packageCanShadow && !inheritedCanShadow) continue;
    const proof: JavaLombokAnnotationWorkspaceProof = (written, _qualified, context) => {
      const root = written.split('.')[0]!;
      if (written.includes('.') ? siblings.has(root) : siblings.has(written) && !named.has(written))
        return false;
      for (
        let owner = context;
        owner !== undefined && owner !== null;
        owner = owner.parent ?? undefined
      ) {
        if (
          !TYPE_NODES.has(owner.type) &&
          !(
            owner.type === 'class_body' &&
            ['object_creation_expression', 'enum_constant'].includes(owner.parent?.type ?? '')
          )
        )
          continue;
        // The annotated class's header is outside its own body. Only an
        // enclosing type can provide inherited member names at that position.
        const body = owner.childForFieldName('body');
        if (context !== undefined && body !== null && context.startIndex < body.startIndex)
          continue;
        const entry = entries.get(rangeKey(nodeRange(owner)));
        if (entry === undefined) return false;
        const inherited = inventory.namesOf(entry);
        if (inherited.unknown || inherited.names.has(root)) return false;
      }
      return true;
    };
    const tree =
      (ctx.treeCache?.get(original.filePath) as Parser.Tree | undefined) ??
      parseSourceSafe(getJavaParser(), source, undefined, {
        bufferSize: getTreeSitterBufferSize(source),
      });
    const corrected = withJavaLombokWorkspaceProof(tree, proof, () => {
      const parsed = extractParsedFile(javaProvider, source, original.filePath, undefined, tree);
      if (parsed === undefined)
        throw new Error(`Cannot verify Lombok annotation identity: ${original.filePath}`);
      const captureSideChannel = javaProvider.collectCaptureSideChannel?.(original.filePath);
      return { ...parsed, ...(captureSideChannel === undefined ? {} : { captureSideChannel }) };
    });
    populateClassOwnedMembers(corrected);
    const retained = new Set(corrected.localDefs.map((def) => def.nodeId));
    const removed = original.localDefs.filter(
      (def) => def.type === 'Method' && def.isSynthetic === true && !retained.has(def.nodeId),
    );
    const next = Object.freeze({
      ...original,
      ...corrected,
      localDefs: Object.freeze([
        ...corrected.localDefs,
        ...removed.map((def) => ({ ...def, isDeleted: true })),
      ]),
    });
    parsedFiles[i] = next;
    corrections.set(next, { tree, proof, removed });
  }
}

/** The Java heritage hook runs before the shared graph lookup is rebuilt. */
export function emitJavaLombokWorkspaceCorrections(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  for (const parsed of parsedFiles) {
    const correction = corrections.get(parsed);
    if (correction === undefined) continue;
    const owners = new Map<number, string>();
    const defs = new Map(
      parsed.localDefs
        .filter(
          (def) =>
            def.declarationRange !== undefined &&
            ['Class', 'Enum', 'Interface', 'Record', 'Annotation'].includes(def.type),
        )
        .map((def) => [rangeKey(def.declarationRange!), def]),
    );
    for (const node of correction.tree.rootNode.descendantsOfType([
      'class_declaration',
      'enum_declaration',
    ])) {
      const def = defs.get(rangeKey(nodeRange(node)));
      const id =
        def === undefined ? undefined : resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (id !== undefined) owners.set(node.id, id);
    }
    for (const def of correction.removed) {
      const id = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (id !== undefined && graph.getNode(id)?.properties.synthetic === 'lombok')
        graph.removeNode(id);
    }
    const result = withJavaLombokWorkspaceProof(correction.tree, correction.proof, () =>
      synthesizeLombokAccessors(correction.tree, parsed.filePath, owners),
    );
    for (const node of result.nodes) if (graph.getNode(node.id) === undefined) graph.addNode(node);
    for (const edge of result.relationships) graph.addRelationship(edge);
    corrections.delete(parsed);
  }
}

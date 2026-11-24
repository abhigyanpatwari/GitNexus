/** Workspace-only annotation identity correction; never serialized into parse caches. */
import type Parser from 'tree-sitter';
import type { ParsedFile, Range, ScopeId, SymbolDefinition } from 'gitnexus-shared';
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
import {
  applyJavaCaptureSideChannel,
  collectJavaCaptureSideChannel,
} from './capture-side-channel.js';
import { getJavaPackageFact } from './package-facts.js';
import { JAVA_PLATFORM_OWNERS_WITHOUT_MEMBER_TYPES } from './overload-types.js';
import { bindJavaQualifiedHeritage } from './qualified-heritage.js';
import {
  getJavaOverloadFacts,
  type JavaOverloadFileFacts,
  type JavaOverloadTypeFact,
} from './overload-argument-facts.js';
import {
  eraseJavaTypeArguments,
  JAVA_DOTTED_SPELLING,
  JAVA_IDENTIFIER_PART_CHARS,
  stripGaps,
} from './type-spelling.js';
import {
  LOMBOK_ANNOTATION_NAMES,
  synthesizeLombokAccessors,
  withJavaLombokWorkspaceProof,
  type JavaAnnotationProof,
  type JavaLombokAnnotationWorkspaceProof,
  type JavaLombokWorkspaceProof,
} from './lombok-synthesizer.js';

const TYPE_NODES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);
/** Whitespace or a comment, as Java allows between `@`, name parts and dots. */
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*)*`;
const NAME_PART = `[${JAVA_IDENTIFIER_PART_CHARS}]+`;
const ANNOTATION_NAME = new RegExp(
  String.raw`@${GAP}(${NAME_PART}(?:${GAP}\.${GAP}${NAME_PART})*)`,
  'gu',
);
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

export interface TypeEntry {
  readonly filePath: string;
  readonly declaringScope: ScopeId | null;
  readonly packageName: string;
  readonly fact: JavaOverloadTypeFact;
  readonly facts: JavaOverloadFileFacts;
  /** Lexical member type names, any access. */
  readonly memberNames: Set<string>;
  readonly members: TypeEntry[];
  parent?: TypeEntry;
}
interface InheritedNames {
  /** Member types inherited from supertypes, filtered by access (JLS 8.5). */
  readonly members: readonly TypeEntry[];
  readonly names: ReadonlySet<string>;
  /** A supertype could not be decided, so any name may be inherited. */
  readonly unknown: boolean;
}
/** `external`: not declared in this workspace, so it adds no workspace names. */
type ResolvedBase = TypeEntry | 'object' | 'external' | 'unknown';

/** Private member types are never inherited; package access stays in its package. */
function inheritsMemberType(member: TypeEntry, heir: TypeEntry): boolean {
  const modifiers = member.fact.modifiers;
  // Unrecorded access cannot exclude the name.
  if (modifiers === undefined) return true;
  if (modifiers.includes('private')) return false;
  if (modifiers.includes('public') || modifiers.includes('protected')) return true;
  return member.packageName === heir.packageName;
}
/** Whether a single-static-import in `from`'s package imports this member type (JLS 7.5.3). */
function staticallyImportsMemberType(
  from: Pick<TypeEntry, 'packageName'>,
  member: TypeEntry,
): JavaAnnotationProof {
  const modifiers = member.fact.modifiers;
  if (modifiers === undefined) return 'uncertain';
  if (modifiers.includes('private')) return false;
  // A protected member type of another package is not accessible from an
  // import declaration (outside every subclass body); leave it undecided.
  if (!modifiers.includes('public') && member.packageName !== from.packageName)
    return modifiers.includes('protected') ? 'uncertain' : false;
  // Only static members are imported. Member interfaces, enums, records and
  // annotation types, and every member type of an interface, are static.
  const ownerKind = member.parent?.fact.kind;
  return modifiers.includes('static') ||
    member.fact.kind !== 'class_declaration' ||
    ownerKind === 'interface_declaration' ||
    ownerKind === 'annotation_type_declaration'
    ? true
    : 'uncertain';
}
interface Correction {
  readonly tree: Parser.Tree;
  readonly proof: JavaLombokWorkspaceProof;
  readonly removed: readonly SymbolDefinition[];
}
const corrections = new WeakMap<ParsedFile['scopes'], Correction>();

function workspaceInventory(parsedFiles: readonly ParsedFile[]) {
  const byFile = new Map<string, Map<string, TypeEntry>>();
  const byFqn = new Map<string, TypeEntry[]>();
  const declaredNames: [string, TypeEntry][] = [];
  /** Top-level types by package, then simple name: one index per reconcile. */
  const packageTypes = new Map<string, Map<string, TypeEntry[]>>();
  const simpleNames = new Set<string>();
  /** Simple names of type facts without a matching Class scope, by file. */
  const unmappedNames = new Map<string, Set<string>>();
  for (const parsed of parsedFiles) {
    const pkg = getJavaPackageFact(parsed.filePath);
    const facts = getJavaOverloadFacts(parsed.filePath);
    if (pkg?.status !== 'known' || facts === undefined) continue;
    const classes = parsed.scopes.filter((scope) => scope.kind === 'Class');
    const scopes = new Map(classes.map((scope) => [rangeKey(scope.range), scope]));
    // Anonymous facts start at the creation expression or enum constant. Their
    // Class scopes start at the body, and both end at the same closing brace.
    const scopesByEnd = new Map(
      classes.map((scope) => [`${scope.range.endLine}:${scope.range.endCol}`, scope]),
    );
    const byScope = new Map<string, TypeEntry>();
    const entries = new Map<string, TypeEntry>();
    for (const fact of facts.types) {
      const named = TYPE_NODES.has(fact.kind);
      const scope = named
        ? scopes.get(rangeKey(fact.range))
        : scopesByEnd.get(`${fact.range.endLine}:${fact.range.endCol}`);
      if (scope === undefined) {
        const unmapped = unmappedNames.get(parsed.filePath) ?? new Set<string>();
        unmapped.add(fact.simpleName);
        unmappedNames.set(parsed.filePath, unmapped);
        continue;
      }
      const entry: TypeEntry = {
        filePath: parsed.filePath,
        declaringScope: scope.parent,
        packageName: pkg.packageName,
        fact,
        facts,
        memberNames: new Set(),
        members: [],
      };
      entries.set(rangeKey(scope.range), entry);
      byScope.set(scope.id, entry);
      if (!named) continue;
      simpleNames.add(fact.simpleName);
      if (scope.parent === parsed.moduleScope) {
        declaredNames.push([
          pkg.packageName ? `${pkg.packageName}.${fact.simpleName}` : fact.simpleName,
          entry,
        ]);
        const top = packageTypes.get(pkg.packageName) ?? new Map<string, TypeEntry[]>();
        const named = top.get(fact.simpleName) ?? [];
        named.push(entry);
        top.set(fact.simpleName, named);
        packageTypes.set(pkg.packageName, top);
      }
    }
    for (const [key, entry] of entries) {
      const parentId = scopes.get(key)?.parent;
      const parent = parentId == null ? undefined : byScope.get(parentId);
      if (parent !== undefined) {
        entry.parent = parent;
        if (!TYPE_NODES.has(entry.fact.kind)) continue;
        parent.memberNames.add(entry.fact.simpleName);
        parent.members.push(entry);
      }
    }
    byFile.set(parsed.filePath, entries);
  }
  // Java source imports use canonical member names, regardless of the graph's binary spelling.
  for (const [name, entry] of declaredNames) {
    const candidates = byFqn.get(name) ?? [];
    candidates.push(entry);
    byFqn.set(name, candidates);
    for (const member of entry.members)
      declaredNames.push([`${name}.${member.fact.simpleName}`, member]);
  }

  const visible = (from: Pick<TypeEntry, 'filePath' | 'packageName'>, target: TypeEntry) =>
    isJvmSourceVisible(from.filePath, target.filePath) &&
    (from.packageName === target.packageName || target.fact.modifiers?.includes('public') === true);
  /**
   * The member types a single-static-import of `head` brings into `entry`'s
   * file (JLS 7.5.3): declared or inherited by a workspace owner. `external`
   * when the owner is not in the workspace, so the import may name a type or
   * only a field or method; `unknown` when the owner or its members cannot be
   * decided.
   */
  const staticImported = (
    entry: TypeEntry,
    head: string,
  ): { readonly types: readonly TypeEntry[]; readonly external: boolean } | 'unknown' => {
    const types = new Set<TypeEntry>();
    let external = false;
    for (const item of entry.facts.imports) {
      if (!item.static || item.wildcard) continue;
      const dot = item.name.lastIndexOf('.');
      if (dot < 0 || item.name.slice(dot + 1) !== head) continue;
      const ownerName = item.name.slice(0, dot);
      const owners = (byFqn.get(ownerName) ?? []).filter((target) => visible(entry, target));
      if (owners.length === 0) {
        // Like a qualified base, a path through an inherited member type may
        // still name a workspace owner that this literal lookup missed.
        if (simpleNames.has(ownerName.slice(ownerName.lastIndexOf('.') + 1))) return 'unknown';
        external = true;
        continue;
      }
      if (owners.length > 1) return 'unknown';
      const owner = owners[0]!;
      const inherited = namesOf(owner);
      const members = [...owner.members, ...inherited.members].filter(
        (member) => member.fact.simpleName === head && visible(entry, member),
      );
      if (members.length === 0 && inherited.unknown) return 'unknown';
      for (const member of members) types.add(member);
    }
    return { types: [...types], external };
  };
  const memberTypeNamed = (owner: TypeEntry, head: string): TypeEntry | 'unknown' | undefined => {
    const declared = owner.memberNames.has(head);
    const inherited = declared ? undefined : namesOf(owner);
    if (inherited?.unknown) return 'unknown';
    if (!declared && !inherited?.names.has(head)) return undefined;
    const members = (inherited?.members ?? owner.members).filter(
      (member) => member.fact.simpleName === head,
    );
    return members.length === 1 ? members[0] : 'unknown';
  };
  const nestedBase = (entry: TypeEntry, root: TypeEntry, names: string[]): ResolvedBase => {
    let target = root;
    for (const name of names) {
      const member = memberTypeNamed(target, name);
      if (!member || member === 'unknown' || !visible(entry, member)) return 'unknown';
      target = member;
    }
    return target;
  };
  const lexicalBase = (entry: TypeEntry, raw: string, head: string): ResolvedBase | undefined => {
    for (let owner = entry.parent; owner !== undefined; owner = owner.parent) {
      if (owner.fact.typeParameters.includes(head)) return 'unknown';
      const root =
        memberTypeNamed(owner, head) ?? (owner.fact.simpleName === head ? owner : undefined);
      if (root === undefined) continue;
      return root === 'unknown' || raw === head
        ? root
        : nestedBase(entry, root, raw.split('.').slice(1));
    }
    return undefined;
  };
  const resolveBase = (entry: TypeEntry, written: string): ResolvedBase => {
    const raw = eraseJavaTypeArguments(written).replace(/\s+/g, '');
    if (!JAVA_DOTTED_SPELLING.test(raw)) return 'unknown';
    const head = raw.split('.')[0]!;
    // Types in an enclosing body shadow both single imports and package names (JLS 6.4.1).
    const lexical = lexicalBase(entry, raw, head);
    if (lexical !== undefined) return lexical;
    const imports = entry.facts.imports.filter((item) => !item.static && !item.wildcard);
    const explicit = imports.filter((item) => item.name.split('.').pop() === head);
    // A single-static-import of a member type shadows like a single-type import.
    const statics = staticImported(entry, head);
    if (statics === 'unknown' || explicit.length > 1) return 'unknown';
    if (statics.types.length > 0) {
      // Two single imports of one simple name must agree; do not pick one.
      if (explicit.length > 0) return 'unknown';
      if (statics.types.length !== 1) return 'unknown';
      return nestedBase(entry, statics.types[0]!, raw.split('.').slice(1));
    }
    const resolved = resolveUnimported(entry, raw, head, explicit);
    // An owner outside the workspace may import a type of this name, which
    // would shadow a workspace candidate; it adds no workspace names itself.
    return statics.external && resolved !== 'external' ? 'unknown' : resolved;
  };
  const resolveUnimported = (
    entry: TypeEntry,
    raw: string,
    head: string,
    explicit: readonly { readonly name: string }[],
  ): ResolvedBase => {
    let spellings: string[];
    if (explicit.length === 1) spellings = [explicit[0]!.name + raw.slice(head.length)];
    else if (raw.includes('.')) spellings = [raw];
    else {
      const same = `${entry.packageName === '' ? '' : entry.packageName + '.'}${raw}`;
      spellings = byFqn.has(same)
        ? [same]
        : entry.facts.imports
            .filter((item) => item.wildcard && !item.static)
            .map((item) => `${item.name.replace(/\.\*$/, '')}.${raw}`);
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
    if (candidates.length > 1) return 'unknown';
    // A base absent from the workspace (`RuntimeException`, `java.io.Serializable`,
    // any library type) declares no workspace member types. Only a qualified
    // spelling read literally (`Outer.Inner` of a same-package Outer) may
    // still name a workspace type that the lookup above missed.
    return explicit.length === 0 && raw.includes('.') && simpleNames.has(raw.split('.').pop()!)
      ? 'unknown'
      : 'external';
  };
  const inherited = new Map<TypeEntry, InheritedNames>();
  const visiting = new Set<TypeEntry>();
  const namesOf = (entry: TypeEntry): InheritedNames => {
    const cached = inherited.get(entry);
    if (cached !== undefined) return cached;
    if (visiting.has(entry)) return { members: [], names: new Set(), unknown: true };
    visiting.add(entry);
    const members = new Set<TypeEntry>();
    let unknown = false;
    for (const base of entry.fact.bases) {
      const target = resolveBase(entry, base);
      if (target === 'object' || target === 'external') continue;
      if (target === 'unknown') {
        unknown = true;
        continue;
      }
      const ancestors = namesOf(target);
      for (const member of [...target.members, ...ancestors.members])
        if (inheritsMemberType(member, entry)) members.add(member);
      unknown ||= ancestors.unknown;
    }
    visiting.delete(entry);
    const result = {
      members: [...members],
      names: new Set([...members].map((member) => member.fact.simpleName)),
      unknown,
    };
    inherited.set(entry, result);
    return result;
  };
  /** Every supertype is a workspace type or Object, so all member types are known. */
  const closed = new Map<TypeEntry, boolean>();
  const isClosed = (entry: TypeEntry): boolean => {
    const cached = closed.get(entry);
    if (cached !== undefined) return cached;
    // A cyclic hierarchy is not a known one.
    closed.set(entry, false);
    const result = entry.fact.bases.every((base) => {
      const target = resolveBase(entry, base);
      return target === 'object' || (typeof target === 'object' && isClosed(target));
    });
    closed.set(entry, result);
    return result;
  };
  const staticMemberType = (
    from: Pick<TypeEntry, 'filePath' | 'packageName'>,
    ownerName: string,
    head: string,
  ): JavaAnnotationProof => {
    const owners = (byFqn.get(ownerName) ?? []).filter((target) => visible(from, target));
    if (owners.length === 0 && JAVA_PLATFORM_OWNERS_WITHOUT_MEMBER_TYPES.has(ownerName))
      return false;
    if (owners.length !== 1) return 'uncertain';
    const owner = owners[0]!;
    let result: JavaAnnotationProof =
      !isClosed(owner) || unmappedNames.get(owner.filePath)?.has(head) === true
        ? 'uncertain'
        : false;
    for (const member of [...owner.members, ...namesOf(owner).members]) {
      if (member.fact.simpleName !== head || !TYPE_NODES.has(member.fact.kind)) continue;
      const imported = staticallyImportsMemberType(from, member);
      if (imported === true) return true;
      if (imported === 'uncertain') result = 'uncertain';
    }
    return result;
  };
  /**
   * Whether a single-static-import of `head` in `from`'s file imports a member
   * type (JLS 7.5.3): `true` when a workspace owner declares or inherits an
   * accessible static member type of that name; `false` when each owner and its
   * whole hierarchy are in the workspace without one, so the import names only
   * fields or methods; `uncertain` for an owner outside the workspace or an
   * ambiguous one.
   */
  const staticImportsType = (
    from: Pick<TypeEntry, 'filePath' | 'packageName' | 'facts'>,
    head: string,
  ): JavaAnnotationProof => {
    let result: JavaAnnotationProof = false;
    for (const item of from.facts.imports) {
      if (!item.static || item.wildcard) continue;
      const name = stripGaps(item.name);
      const dot = name.lastIndexOf('.');
      if (dot < 0 || name.slice(dot + 1) !== head) continue;
      const imported = staticMemberType(from, name.slice(0, dot), head);
      if (imported === true) return true;
      if (imported === 'uncertain') result = 'uncertain';
    }
    return result;
  };
  return { byFile, packageTypes, namesOf, staticImportsType, staticMemberType };
}

export type JavaWorkspaceTypeInventory = ReturnType<typeof workspaceInventory>;

interface WorkspaceContext {
  readonly fileContents: ReadonlyMap<string, string>;
  readonly treeCache?: { get(filePath: string): unknown };
}

export function reconcileJavaWorkspaceReferences(
  parsedFiles: ParsedFile[],
  ctx: WorkspaceContext,
): void {
  const inventory = workspaceInventory(parsedFiles);
  reconcileJavaLombokWorkspaceProof(parsedFiles, ctx, inventory);
  bindJavaQualifiedHeritage(parsedFiles, inventory);
}

/** Reconcile only files whose file-local annotation proof can be shadowed by siblings. */
export function reconcileJavaLombokWorkspaceProof(
  parsedFiles: ParsedFile[],
  ctx: WorkspaceContext,
  inventory = workspaceInventory(parsedFiles),
): void {
  for (let i = 0; i < parsedFiles.length; i++) {
    const original = parsedFiles[i]!;
    corrections.delete(original.scopes);
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
    // Comments may sit between `@`, the name parts and the dots: `@/*c*/Value`.
    for (const match of source.matchAll(ANNOTATION_NAME)) {
      const name = stripGaps(match[1]!);
      if (!LOMBOK_ANNOTATION_NAMES.has(name.split('.').pop()!)) continue;
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
    // Look up only the names this file uses in the per-reconcile package index.
    const packageIndex = inventory.packageTypes.get(pkg.packageName);
    const hasSibling = (name: string, foreignOnly: boolean) =>
      (packageIndex?.get(name) ?? []).some(
        (entry) =>
          // The leaf import proof already sees declarations in its own file.
          (!foreignOnly || entry.filePath !== original.filePath) &&
          isJvmSourceVisible(original.filePath, entry.filePath),
      );
    // A single-type import shadows package siblings. A single-static-import
    // does so only when it imports a member type, and the leaf proof then
    // refuses that name itself; one importing a field leaves the sibling.
    const named = new Set(
      facts.imports
        .filter((item) => !item.wildcard && !item.static)
        .map((item) => item.name.split('.').pop()!),
    );
    const packageCanShadow = annotations.some((name) =>
      name.includes('.')
        ? hasSibling(name.split('.')[0]!, true)
        : hasSibling(name, true) && !named.has(name),
    );
    // The leaf proof leaves a single-static-import of an annotation name
    // uncertain; a workspace owner may decide whether it names a member type.
    const staticNames = new Set(
      facts.imports
        .filter((item) => !item.wildcard && item.static)
        .map((item) => stripGaps(item.name).split('.').pop()!),
    );
    const staticVerdicts = new Map<string, JavaAnnotationProof>();
    const staticImportsType = (name: string): JavaAnnotationProof => {
      let verdict = staticVerdicts.get(name);
      if (verdict === undefined) {
        verdict = staticNames.has(name)
          ? inventory.staticImportsType(
              { filePath: original.filePath, packageName: pkg.packageName, facts },
              name,
            )
          : 'uncertain';
        staticVerdicts.set(name, verdict);
      }
      return verdict;
    };
    const staticCanDecide = annotations.some(
      (name) => staticNames.has(name) && staticImportsType(name) !== 'uncertain',
    );
    // Only use positional filtering when every type has an equal-range scope.
    // Anonymous facts include their base and arguments outside the owning body.
    const completeTypeCoverage = facts.types.every((fact) => entries.has(rangeKey(fact.range)));
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
    if (!packageCanShadow && !inheritedCanShadow && !staticCanDecide) continue;
    const annotationProof: JavaLombokAnnotationWorkspaceProof = (written, _qualified, context) => {
      const root = written.split('.')[0]!;
      if (
        written.includes('.')
          ? hasSibling(root, false)
          : hasSibling(written, false) && !named.has(written)
      )
        return false;
      // A definite shadow at any level refuses. An undecidable level only
      // makes the answer uncertain: it may hide the name or not.
      let uncertain = false;
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
        if (entry === undefined) {
          uncertain = true;
          continue;
        }
        const inherited = inventory.namesOf(entry);
        if (inherited.names.has(root)) return false;
        if (inherited.unknown) uncertain = true;
      }
      return uncertain ? 'uncertain' : true;
    };
    const proof: JavaLombokWorkspaceProof = { annotation: annotationProof, staticImportsType };
    const tree =
      (ctx.treeCache?.get(original.filePath) as Parser.Tree | undefined) ??
      parseSourceSafe(getJavaParser(), source, undefined, {
        bufferSize: getTreeSitterBufferSize(source),
      });
    // Re-extraction rewrites this file's module-level facts; a failed one may
    // leave them partial, so restore the snapshot taken here.
    const capturedBefore = collectJavaCaptureSideChannel(original.filePath);
    const corrected = withJavaLombokWorkspaceProof(tree, proof, () => {
      const parsed = extractParsedFile(javaProvider, source, original.filePath, undefined, tree);
      if (parsed === undefined) return undefined;
      const captureSideChannel = javaProvider.collectCaptureSideChannel?.(original.filePath);
      return { ...parsed, ...(captureSideChannel === undefined ? {} : { captureSideChannel }) };
    });
    // A failed re-extraction cannot verify a veto: keep the file-local result
    // (and its captured facts) rather than fail every Java file in this pass.
    if (corrected === undefined) {
      applyJavaCaptureSideChannel({ ...original, captureSideChannel: capturedBefore });
      continue;
    }
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
    corrections.set(next.scopes, { tree, proof, removed });
  }
}

/** The Java heritage hook runs before the shared graph lookup is rebuilt. */
export function emitJavaLombokWorkspaceCorrections(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  for (const parsed of parsedFiles) {
    const correction = corrections.get(parsed.scopes);
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
    corrections.delete(parsed.scopes);
  }
}

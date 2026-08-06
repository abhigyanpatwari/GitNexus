/**
 * Build a `(filePath, name) → graphNodeId` lookup over the graph's
 * Function/Method/Class/Constructor nodes. Two keys per node:
 *
 *   - simple name (`User` / `save`) — legacy fallback
 *   - qualified name when derivable from the node id (`User.save`)
 *
 * The qualified key is the authoritative one when two classes in the
 * same file define a method with the same simple name
 * (`class User: def save` + `class Document: def save`). Without it,
 * the simple-name key collides and every `document.save()` CALLS edge
 * would silently target `User.save`. Method node ids encode the
 * qualifier (`Method:file.py:User.save#1`), so we parse it back out.
 *
 * Language-agnostic seam. Any language provider migrating to the
 * registry-primary path can consume this to translate scope-resolution
 * `SymbolDefinition.nodeId` values into the legacy graph-node ID
 * format that downstream consumers (queries, edges, MCP) expect.
 */

import type { NodeLabel, ParameterTypeClass } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import {
  isOverloadableCallable,
  isPositionQualifiedLocalLabel,
} from '../../utils/callable-labels.js';
import { templateConstraintsIdTag } from '../../utils/template-arguments.js';
import { parameterShapeIdTag } from '../../utils/method-props.js';

export type GraphNodeLookup = ReadonlyMap<string, string>;

/**
 * Parse a qualified name out of a Function/Method node id.
 *
 * Node id format: `${label}:${filePath}:${qualifiedName}${arityTag}`,
 * where `arityTag` is `#<n>` (or empty). Strips the known-length
 * label + filePath prefix so colons inside `filePath` (Windows
 * `C:\...`) don't break the parse. Returns `undefined` when the id
 * doesn't match the expected shape.
 */
function parseQualifiedFromId(id: string, label: NodeLabel, filePath: string): string | undefined {
  const prefix = `${label}:${filePath}:`;
  if (!id.startsWith(prefix)) return undefined;
  const suffix = id.slice(prefix.length);
  if (suffix.length === 0) return undefined;
  const hash = suffix.indexOf('#');
  return hash === -1 ? suffix : suffix.slice(0, hash);
}

function stripCallableDisambiguatorTags(qualifiedName: string): string {
  return qualifiedName.replace(/~shape:.*$/, '').replace(/~c:[a-z0-9]+$/, '');
}

/**
 * Build a qualified-key string in a separate keyspace from simple-key
 * strings. Prefix `<q>` can't appear in a valid filePath on any OS, so
 * no collision between the two keyspaces is possible.
 *
 * Includes the node label so a top-level `def save` (Function,
 * qualifier = `save`) doesn't alias a class method `User.save` (Method,
 * simple name = `save`) whose Function-typed qualifier would collapse
 * to the same simple-key slot in a single map.
 */
export function qualifiedKey(filePath: string, label: NodeLabel, qualifiedName: string): string {
  return `<q>:${filePath}::${label}::${qualifiedName}`;
}

/** Simple-name key (legacy fallback keyspace — no `<q>` prefix). */
export function simpleKey(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

/**
 * Position key: `(filePath, label, 0-based startLine, simple name)` (#2699).
 *
 * The strongest evidence there is, and the only one that needs no name
 * qualification at all — a definition and its graph node are the same
 * construct, so they share a source position. That makes it correct for
 * exactly the cases a name-based key cannot express: a function-local
 * declaration shadowing a file-level one, a local inside an ANONYMOUS
 * function (no name to qualify with), and two same-named declarations in
 * sibling blocks. ECMAScript gives each of those its own environment record;
 * position is what distinguishes them without having to model the chain.
 *
 * Registered only for callable labels, and only when the (line, name) pair is
 * unique in the file — a genuine tie (overloads declared on one line) stores
 * the `AMBIGUOUS_POSITION` tombstone so the caller falls through to the
 * name-based keys rather than picking by source order.
 */
export function positionKey(
  filePath: string,
  label: NodeLabel,
  startLine: number,
  name: string,
): string {
  return `<p>:${filePath}::${label}::${startLine}::${name}`;
}

/**
 * Key recording that a FUNCTION-LOCAL callable with this simple name exists in the
 * file (#2699 follow-up).
 *
 * `resolveDefGraphId`'s last resort is a label-agnostic, first-write-wins
 * `simpleKey(filePath, simpleName)`. That is safe while at most one callable in a file
 * carries a given simple name — but #2699 deliberately creates function-locals that
 * share a name with a file-level callable, and the local's graph node is keyed by
 * position (`run.pick@1:2`) while the scope def is not. When the position join misses —
 * the two id phases anchor on different nodes, so a multiline `const pick =` puts the
 * declaration and its initializer on different lines — the simple-name fallback aliases
 * the local onto whichever same-named callable was registered FIRST and mints a
 * fabricated edge. That is the exact failure class #2693 already shipped once.
 *
 * This lets the resolver fail CLOSED for precisely that case and only that case: if a
 * local of this name exists, a position miss is a genuine ambiguity rather than a lookup
 * gap, so emitting no edge is correct. Files with no such local are untouched, which
 * keeps legitimate anchor differences (e.g. a Vue SFC `lineOffset`) resolving through the
 * name keys exactly as before.
 */
export function localNameKey(filePath: string, label: NodeLabel, name: string): string {
  return `<l>:${filePath}::${label}::${name}`;
}

/** Tombstone for a position claimed by two nodes — see `positionKey`. */
export const AMBIGUOUS_POSITION = '';

export function buildGraphNodeLookup(graph: KnowledgeGraph): GraphNodeLookup {
  const lookup = new Map<string, string>();
  for (const node of graph.iterNodes()) {
    const props = node.properties as {
      filePath?: string;
      name?: string;
      qualifiedName?: string;
      templateArguments?: readonly string[];
    };
    if (props.filePath === undefined || props.name === undefined) continue;
    if (!isLinkableLabel(node.label)) continue;

    // Position key (#2699) — see `positionKey`. Second write on a key marks it
    // ambiguous rather than letting source order decide.
    const startLine = (props as { startLine?: number }).startLine;
    if (startLine !== undefined && isPositionQualifiedLocalLabel(node.label)) {
      const posK = positionKey(props.filePath, node.label, startLine, props.name);
      lookup.set(posK, lookup.has(posK) ? AMBIGUOUS_POSITION : node.id);
      // A local-identity node carries `@<row>:<col>` on its last name segment. Record
      // that a local of this simple name exists, so the resolver can fail closed on a
      // position miss instead of aliasing through the simple-name fallback.
      const qualForLocal = parseQualifiedFromId(node.id, node.label, props.filePath);
      if (qualForLocal !== undefined && /@\d+:\d+$/.test(qualForLocal)) {
        lookup.set(localNameKey(props.filePath, node.label, props.name), node.id);
      }
    }

    // Primary key: fully-qualified name + label, in a separate
    // keyspace from simple names. Class nodes carry `qualifiedName`
    // in their properties (set by the parsing processor).
    // Method/Function nodes do not, so derive the qualifier from the
    // node id — that's where the parse-phase encoded it. Including
    // the label avoids a collision when a free Function's qualifier
    // happens to equal a Method's simple name (e.g. top-level
    // `def save` vs `class User: def save`).
    const qualified =
      props.qualifiedName ?? parseQualifiedFromId(node.id, node.label, props.filePath);
    if (qualified !== undefined && qualified.length > 0) {
      const keyQualified = stripCallableDisambiguatorTags(qualified);
      const qKey = qualifiedKey(props.filePath, node.label, keyQualified);
      if (!lookup.has(qKey)) lookup.set(qKey, node.id);
      // Overload-disambiguating key: include parameter types so two
      // same-arity overloads (e.g. `Lookup(int)` vs `Lookup(string)`)
      // map to distinct graph nodes. Legacy parse-phase encodes the
      // type tag into the node id; we register both that node id and
      // a parameter-types-suffixed key so resolveDefGraphId can find
      // the right overload by matching its def's parameterTypes.
      const pTypes = (props as { parameterTypes?: readonly string[] }).parameterTypes;
      if (pTypes !== undefined && pTypes.length > 0 && isOverloadableCallable(node.label)) {
        const pKey = qualifiedKey(
          props.filePath,
          node.label,
          `${keyQualified}~${pTypes.join(',')}`,
        );
        // Each overload is unique — set unconditionally.
        if (!lookup.has(pKey)) lookup.set(pKey, node.id);
      }
      // Arity-disambiguating key: include the parameter count so two same-name
      // overloads of DIFFERENT arity route to distinct graph nodes even when the
      // shorter overload carries no parameter types (e.g. a Kotlin zero-arg
      // secondary constructor vs a 2-arg one — both share the qualified key, whose
      // first-write-wins assignment is source-order-dependent). The structure-phase
      // node id encodes `#<arity>`; this mirrors it in the lookup keyspace so
      // resolveDefGraphId can match by the def's own parameterCount. Same-arity
      // overloads collapse onto one arity key (first-write-wins) — identical to the
      // pre-existing qualified-key behavior, so no regression there.
      const pCount = (props as { parameterCount?: number }).parameterCount;
      if (pCount !== undefined && isOverloadableCallable(node.label)) {
        const aKey = qualifiedKey(props.filePath, node.label, `${keyQualified}#${pCount}`);
        if (!lookup.has(aKey)) lookup.set(aKey, node.id);
      }
      const pClasses = (props as { parameterTypeClasses?: readonly ParameterTypeClass[] })
        .parameterTypeClasses;
      const shapeTag = parameterShapeIdTag(pTypes, pClasses);
      if (shapeTag !== '' && isOverloadableCallable(node.label)) {
        const shapeKey = qualifiedKey(props.filePath, node.label, `${keyQualified}${shapeTag}`);
        if (!lookup.has(shapeKey)) lookup.set(shapeKey, node.id);
      }
      // SFINAE / `requires`-clause disambiguation (issue #1579) — register
      // a constraint-fingerprinted key so resolveDefGraphId can locate the
      // correct overload by hashing the def's `templateConstraints`. Mirrors
      // the parameter-types key but keys on the opaque constraint payload
      // instead, separating two `process<T>` overloads whose
      // `parameterTypes=['T']` would otherwise collide.
      const tConstraints = (props as { templateConstraints?: unknown }).templateConstraints;
      if (tConstraints !== undefined && (node.label === 'Function' || node.label === 'Method')) {
        const cKey = qualifiedKey(
          props.filePath,
          node.label,
          `${keyQualified}${templateConstraintsIdTag(tConstraints)}`,
        );
        lookup.set(cKey, node.id);
      }
      if (
        (node.label === 'Class' ||
          node.label === 'Struct' ||
          node.label === 'Interface' ||
          node.label === 'Enum' ||
          node.label === 'Record') &&
        props.templateArguments !== undefined &&
        props.templateArguments.length > 0
      ) {
        const tKey = qualifiedKey(
          props.filePath,
          node.label,
          `${keyQualified}~${props.templateArguments.join(',')}`,
        );
        if (!lookup.has(tKey)) lookup.set(tKey, node.id);
      }
    }

    // Fallback key: simple name. Source-order first-wins within a file — used when
    // the caller doesn't know the qualifier (unqualified free-call
    // fallback, cross-file resolution where MethodRegistry already
    // disambiguated the owner).
    const sKey = simpleKey(props.filePath, props.name);
    if (!lookup.has(sKey)) lookup.set(sKey, node.id);
  }
  return lookup;
}

/**
 * Every label {@link buildGraphNodeLookup} registers — and therefore the ONLY
 * labels `resolveDefGraphId` can ever return an id for. Both endpoints of every
 * scope-resolution edge come from that lookup (the one exception is the File
 * fallback in `resolveCallerGraphId`), so this set defines the whole FROM/TO
 * surface those edges can produce.
 *
 * That makes it load-bearing for the LadybugDB relation DDL: a label added here
 * without the matching `FROM x TO y` pairs in `RELATION_SCHEMA` crashes
 * `analyze` at `assertDeclaredPair` on whichever codebase first emits the pair
 * (#2792). `test/unit/schema-pair-coverage.test.ts` derives the required pairs
 * from this set and fails in CI instead.
 */
export const LINKABLE_LABELS: ReadonlySet<NodeLabel> = new Set<NodeLabel>([
  'Function',
  'Method',
  'Constructor',
  // Program-like module declarations are provider-gated callable-value
  // targets and need the same def→graph bridge.
  'Module',
  'Class',
  'Interface',
  'Struct',
  'Enum',
  // Trait nodes are linkable so MRO builders can bridge PHP/Rust trait
  // defs between scope-resolution DefIds and the graph's node ids.
  // IMPLEMENTS edges from classes to traits are otherwise invisible to
  // the scope-resolution MRO pass.
  'Trait',
  // TypeAlias is linkable for the same reason Trait is (R2-2). The alias
  // resolves fine — `CLASS_KINDS` has always listed it, and the ClassRegistry
  // returns the def — but without an entry here `resolveDefGraphId` cannot
  // bridge that def to its graph node, so the edge is dropped after a
  // SUCCESSFUL lookup. That is why an exported contract type owned its members
  // and still reported `incoming: {}`: the failure was one table away from
  // everything that appeared to be responsible.
  //
  // Covers every language that spells an alias this way — TypeScript, Kotlin,
  // Dart and Rust all emit `@declaration.type_alias`. The remaining
  // `CLASS_KINDS` entries (Typedef, Record, Union, Delegate, Annotation,
  // Template) plausibly have the same gap, but nothing exercises them today
  // and adding labels no test covers is how this list drifts out of sync with
  // what it claims.
  'TypeAlias',
  // Variable / Property are linkable too — receiver-bound write/read
  // ACCESSES edges target field nodes (e.g. `user.name = "x"` →
  // ACCESSES edge to User's `name` Variable/Property node).
  'Variable',
  'Property',
  // Const is linkable so the value-receiver-owner bridge in
  // `receiver-bound-calls.ts` Case 5 can translate the scope-resolution
  // `Variable` def for `export const fooService = {...}` to the canonical
  // `Const:filePath:name` graph node id, against which object-literal
  // method symbols register their `ownerId` (PR #1718 / issue #1358).
  'Const',
  // Macro nodes are linkable so a macro invocation (`log!(…)`) resolved
  // via `MacroRegistry` can bridge its scope-resolution `Macro` def to
  // the legacy `@definition.macro` graph node and emit the `USES` edge
  // (Rust #1934 F72; also covers C/C++ `#define` macro defs).
  'Macro',
]);

export function isLinkableLabel(label: NodeLabel): boolean {
  return LINKABLE_LABELS.has(label);
}

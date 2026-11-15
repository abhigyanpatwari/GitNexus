/**
 * `emitDartScopeCaptures` — the Dart scope-capture orchestrator (mirror of
 * `languages/swift/captures.ts`, adapted for tree-sitter-dart's grammar).
 *
 * It runs `DART_SCOPE_QUERY` for the constructs that map cleanly to a single
 * node (module/class scopes, type/method/field declarations, imports), then
 * synthesizes the Dart-specific streams the grammar can't express as a single
 * query node:
 *
 *   1. Function/method/constructor SCOPES — `function_signature`/`function_body`
 *      are SIBLINGS, so each Function scope is synthesized to span
 *      `signature.start .. body.end` (composed range); a constructor's body is
 *      a sibling of the wrapping `method_signature`. Inline closures and local
 *      functions get a Function scope of their own, and every Function scope
 *      carries `@scope.lexical-names`, the names it binds (DART-11).
 *   2. Receiver (`this`/`super`) + parameter + return type bindings, anchored
 *      inside the body so they land in the Function scope.
 *   3. Arity metadata on function-like declarations.
 *   4. Field type bindings (for receiver-chain resolution).
 *   5. References — calls (free/member/cascade) and member reads — from Dart's
 *      postfix `identifier (selector …)` chains, which have no
 *      `call_expression` node.
 *   6. Local-variable constructor/call-result type inference.
 *   7. Heritage — `extends` → `@reference.inherits` (the generic
 *      EXTENDS-by-target-kind pre-pass); `implements`/`with` → side-effect
 *      `__heritage__:` import markers consumed by `emitDartHeritageEdges`
 *      (Dart `implements <class>` must be IMPLEMENTS regardless of the
 *      target's symbol kind).
 */

import Parser from 'tree-sitter';
import type { LanguageProvider } from '../../language-provider.js';
import type { Capture, CaptureMatch, MixedChainStep } from 'gitnexus-shared';
import {
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
  findChild,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { computeDartArityMetadata } from './arity-metadata.js';
import {
  isDartReceiverType,
  isDartStaticWithin,
  synthesizeDartReceiverBinding,
} from './receiver-binding.js';
import {
  synthesizeDartParameterBindings,
  synthesizeDartSignatureBindings,
} from './signature-bindings.js';
import { getDartParser, getDartScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { encodeMarker } from '../../utils/heritage-marker.js';
import { DART_BUILT_INS } from './built-ins.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';
import { synthesizeReceiverChainCapture } from '../../utils/receiver-chain-captures.js';
import { decodeReceiverChain, encodeReceiverChain } from '../../utils/receiver-chain-codec.js';
import { dartUsesWildcardVariables, setDartDefaultLanguageVersion } from './language-version.js';
import { dartMethodConfig } from '../../method-extractors/configs/dart.js';
import { hasKeyword } from '../../field-extractors/configs/helpers.js';

/**
 * `LanguageProvider.scopeOwnsReceivers` for Dart — the read side of
 * `dartShadowedFieldsCapture`, which is where the full rationale lives.
 *
 * Reads the marker rather than re-deriving anything: the names were computed at
 * capture time, where the AST is, and a `CaptureMatch` carries only
 * name/range/text. Kept beside the emitter so the tag string has exactly one
 * producer and one consumer, both in this file's line of sight.
 */
export function dartScopeOwnsReceivers(match: CaptureMatch): ReadonlySet<string> | undefined {
  const raw = match['@receiver-owner.shadowed-fields']?.text;
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const names = parsed.filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  return names.length > 0 ? new Set(names) : undefined;
}

const FUNCTION_DECL_TAGS = [
  '@declaration.function',
  '@declaration.method',
  '@declaration.constructor',
  // A getter / setter stays a graph Property, but its body is executable code:
  // without its own Function scope a setter's parameter and an accessor's
  // locals land in the enclosing Module / Class scope and type same-named
  // receivers elsewhere. This private capture (query.ts) marks accessors only;
  // a class field is a Property too but has no body and never carries it.
  '@dart.accessor',
  '@dart.callable-body',
] as const;

const DART_CALLABLE_CAPTURE_OPTIONS = {
  functionNodeTypes: new Set(['function_signature', 'function_expression']),
  callNodeTypes: new Set(['selector']),
  parameterListNodeTypes: new Set(['formal_parameter_list', 'arguments']),
  parameterNodeTypes: new Set(['formal_parameter']),
  // `initialized_identifier` covers TOP-LEVEL `var` bindings and the second and
  // later declarators of a multi-name local; `static_final_declaration` covers
  // top-level `final`/`const`, which parse into a different list node entirely.
  // Dart wraps only the FIRST local declarator in `initialized_variable_
  // definition`, so without the other two a top-level `var f = (x) => x;`, a
  // `final f = …`, and the `g` of `var f = …, g = …;` all emitted no flow
  // captures at all and never resolved (#2693).
  bindingNodeTypes: new Set([
    'initialized_variable_definition',
    'initialized_identifier',
    'static_final_declaration',
  ]),
  assignmentNodeTypes: new Set(['assignment_expression']),
  identifierNodeTypes: new Set(['identifier', 'type_identifier']),
  // `initialized_identifier` and `static_final_declaration` are FIELDLESS, so
  // the shared field-based fallback (`left`/`name`/`value`/…) decomposes
  // nothing and those bindings produced no flow facts at all — the same shape
  // as Kotlin's fieldless `assignment` node. Positional: first named child is
  // the bound name, last is the initializer.
  // `initialized_variable_definition` carries real `name:` / `value:` fields,
  // so it is left to the shared path by returning undefined.
  extractAssignment: (node: SyntaxNode) => {
    if (node.type !== 'initialized_identifier' && node.type !== 'static_final_declaration') {
      return undefined;
    }
    const named = node.namedChildren.filter((child): child is SyntaxNode => child !== null);
    if (named.length < 2) return undefined;
    return { destination: named[0]!, source: named[named.length - 1]! };
  },
  isCallNode: (node: SyntaxNode) => node.namedChild(0)?.type === 'argument_part',
  callableProtocolMethods: new Set(['call']),
  // tree-sitter-dart spells `a ?? b` as `if_null_expression(first:, second:)`
  // and `c ? a : b` as a `conditional_expression` with `consequence` /
  // `alternative` but NO `condition` field, so neither matches the shared
  // field-based branch rule and only the last operand flowed (#3354).
  valueAlternatives: (node: SyntaxNode) => {
    if (node.type === 'if_null_expression') {
      const first = node.childForFieldName('first');
      const second = node.childForFieldName('second');
      return first !== null && second !== null ? [first, second] : undefined;
    }
    if (node.type === 'conditional_expression') {
      const consequence = node.childForFieldName('consequence');
      const alternative = node.childForFieldName('alternative');
      return consequence !== null && alternative !== null ? [consequence, alternative] : undefined;
    }
    return undefined;
  },
} as const;

interface DartTreeLink {
  readonly parent: SyntaxNode | null;
  readonly previous: SyntaxNode | null;
  readonly next: SyntaxNode | null;
  readonly functionOwner: SyntaxNode | undefined;
  readonly enclosingType: SyntaxNode | null;
  readonly outermostBody: SyntaxNode;
}
type DartTreeLinks = ReadonlyMap<number, DartTreeLink>;

/** Native parent/sibling getters re-descend from the root. Record these links
 *  once so a reference inside a deep closure still costs a constant lookup. */
function indexDartTreeLinks(root: SyntaxNode, staticBefore: Map<number, boolean>): DartTreeLinks {
  const links = new Map<number, DartTreeLink>();
  links.set(root.id, {
    parent: null,
    previous: null,
    next: null,
    functionOwner: undefined,
    enclosingType: null,
    outermostBody: root,
  });
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const link = links.get(node.id)!;
    const type = node.type;
    const functionOwner =
      type === 'function_signature' || type === 'function_expression'
        ? node
        : type === 'function_body' && link.previous?.type === 'function_signature'
          ? link.previous
          : link.functionOwner;
    if (functionOwner !== link.functionOwner) links.set(node.id, { ...link, functionOwner });
    const enclosingType = isDartReceiverType(type) ? node : link.enclosingType;
    const outermostBody =
      link.outermostBody === root &&
      (type === 'function_body' || type === 'function_expression_body')
        ? node
        : link.outermostBody;
    const children = node.namedChildren;
    let memberReceiver = enclosingType;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      // A member's signature and body are siblings. Carry the signature's
      // static boundary through comments into its body and all nested closures.
      if (child.type === 'method_signature' || child.type === 'declaration') {
        const factory = child.namedChildren.some(
          (signature) => signature.type === 'factory_constructor_signature',
        );
        memberReceiver =
          factory || isDartStaticWithin(child, { parent: node, staticBefore })
            ? null
            : enclosingType;
      } else if (child.type !== 'comment' && child.type !== 'function_body') {
        memberReceiver = enclosingType;
      }
      links.set(child.id, {
        parent: node,
        previous: children[i - 1] ?? null,
        next: children[i + 1] ?? null,
        functionOwner,
        enclosingType: memberReceiver,
        outermostBody,
      });
      stack.push(child);
    }
  }
  return links;
}

function dartLexicalFunctionOwner(input: SyntaxNode, links: DartTreeLinks): SyntaxNode | undefined {
  return links.get(input.id)?.functionOwner;
}

export function emitDartScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
  _sourceMeta?: Parameters<NonNullable<LanguageProvider['emitScopeCaptures']>>[3],
  languageVersion?: string,
): readonly CaptureMatch[] {
  let tree: Parser.Tree;
  if (cachedTree !== undefined && cachedTree !== null) {
    tree = cachedTree as Parser.Tree;
    recordCacheHit();
  } else {
    tree = parseSourceSafe(getDartParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordCacheMiss();
  }

  const root = tree.rootNode;
  setDartDefaultLanguageVersion(root, languageVersion ?? '3.7', filePath);
  const staticBefore = new Map<number, boolean>();
  const treeLinks = indexDartTreeLinks(root, staticBefore);
  const out: CaptureMatch[] = [];

  // A named constructor (`A.named()`) parses as ONE `constructor_signature`
  // carrying multiple `name:` fields, so the `@declaration.constructor` query
  // pattern matches it more than once. Each match would synthesize an
  // identical-range `@scope.function`, producing duplicate scope ids that make
  // `buildScopeTree` throw and the whole file get dropped. Dedup function-like
  // declarations by their statement node so each is emitted exactly once.
  const seenFnDeclNodes = new Set<string>();

  // Shared, per-file. Pass A (the receiver mask below) and Pass B
  // (`emitDartFieldAssignmentBindings`) ask the SAME two questions of the same
  // nodes — "what does this class declare as a field" and "what does this
  // member body bind" — so the memo makes each answer cost one walk per node
  // for the whole file instead of one per consumer.
  const memo: DartClassMemo = {
    fieldsByClassBody: new Map(),
    shadowsByBody: new Map(),
    censusByBody: new Map(),
    inferenceByInitializer: new Map(),
  };

  // `p` of every `import '…' deferred as p;` in this file, for
  // `namesDeferredLoadLibrary`. Stays undefined for a file with no deferred
  // import, which then returns `out` untouched.
  let deferredPrefixes: Set<string> | undefined;

  // Every Function scope this file emits, keyed by its body span. Pass B's
  // single tree walk files each binder under the body that owns it, and the
  // names ride the scope match as `@scope.lexical-names` once the walk ends.
  const lexicalScopes: DartLexicalScopes = new Map();

  // ── Pass A: query-driven scopes / declarations / imports ────────────────
  for (const match of getDartScopeQuery().matches(root)) {
    const grouped: Record<string, Capture> = {};
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of match.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    const importNode = nodeMap['@import.statement'];
    if (importNode !== undefined) {
      if (findChild(importNode, 'library_export') !== null) {
        grouped['@import.exports-only'] = syntheticCapture(
          '@import.exports-only',
          importNode,
          'true',
        );
      }
      const filters = importNode.descendantsOfType('combinator').map((node) => ({
        kind: node.child(0)?.type,
        names: node.namedChildren
          .filter((child) => child.type === 'identifier')
          .map((child) => child.text),
      }));
      if (filters.length > 0)
        grouped['@import.name-filters'] = syntheticCapture(
          '@import.name-filters',
          importNode,
          JSON.stringify(filters),
        );
    }

    const declTag = FUNCTION_DECL_TAGS.find((t) => grouped[t] !== undefined);
    if (declTag !== undefined) {
      const declNode = nodeMap[declTag]!;
      const declKey = `${declNode.startIndex}:${declNode.endIndex}`;
      if (seenFnDeclNodes.has(declKey)) continue; // dedup named-ctor double-match
      seenFnDeclNodes.add(declKey);
      const bodyNode = findFunctionBody(declNode);
      // An accessor opens its scope for its BODY; it publishes no return
      // binding. `dartBindingScopeFor` hoists a member's or top-level
      // callable's return binding to the Module scope, and the receiver walk
      // climbs past an untyped nearest binding (a `dynamic` parameter, a local
      // of unknown type) to a same-named module binding, so `Addr get cs` — a
      // member of any class, or a top-level getter — would type
      // `void g(dynamic cs) { cs.save(); }` as `Addr.save`: a wrong owner,
      // where before this scope existed the getter published nothing. Withheld
      // until that walk stops at an untyped binder.
      //
      // An operator or a factory constructor (`@dart.callable-body`) opens its
      // scope for the same reason and publishes nothing either. A factory
      // declares no return type. An operator's binding would be named
      // `operator *` — what the signature reader calls it — which no receiver
      // or callee can spell, so no lookup reads it; hoisted to the Module scope
      // it would only be one file-wide entry per operator symbol, the last
      // class declaring that operator winning
      // (`dart-capture-feedback.test.ts`, "an operator and a factory …").
      const withholdsReturnBinding =
        declTag === '@dart.accessor' || declTag === '@dart.callable-body';

      attachArityMetadata(grouped, declNode);
      // A callable's result type is distinct from a same-spelled value. Keep
      // `_()`'s annotation on its definition without lending it to `_.m()`.
      if (grouped['@declaration.name']?.text === '_') {
        const returned = dartMethodConfig.extractReturnType?.(declNode);
        if (returned !== undefined && returned !== '')
          grouped['@declaration.return-type'] = syntheticCapture(
            '@declaration.return-type',
            declNode,
            returned,
          );
      }
      // Structural receiver chain for a call whose receiver is itself an
      // expression, so resolution can type it by folding over structure
      // instead of re-parsing the receiver's source text. Self-gating: a
      // non-call match, an absent receiver, or a chain with no nameable base
      // all leave `grouped` untouched.
      synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
      out.push(grouped);

      const signatureBindings = synthesizeDartSignatureBindings(declNode, bodyNode);
      if (bodyNode !== null) {
        // The READ-side half of the bare-name field discipline (#2807 review).
        // Rides the SAME synthesized match as `@scope.function` so the mask
        // lands on this member's Function scope; outside the `@scope.`
        // namespace so `anchorCaptureFor` cannot mistake it for the anchor.
        const mask = dartShadowedFieldsCapture(bodyNode, memo);
        const scopeMatch: Record<string, Capture> = {
          '@scope.function': spanCapture('@scope.function', declNode, bodyNode),
          ...(mask === undefined ? {} : { '@receiver-owner.shadowed-fields': mask }),
        };
        out.push(scopeMatch);
        // DART-11: the names this scope binds are filled in by Pass B.
        const link = treeLinks.get(declNode.id)!;
        const receiver = synthesizeDartReceiverBinding(declNode, bodyNode, link.enclosingType, {
          parent: link.parent,
          staticBefore,
        });
        for (const cm of receiver) out.push(cm);
        // Parameter bindings are published with the scope once Pass B has
        // counted what it declares (`attachDartLexicalNames`): an annotation is
        // withheld when the SAME scope declares the name again (DART-10).
        const parameterBindings = signatureBindings.filter(
          (cm) => cm['@type-binding.parameter'] !== undefined,
        );
        // A closure bound to a name keeps its parameter list as a child, which
        // the signature helper above cannot read, so its typed parameters
        // were never bound at all.
        if (declNode.type === 'function_expression') {
          parameterBindings.push(...synthesizeDartParameterBindings(declNode, bodyNode));
        }
        registerDartLexicalScope(lexicalScopes, bodyNode, 'member', {
          match: scopeMatch,
          providesThis: receiver.length > 0,
          parameterBindings,
        });
      }
      for (const cm of signatureBindings) {
        // Emitted with the scope, above; a bodiless declaration has none.
        if (cm['@type-binding.parameter'] !== undefined) continue;
        if (withholdsReturnBinding && cm['@type-binding.return'] !== undefined) continue;
        out.push(cm);
      }
      continue;
    }

    // Class fields: emit the Property declaration AND a class-scope type
    // binding (so `receiver.field.method()` chains resolve the field type).
    if (
      grouped['@declaration.property'] !== undefined &&
      grouped['@declaration.name'] !== undefined
    ) {
      const propNode = nodeMap['@declaration.property']!;
      const fieldType = extractFieldType(propNode);
      const fieldName = grouped['@declaration.name'].text;
      if (fieldType !== null) {
        grouped['@declaration.field-type'] = syntheticCapture(
          '@declaration.field-type',
          propNode,
          fieldType,
        );
      }
      // Structural receiver chain for a call whose receiver is itself an
      // expression, so resolution can type it by folding over structure
      // instead of re-parsing the receiver's source text. Self-gating: a
      // non-call match, an absent receiver, or a chain with no nameable base
      // all leave `grouped` untouched.
      synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
      out.push(grouped);
      if (fieldType !== null) {
        out.push({
          '@type-binding.annotation': nodeToCapture('@type-binding.annotation', propNode),
          '@type-binding.name': syntheticCapture('@type-binding.name', propNode, fieldName),
          '@type-binding.type': syntheticCapture('@type-binding.type', propNode, fieldType),
        });
      } else {
        // No written type, so the field's type comes from the constructor its
        // initializer calls (#2807). `constructor-inferred` is the weakest
        // source, and the annotated branch above already returned, so an
        // annotated field is untouched either way.
        const callee = dartFieldConstructorCallee(nodeMap['@declaration.name']!);
        if (callee !== null) {
          out.push({
            '@type-binding.constructor': nodeToCapture('@type-binding.constructor', propNode),
            '@type-binding.name': syntheticCapture('@type-binding.name', propNode, fieldName),
            '@type-binding.type': syntheticCapture('@type-binding.type', propNode, callee.text),
          });
        }
      }
      continue;
    }

    const deferredPrefix =
      grouped['@import.deferred'] !== undefined ? grouped['@import.alias']?.text : undefined;
    if (deferredPrefix !== undefined) (deferredPrefixes ??= new Set()).add(deferredPrefix);

    // Structural receiver chain for a call whose receiver is itself an
    // expression, so resolution can type it by folding over structure
    // instead of re-parsing the receiver's source text. Self-gating: a
    // non-call match, an absent receiver, or a chain with no nameable base
    // all leave `grouped` untouched.
    synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
    out.push(grouped);
  }

  // ── Pass B: tree-walked references, type inference, heritage ────────────
  const seenReadSpans = new Set<string>();
  const cascadeReceivers = new Map<number, DartCascadeReceiver>();
  const initializers: Array<{ node: SyntaxNode; owner: SyntaxNode | null }> = [];
  const writes: Array<{ name: string; owner: SyntaxNode }> = [];
  walkDartTree(root, (node, type, owner, opensBlock) => {
    if (type === 'function_expression' && owner !== null) {
      const body = findFunctionBody(node);
      const key = body === null ? undefined : nodeSpanKey(body);
      const scope = key === undefined ? undefined : lexicalScopes.get(key);
      if (scope !== undefined) lexicalScopes.set(key!, { ...scope, parent: nodeSpanKey(owner) });
    }
    if (
      (type === 'function_body' || type === 'function_expression_body') &&
      owner !== null &&
      owner.id !== node.id
    ) {
      const key = nodeSpanKey(node);
      const scope = lexicalScopes.get(key);
      if (scope !== undefined) lexicalScopes.set(key, { ...scope, parent: nodeSpanKey(owner) });
    }
    if (type === 'assignable_expression' && owner !== null && node.namedChildCount === 1) {
      const target = node.namedChild(0);
      if (target?.type === 'identifier') writes.push({ name: target.text, owner });
    }
    if (type === 'pattern_assignment' && owner !== null) {
      const pattern = node.namedChild(0);
      if (pattern !== null)
        walkNamedTree(pattern, (part) => {
          if (part.type !== 'constant_pattern') return;
          const target = part.namedChildCount === 1 ? part.namedChild(0) : null;
          if (target?.type === 'identifier' && target.text !== '_')
            writes.push({ name: target.text, owner });
        });
    }
    // A statement or collection element that opens a Dart scope gets a Block
    // scope if it binds a name; a catch clause's parameters belong to the
    // body block after it.
    if (opensBlock) registerDartBlockScope(lexicalScopes, node, owner);
    else if (type === 'catch_clause') {
      const catchBody = dartCatchBody(node);
      if (catchBody !== null) registerDartBlockScope(lexicalScopes, catchBody, owner);
    }
    // Not exclusive with the branches below: an initializer is both a binder
    // and a type-binding site.
    if (owner !== null && DART_DECLARED_NAME_TYPES.has(type)) {
      recordDartLexicalName(node, type, owner, lexicalScopes, treeLinks);
    }
    if (
      type === 'selector' ||
      (ASSIGNABLE_SELECTORS.has(type) &&
        treeLinks.get(node.id)?.parent?.type !== 'selector' &&
        treeLinks.get(node.id)?.parent?.type !== 'cascade_section')
    ) {
      emitSelectorReference(node, out, seenReadSpans, treeLinks);
      return;
    }
    if (type === 'cascade_section') {
      emitCascadeReference(node, out, treeLinks, cascadeReceivers);
      return;
    }
    if (type === 'initialized_variable_definition') {
      initializers.push({ node, owner });
      return;
    }
    if (type === 'class_definition') {
      emitHeritage(node, out);
      emitDartFieldAssignmentBindings(node, out, memo);
      return;
    }
    if (type === 'extension_declaration' || type === 'extension_type_declaration') {
      emitExtensionImplementsHeritage(node, out);
      return;
    }
    if (type === 'function_expression' || type === 'local_function_declaration') {
      emitDartNestedFunctionScope(node, seenFnDeclNodes, lexicalScopes, owner);
      return;
    }
  });
  const assignedByScope = new Map<string, Set<string>>();
  for (const { name, owner } of writes) {
    let key: string | null = nodeSpanKey(owner);
    while (key !== null) {
      const scope = lexicalScopes.get(key);
      if (scope === undefined) break;
      if (scope.names.has(name)) {
        let names = assignedByScope.get(key);
        if (names === undefined) assignedByScope.set(key, (names = new Set()));
        names.add(name);
        break;
      }
      key = scope.parent;
    }
  }
  const noWrites = new Set<string>();
  for (const { node, owner } of initializers) {
    const key = owner === null ? undefined : nodeSpanKey(owner);
    const scope = key === undefined ? undefined : lexicalScopes.get(key);
    if (scope !== undefined)
      memo.inferenceByInitializer.set(node.id, {
        binders: scope.declared,
        assigned: assignedByScope.get(key!) ?? noWrites,
      });
    emitVarTypeBinding(node, out, memo, treeLinks);
  }
  attachDartLexicalNames(lexicalScopes, out, treeLinks, staticBefore);

  out.push(
    ...synthesizeCallableFlowCaptures(root, {
      ...DART_CALLABLE_CAPTURE_OPTIONS,
      lexicalFunctionOwner: (node) => dartLexicalFunctionOwner(node, treeLinks),
      extractCallCallee: (node) => dartCallableCallee(node, treeLinks) ?? undefined,
      callSiteNode: (node) => dartCallableCallee(node, treeLinks) ?? undefined,
    }),
  );

  const prefixes = deferredPrefixes;
  if (prefixes === undefined) return out;
  return out.filter((match) => !namesDeferredLoadLibrary(match, prefixes));
}

/** `p.loadLibrary` at the head of a receiver or call-result text. */
const LOAD_LIBRARY_HEAD = /^([A-Za-z_$][\w$]*)\s*\.\s*loadLibrary(?![\w$])/;

/**
 * Whether `match` reads `loadLibrary` through a deferred prefix `p`
 * (`import '…' deferred as p;`).
 *
 * The language gives a deferred prefix an implicit `Future<void> loadLibrary()`
 * and performs the load with `hide loadLibrary`, so `p.loadLibrary` never
 * names a declaration of the imported library, even one the library declares
 * itself (legal when the import hides it). Resolved through the namespace like
 * any other member, the call and the tear-off would bind to that declaration
 * and its return annotation would type the result. So three shapes are
 * dropped: the reference itself (`p.loadLibrary()`, `p.loadLibrary`), a member
 * read off its result (`p.loadLibrary().timeout(d)`), and the call-result seed
 * (`final f = p.loadLibrary();`). The result is the SDK's `Future<void>`, which
 * no workspace class declares.
 */
function namesDeferredLoadLibrary(match: CaptureMatch, prefixes: ReadonlySet<string>): boolean {
  const receiver = match['@reference.receiver']?.text;
  if (receiver !== undefined) {
    if (match['@reference.name']?.text === 'loadLibrary' && prefixes.has(receiver)) return true;
    const head = LOAD_LIBRARY_HEAD.exec(receiver)?.[1];
    if (head !== undefined && prefixes.has(head)) return true;
  }
  const bound = match['@type-binding.type']?.text;
  if (bound === undefined) return false;
  const head = LOAD_LIBRARY_HEAD.exec(bound)?.[1];
  return head !== undefined && prefixes.has(head);
}

function dartCallableCallee(selector: SyntaxNode, links: DartTreeLinks): SyntaxNode | null {
  if (selector.namedChild(0)?.type !== 'argument_part') return null;
  const previous = links.get(selector.id)!.previous;
  if (previous?.type === 'identifier') return previous;
  if (previous?.type !== 'selector') return null;
  const inner = previous.namedChild(0);
  return inner !== null && ASSIGNABLE_SELECTORS.has(inner.type) ? selectorName(inner) : null;
}

// ─── Function scope synthesis ───────────────────────────────────────────────

/**
 * The sibling `function_body` of a declaration, or null (abstract/bodyless).
 *
 * The body is the next named sibling of the declaration's *statement-level*
 * node. For methods/operators the `@declaration` anchor IS the `method_signature`
 * (body is its sibling). For a constructor the anchor is the INNER
 * `constructor_signature`, whose body is a sibling of the WRAPPING
 * `method_signature` (AST: `class_body > method_signature > constructor_signature`,
 * then `function_body`) — so walk up to the `method_signature` wrapper first.
 * Top-level `function_signature` (parent `program`) and abstract `declaration`
 * nodes are unaffected.
 */
function findFunctionBody(declNode: SyntaxNode): SyntaxNode | null {
  // A closure literal carries its body as a CHILD (function_expression_body),
  // unlike a Dart declaration whose body is the next named SIBLING. Without
  // this branch the caller synthesizes no @scope.function for a closure at all,
  // so a closure binding has no scope to own its callable def and can never be
  // a call SOURCE (#2699 S4 — this is why Dart alone showed zero child scopes).
  if (declNode.type === 'function_expression') {
    const body = declNode.namedChildren.find((c) => c.type === 'function_expression_body');
    return body ?? null;
  }
  const node =
    declNode.parent !== null && declNode.parent.type === 'method_signature'
      ? declNode.parent
      : declNode;
  // tree-sitter keeps comments as NAMED siblings, so a comment between a
  // signature and its body (`void f(User v) /* note */ { … }`, or a `///` /
  // `/** */` doc comment) would stop the walk one node early and the
  // declaration would open no scope. Only comments are skipped: any other
  // named sibling still means there is no body (a bodiless `void a();`
  // followed by a comment and the next member must not take that member's
  // body).
  let next = node.nextNamedSibling;
  while (next !== null && DART_COMMENT_TYPES.has(next.type)) next = next.nextNamedSibling;
  return next !== null && next.type === 'function_body' ? next : null;
}

/** Both comment node kinds tree-sitter-dart emits; to the language each is an
 *  ordinary comment. Same set as the CFG visitor's (`cfg/visitors/dart.ts`). */
const DART_COMMENT_TYPES: ReadonlySet<string> = new Set(['comment', 'documentation_comment']);

/** A capture whose range spans two nodes (Dart has no node wrapping both a
 *  signature and its sibling body). */
function spanCapture(name: string, startNode: SyntaxNode, endNode: SyntaxNode): Capture {
  return {
    name,
    range: {
      startLine: startNode.startPosition.row + 1,
      startCol: startNode.startPosition.column,
      endLine: endNode.endPosition.row + 1,
      endCol: endNode.endPosition.column,
    },
    text: '',
  };
}

/**
 * The Function scope of a closure or local function that no declaration query
 * anchors (DART-11): an inline argument closure (`items.forEach((cs) { … })`)
 * or a local `void inner(cs) { … }`.
 *
 * Without it the closure body sat in the ENCLOSING function's scope, so the
 * closure's own parameter was invisible and `cs.save()` inside it climbed to
 * the enclosing function's `Address cs`, minting an edge for a call the source
 * never makes. The scope carries the closure's binder names and its typed
 * parameters, so the walk stops at the closure and reads the closure's own
 * types. It owns no definition, so a call inside it is still attributed to the
 * enclosing callable.
 *
 * A closure bound to a name (`var h = (cs) { … }`) already has a scope from
 * Pass A; `seenFnDeclNodes` holds its span, and a second scope at the same
 * range would give two scopes one id, which drops the whole file.
 *
 * A closure that binds nothing (`setState(() { … })`) gets no scope: it would
 * be transparent to every lookup, so emitting it would only cost output — the
 * same filter the JavaScript and TypeScript block scopes apply.
 */
function emitDartNestedFunctionScope(
  node: SyntaxNode,
  seenFnDeclNodes: ReadonlySet<string>,
  lexicalScopes: DartLexicalScopes,
  owner: SyntaxNode | null,
): void {
  let scopeNode: SyntaxNode | null;
  let paramOwner: SyntaxNode | null;
  let body: SyntaxNode | null;
  if (node.type === 'function_expression') {
    if (seenFnDeclNodes.has(nodeSpanKey(node))) return;
    scopeNode = node;
    paramOwner = node;
    body = findFunctionBody(node);
  } else {
    // `local_function_declaration > lambda_expression > (function_signature, function_body)`.
    scopeNode = findChild(node, 'lambda_expression');
    paramOwner = scopeNode === null ? null : findChild(scopeNode, 'function_signature');
    body = scopeNode === null ? null : findChild(scopeNode, 'function_body');
  }
  if (scopeNode === null || paramOwner === null || body === null) return;
  if (seenFnDeclNodes.has(nodeSpanKey(paramOwner))) return;
  // Emitted only once Pass B shows it binds a name (`attachDartLexicalNames`),
  // and its bindings with it: pushed without the scope they would land on the
  // ENCLOSING scope and type its reads of the same name.
  //
  // The receiver binding: a function literal does not rebind `this`, and a
  // member that has no Function scope of its own (a getter, setter, operator or
  // field initializer) leaves this closure the first Function scope above the
  // site, where `this` would otherwise be unbound. Pushed only where no emitted
  // enclosing scope already provides `this` (`attachDartLexicalNames`).
  registerDartLexicalScope(lexicalScopes, body, 'nested', {
    parent: owner,
    nested: { node, scopeNode, paramOwner },
  });
}

/**
 * One lexical scope this file emits, keyed by the span of the node that owns
 * its binders: a member's or closure's body, or a statement that opens a scope.
 */
interface DartLexicalScope {
  /** A member's scope match (Pass A); deferred scopes build theirs when emitted. */
  readonly match: Record<string, Capture> | null;
  /** The node the `@scope.lexical-names` capture anchors on. */
  readonly anchor: SyntaxNode;
  readonly names: Set<string>;
  /** How many declarations of each name this scope holds (DART-10): a typed
   *  parameter whose name the same scope declares again keeps no annotation. */
  readonly declared: Map<string, number>;
  /** A member's parameter bindings, published once `declared` is complete. */
  readonly parameterBindings: readonly CaptureMatch[];
  /**
   * `member`: a declared function's scope, always emitted (Pass A).
   * `nested`: a closure or local function, and `block`: a statement that opens
   * a scope. Both are emitted only if they bind a name; one that binds nothing
   * is transparent to every lookup, the filter JavaScript and TypeScript block
   * scopes apply.
   */
  readonly kind: 'member' | 'nested' | 'block';
  /** The key of the scope this one sits in, or null at file or class level. */
  readonly parent: string | null;
  /**
   * A closure or local function: the nodes its bindings are synthesized from,
   * once it is known to be emitted. Most closures bind nothing, so building
   * their bindings up front would be work thrown away.
   */
  readonly nested: {
    readonly node: SyntaxNode;
    readonly scopeNode: SyntaxNode;
    readonly paramOwner: SyntaxNode;
  } | null;
  /** A member scope that binds `this` itself (an instance member). */
  readonly providesThis: boolean;
}
type DartLexicalScopes = Map<string, DartLexicalScope>;

function registerDartLexicalScope(
  scopes: DartLexicalScopes,
  anchor: SyntaxNode,
  kind: DartLexicalScope['kind'],
  options: {
    readonly match?: Record<string, Capture>;
    readonly parent?: SyntaxNode | null;
    readonly nested?: DartLexicalScope['nested'];
    readonly providesThis?: boolean;
    readonly parameterBindings?: readonly CaptureMatch[];
  } = {},
): void {
  const key = nodeSpanKey(anchor);
  if (scopes.has(key)) return;
  scopes.set(key, {
    match: options.match ?? null,
    anchor,
    names: new Set(),
    declared: new Map(),
    parameterBindings: options.parameterBindings ?? [],
    kind,
    parent: options.parent == null ? null : nodeSpanKey(options.parent),
    nested: options.nested ?? null,
    providesThis: options.providesThis ?? false,
  });
}

function registerDartBlockScope(
  scopes: DartLexicalScopes,
  node: SyntaxNode,
  owner: SyntaxNode | null,
): void {
  registerDartLexicalScope(scopes, node, 'block', { parent: owner });
}

/** Signature nodes whose formal parameters belong to the sibling body. */
const DART_SIGNATURE_TYPES: ReadonlySet<string> = new Set([
  'method_signature',
  'function_signature',
  'constructor_signature',
  'factory_constructor_signature',
  'getter_signature',
  'setter_signature',
  'operator_signature',
]);

/**
 * Statements and collection elements that open a Dart scope for the names
 * they bind: a nested block, a `for` (its loop variable), a switch case (its
 * pattern variables and body locals), an if-case (its pattern variables), and
 * the collection elements `for` and `if` (`[for (final x in xs) x]`,
 * `[if (o case int x) x]`). A catch clause's parameters are scoped to the body
 * block that follows it (`dartCatchBody`).
 *
 * An element's variable filed under the enclosing scope stops every read of
 * that name in the whole body: `tick()` after the literal loses its edge, and
 * a parameter of the same name loses its annotation (DART-10 recall
 * boundary 1). An expression form (an element, a switch-expression case) also
 * occurs outside every function, in a field or top-level initializer, where
 * its Block sits directly under the Class or Module scope.
 */
const DART_BLOCK_SCOPE_TYPES: ReadonlySet<string> = new Set([
  'block',
  'for_statement',
  'switch_statement_case',
  'switch_expression_case',
  'if_statement',
  'for_element',
  'if_element',
]);

/** A function's own body block is its Function scope, not a nested one. */
function opensDartBlockScope(type: string, parentType: string | null): boolean {
  if (!DART_BLOCK_SCOPE_TYPES.has(type)) return false;
  return (
    type !== 'block' ||
    (parentType !== 'function_body' && parentType !== 'function_expression_body')
  );
}

/** The next named sibling that is not a comment of either kind. */
function nextDartNonCommentSibling(node: SyntaxNode): SyntaxNode | null {
  let next = node.nextNamedSibling;
  while (next !== null && DART_COMMENT_TYPES.has(next.type)) next = next.nextNamedSibling;
  return next;
}

/** The body block a `catch (e, st)` clause's parameters are scoped to. */
function dartCatchBody(catchClause: SyntaxNode): SyntaxNode | null {
  const body = nextDartNonCommentSibling(catchClause);
  return body !== null && body.type === 'block' ? body : null;
}

/**
 * `walkNamedTree` that also hands each node the node owning the scope it sits
 * in: the nearest enclosing function or closure body, or the nearest statement
 * or collection element that opens a scope — or, inside a parameter list, the
 * body of the closure or signature that declares it (a comment between the two
 * is skipped). `null` outside every function and every scope-opening
 * expression (a field, a top-level variable). Tracking it on the way down
 * makes the owner of a binder a field read, not a climb.
 *
 * Pre-order over an explicit stack, not recursion: a syntax tree is as deep as
 * the source nests (one argument closure is about eight levels). The pending
 * nodes live on the heap, so the walk has no depth limit of its own
 * (`callable-flow-stack-depth.test.ts`).
 */
function walkDartTree(
  root: SyntaxNode,
  visit: (node: SyntaxNode, type: string, owner: SyntaxNode | null, opensBlock: boolean) => void,
): void {
  // One pending node per index across the four arrays: the node, the owner of
  // the scope it sits in, its parent's type, and the owner outside the nearest
  // scope-opening statement (what a for-in iterable is read in).
  const nodes: SyntaxNode[] = [root];
  const owners: Array<SyntaxNode | null> = [null];
  const parentTypes: Array<string | null> = [null];
  const outerOwners: Array<SyntaxNode | null> = [null];
  for (;;) {
    const node = nodes.pop();
    if (node === undefined) return;
    const owner = owners.pop() ?? null;
    const parentType = parentTypes.pop() ?? null;
    const outerOwner = outerOwners.pop() ?? null;
    // Read once: `type` is a native call on every access.
    const type = node.type;
    const opensBlock = opensDartBlockScope(type, parentType);
    visit(node, type, owner, opensBlock);
    let childOwner = owner;
    if (type === 'function_body' || type === 'function_expression_body') childOwner = node;
    else if (type === 'function_expression') childOwner = findFunctionBody(node);
    else if (type === 'class_body' || type === 'program') childOwner = null;
    else if (opensBlock) childOwner = node;
    else if (type === 'catch_clause') childOwner = dartCatchBody(node);
    else if (DART_SIGNATURE_TYPES.has(type)) {
      // A signature's parameters belong to its SIBLING body; an inner signature
      // (`method_signature > function_signature`) reads its wrapper's sibling.
      const host = parentType === 'method_signature' ? (node.parent ?? node) : node;
      const body = nextDartNonCommentSibling(host);
      childOwner = body !== null && body.type === 'function_body' ? body : null;
    }
    const branch = type === 'if_statement' || type === 'if_element';
    const tokens = branch || type === 'for_loop_parts' ? node.children : [];
    const elseToken = branch ? tokens.find((child) => child.type === 'else') : undefined;
    const caseToken = branch ? tokens.find((child) => child.type === 'case') : undefined;
    const inToken =
      type === 'for_loop_parts' ? tokens.find((child) => child.type === 'in') : undefined;
    const childOuterOwner = opensBlock ? owner : outerOwner;
    // Pushed last child first, so the first child is the next node popped and
    // the visit order is the recursive pre-order.
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child === null) continue;
      const outsideBranch =
        (elseToken !== undefined && child.startIndex >= elseToken.endIndex) ||
        (caseToken !== undefined && child.endIndex <= caseToken.startIndex);
      const outsideLoop = inToken !== undefined && child.startIndex >= inToken.endIndex;
      nodes.push(child);
      owners.push(outsideBranch ? owner : outsideLoop ? outerOwner : childOwner);
      parentTypes.push(type);
      outerOwners.push(childOuterOwner);
    }
  }
}

/** Pattern variables start after the matched expression and end before `else`;
 * for-in binders start after the iterable.
 * Keep the header/body boundary rather than the body's exact span, so a nested
 * body block may still open its own scope without producing duplicate IDs. */
function dartBlockScopeCapture(node: SyntaxNode): Capture {
  const capture = spanCapture('@scope.block', node, node);
  if (node.type === 'if_statement' || node.type === 'if_element') {
    const children = node.children;
    const caseToken = children.find((child) => child.type === 'case');
    const otherwise = children.find((child) => child.type === 'else');
    return {
      ...capture,
      range: {
        ...capture.range,
        ...(caseToken === undefined
          ? {}
          : {
              startLine: caseToken.endPosition.row + 1,
              startCol: caseToken.endPosition.column,
            }),
        ...(otherwise === undefined
          ? {}
          : {
              endLine: otherwise.startPosition.row + 1,
              endCol: otherwise.startPosition.column,
            }),
      },
    };
  }
  if (node.type === 'for_statement' || node.type === 'for_element') {
    const parts = node.namedChildren.find((child) => child.type === 'for_loop_parts');
    if (parts?.children.some((child) => child.type === 'in'))
      return {
        ...capture,
        range: {
          ...capture.range,
          startLine: parts.endPosition.row + 1,
          startCol: parts.endPosition.column,
        },
      };
  }
  return capture;
}

/** File the name `node` declares under the scope whose owner node is `owner`. */
function recordDartLexicalName(
  node: SyntaxNode,
  type: string,
  owner: SyntaxNode,
  scopes: DartLexicalScopes,
  links: DartTreeLinks,
): void {
  const scope = scopes.get(nodeSpanKey(owner));
  if (scope === undefined) return; // a body with no Function scope (a class accessor)
  visitDartDeclaredName(node, type, links, (name) => {
    scope.names.add(name);
    scope.declared.set(name, (scope.declared.get(name) ?? 0) + 1);
  });
}

/**
 * `@scope.lexical-names` on each scope: every name it DECLARES — parameters,
 * locals, local functions, catch and loop variables, pattern variables — typed
 * or not (DART-11).
 *
 * The shared receiver walk treats a listed name as owned by this scope, so it
 * stops here instead of borrowing an enclosing binding of the same spelling;
 * a binder that also has a type still answers with that type, because the walk
 * reads a scope's own type before it honours the stop.
 *
 * A name belongs to the NEAREST scope that declares it: a closure or local
 * function, a nested block, a `for`, a switch case, an if-case, a collection
 * `for` / `if` element, or the body a catch clause guards. So a loop variable,
 * a catch parameter, a block-local or an element variable does not stop reads
 * of an outer binding after its statement, and a closure's binders do not stop
 * reads in the enclosing function.
 *
 * Collected during Pass B's one tree walk rather than by a walk per scope.
 * Sorted, so the capture text and every fingerprint over it is order-stable; a
 * scope that binds nothing carries no tag, and a deferred scope that binds
 * nothing is not emitted at all.
 */
function attachDartLexicalNames(
  scopes: DartLexicalScopes,
  out: CaptureMatch[],
  treeLinks: DartTreeLinks,
  staticBefore: Map<number, boolean>,
): void {
  // Whether `this` is bound at or above each scope once deferred scopes are
  // decided. Registration order is the walk's pre-order, so a parent is always
  // settled before its children.
  const thisBound = new Map<string, boolean>();
  for (const [key, scope] of scopes) {
    const { anchor, names, kind, parent, nested, providesThis } = scope;
    const inherited = parent !== null && thisBound.get(parent) === true;
    const lexical =
      names.size === 0
        ? undefined
        : syntheticCapture('@scope.lexical-names', anchor, JSON.stringify([...names].sort()));
    if (kind === 'member') {
      if (lexical !== undefined && scope.match !== null) {
        scope.match['@scope.lexical-names'] = lexical;
      }
      for (const cm of scope.parameterBindings) {
        if (!dartParameterRedeclared(cm, scope)) out.push(cm);
      }
      thisBound.set(key, providesThis);
      continue;
    }
    if (lexical === undefined) {
      thisBound.set(key, inherited);
      continue;
    }
    if (nested === null) {
      out.push({
        '@scope.block': dartBlockScopeCapture(anchor),
        '@scope.lexical-names': lexical,
      });
      thisBound.set(key, inherited);
      continue;
    }
    out.push({
      '@scope.function': spanCapture('@scope.function', nested.scopeNode, nested.scopeNode),
      '@scope.lexical-names': lexical,
    });
    for (const cm of synthesizeDartParameterBindings(nested.paramOwner, anchor)) {
      if (!dartParameterRedeclared(cm, scope)) out.push(cm);
    }
    // Only where no emitted enclosing scope binds `this` already: under a
    // getter, setter, operator or field initializer, which have no scope.
    let ownThis = false;
    if (!inherited) {
      const link = treeLinks.get(nested.node.id)!;
      const receiver = synthesizeDartReceiverBinding(nested.node, anchor, link.enclosingType, {
        parent: link.parent,
        staticBefore,
      });
      for (const cm of receiver) out.push(cm);
      ownThis = receiver.length > 0;
    }
    thisBound.set(key, inherited || ownThis);
  }
}

/**
 * Does the scope that owns this parameter binding DECLARE the parameter's name
 * a second time (DART-10)? One scope keeps one binding per name, so an
 * annotation that survives a same-scope redeclaration types the redeclared
 * sites too; it is withheld, and the name stays in the scope's lexical names,
 * so the receiver walk stops there as an untyped binder instead of reaching a
 * same-named binding further out.
 *
 * Counted per scope with `visitDartDeclaredName`, so only real declarations
 * count (a pattern field label, a function-typed parameter's own parameter, a
 * pattern assignment or `_` do not), and a binder in a closure, local
 * function, nested block, loop, case, catch body or collection element belongs
 * to that scope and leaves the outer annotation alone. Plain assignment is not a declaration:
 * Dart requires the value to be assignable to the declared type.
 */
function dartParameterRedeclared(cm: CaptureMatch, scope: DartLexicalScope): boolean {
  const name = cm['@type-binding.name']?.text;
  return name !== undefined && (scope.declared.get(name) ?? 0) > 1;
}

/** Every node type `visitDartDeclaredName` reads a declared name from. */
const DART_DECLARED_NAME_TYPES: ReadonlySet<string> = new Set([
  'initialized_variable_definition',
  'for_loop_parts',
  'formal_parameter',
  'catch_parameters',
  'initialized_identifier',
  'variable_pattern',
  'constant_pattern',
  'local_function_declaration',
]);

/**
 * Hand `visit` the name `node` DECLARES, for lexical ownership.
 *
 * Narrower than `visitDartBinderName`, which over-approximates on purpose for
 * the field-shadow mask and the call-result inference census (where declining
 * costs nothing wrong). As lexical ownership an over-approximation stops every
 * lookup of the spelling in the scope, so this reader follows the patterns
 * specification:
 *   - a `variable_pattern` (`var x`, `final x`, `Type x`) declares in every
 *     context;
 *   - a bare name (`constant_pattern`) declares only in a declaration context
 *     (`var (a, b) = …`, `for (final (a, b) in …)`); in a matching context
 *     (`case Address:`) it is a constant reference, and a pattern assignment
 *     (`(a,) = …`) declares nothing;
 *   - a field label or map key (`(api: v)`, `Box(cs: var x)`) is a getter
 *     name, never a binder — those are direct identifier children of the
 *     container patterns, which this reader does not take.
 * A parameter of a function-typed parameter (`Other cs(int a)`) belongs to
 * that type, not to this scope. `_` declares nothing (wildcard variables).
 */
function visitDartDeclaredName(
  node: SyntaxNode,
  type: string,
  links: DartTreeLinks,
  visit: (name: string) => void,
): void {
  const declare = (name: string | null | undefined): void => {
    if (
      name !== null &&
      name !== undefined &&
      name !== '' &&
      (name !== '_' || (!type.includes('pattern') && !dartUsesWildcardVariables(node)))
    )
      visit(name);
  };
  switch (type) {
    case 'initialized_variable_definition':
    case 'for_loop_parts':
      declare(node.childForFieldName('name')?.text);
      return;
    case 'initialized_identifier': {
      const first = node.namedChild(0);
      if (first !== null && first.type === 'identifier') declare(first.text);
      return;
    }
    case 'catch_parameters':
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child !== null && child.type === 'identifier') declare(child.text);
      }
      return;
    case 'formal_parameter': {
      const parent = links.get(node.id)?.parent;
      if (parent != null && links.get(parent.id)?.parent?.type === 'formal_parameter') return;
      declare(dartParameterName(node) ?? dartFunctionTypedParameterName(node));
      return;
    }
    case 'variable_pattern': {
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const child = node.namedChild(i);
        if (child !== null && child.type === 'identifier') {
          declare(child.text);
          return;
        }
      }
      return;
    }
    case 'constant_pattern': {
      if (!dartPatternDeclares(node)) return;
      const only = node.namedChild(0);
      if (only !== null && only.type === 'identifier') declare(only.text);
      return;
    }
    case 'local_function_declaration': {
      const lambda = findChild(node, 'lambda_expression');
      const signature = lambda === null ? null : findChild(lambda, 'function_signature');
      declare(signature?.childForFieldName('name')?.text);
      return;
    }
    default:
      return;
  }
}

/** `Other cs(int a)`: the name written before the parameter's own parameter list. */
function dartFunctionTypedParameterName(param: SyntaxNode): string | null {
  let name: string | null = null;
  for (let i = 0; i < param.namedChildCount; i++) {
    const child = param.namedChild(i);
    if (child === null) continue;
    if (child.type === 'formal_parameter_list') return name;
    if (child.type === 'identifier') name = child.text;
  }
  return null;
}

/**
 * Whether a bare-name pattern sits in a DECLARATION context — the pattern of a
 * `var`/`final` pattern declaration or of a for-in — rather than in a matching
 * context or a pattern assignment. Climbs only through pattern nodes.
 */
function dartPatternDeclares(constantPattern: SyntaxNode): boolean {
  for (let cur = constantPattern.parent; cur !== null; cur = cur.parent) {
    const type = cur.type;
    if (type === 'pattern_variable_declaration' || type === 'for_loop_parts') return true;
    if (!type.endsWith('_pattern')) return false;
  }
  return false;
}

function attachArityMetadata(grouped: Record<string, Capture>, declNode: SyntaxNode): void {
  const meta = computeDartArityMetadata(declNode);
  if (meta.parameterCount !== undefined) {
    grouped['@declaration.parameter-count'] = syntheticCapture(
      '@declaration.parameter-count',
      declNode,
      String(meta.parameterCount),
    );
  }
  if (meta.requiredParameterCount !== undefined) {
    grouped['@declaration.required-parameter-count'] = syntheticCapture(
      '@declaration.required-parameter-count',
      declNode,
      String(meta.requiredParameterCount),
    );
  }
  if (meta.parameterTypes !== undefined) {
    grouped['@declaration.parameter-types'] = syntheticCapture(
      '@declaration.parameter-types',
      declNode,
      JSON.stringify(meta.parameterTypes),
    );
  }
}

/** The declared type of a class field (`Address address = …` → `Address`). */
function extractFieldType(declNode: SyntaxNode): string | null {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const c = declNode.namedChild(i);
    if (c !== null && (c.type === 'type_identifier' || c.type === 'nullable_type')) {
      return c.text.replace(/\?+$/, '');
    }
  }
  return null;
}

// ─── References: calls + member reads (postfix chains) ──────────────────────

const ASSIGNABLE_SELECTORS = new Set([
  'unconditional_assignable_selector',
  'conditional_assignable_selector',
]);

/** Last named `identifier` child of an assignable/cascade selector. */
function selectorName(inner: SyntaxNode): SyntaxNode | null {
  for (let i = inner.namedChildCount - 1; i >= 0; i--) {
    const c = inner.namedChild(i);
    if (c !== null && c.type === 'identifier') return c;
  }
  return null;
}

/** Count call arguments under a `selector(argument_part(arguments(…)))`. */
function countArgs(argPart: SyntaxNode): number {
  const args = argPart.namedChild(0);
  if (args === null) return 0;
  let n = 0;
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c !== null && (c.type === 'argument' || c.type === 'named_argument')) n++;
  }
  return n;
}

/** Receiver text preceding a member-call/read selector (the postfix chain
 *  head plus any intermediate selectors): `user.address.save()` → `user.address`.
 *  `last` is the receiver's final node, by default the selector's previous
 *  sibling; a cascade passes the sibling before its comments. */
function computeReceiverText(
  nameSelector: SyntaxNode,
  links: DartTreeLinks,
  last: SyntaxNode | null = links.get(nameSelector.id)!.previous,
): string | null {
  const selectors: SyntaxNode[] = [];
  let cur = last;
  let head: SyntaxNode | null = null;
  while (cur !== null) {
    if (cur.type === 'selector' || ASSIGNABLE_SELECTORS.has(cur.type)) {
      selectors.push(cur);
      cur = links.get(cur.id)!.previous;
      continue;
    }
    head = cur;
    break;
  }
  if (head === null) return null;
  if (!isNameableHead(head)) return null;
  selectors.reverse();
  let text = head.text;
  for (const s of selectors) text += s.text;
  return text;
}

/** A postfix-chain head the receiver text can name as it stands. */
function isNameableHead(node: SyntaxNode): boolean {
  return node.type === 'identifier' || node.type === 'this' || node.type === 'super';
}

/** The `selector`-wrapped node, or the bare assignable selector itself. */
function selectorInner(selector: SyntaxNode): SyntaxNode | null {
  return selector.type === 'selector' ? selector.namedChild(0) : selector;
}

/**
 * Chain steps for a run of postfix selectors: `.getUser` `()` is one call
 * step, `.address` / `?.address` a field step. `null` for any selector the
 * chain cannot carry — an index `[0]`, a non-null `!`, a type-argument list, a
 * call applied to something that is not a member. The chain is refused whole
 * rather than minted short: a chain missing a hop decodes as a different,
 * shorter receiver and would type the call against the wrong owner.
 */
function dartSelectorSteps(selectors: readonly SyntaxNode[]): MixedChainStep[] | null {
  const steps: MixedChainStep[] = [];
  for (let i = 0; i < selectors.length; i++) {
    const inner = selectorInner(selectors[i]!);
    if (inner === null || !ASSIGNABLE_SELECTORS.has(inner.type)) return null;
    const nameId = selectorName(inner);
    if (nameId === null) return null; // `[0]`: an index selector names no member
    const next = selectors[i + 1];
    const nextInner = next === undefined ? null : selectorInner(next);
    if (nextInner !== null && nextInner.type === 'argument_part') {
      steps.push({ kind: 'call', name: nameId.text });
      i++;
    } else {
      steps.push({ kind: 'field', name: nameId.text });
    }
  }
  return steps;
}

interface PostfixRun {
  readonly base: SyntaxNode;
  readonly selectors: readonly SyntaxNode[];
  readonly awaited: boolean;
}

/** `((await x))` is two wrappers plus the await; nothing real nests deeper. */
const MAX_PAREN_PEEL = 3;

/**
 * The postfix run a parenthesized receiver wraps — `(svc.getUser())`,
 * `(await svc.getUserAsync())`, `((…))`. tree-sitter-dart spells `await x` as
 * `unary_expression(await_expression(…))` and keeps the run FLAT inside the
 * wrapper: the base and its selectors are siblings, so they are read by
 * position. `null` for any other operand — `(a + b)`, `(x as User)`, `(!flag)`,
 * a call on a bare name `(make())` — which is then a receiver with no chain.
 */
function parenthesizedRun(paren: SyntaxNode): PostfixRun | null {
  let node = paren;
  let awaited = false;
  for (let peel = 0; peel < MAX_PAREN_PEEL; peel++) {
    const named = node.namedChildren.filter((c): c is SyntaxNode => c !== null);
    const head = named[0];
    if (head === undefined) return null;
    if (isNameableHead(head)) {
      const selectors = named.slice(1);
      if (!selectors.every((s) => s.type === 'selector')) return null;
      return { base: head, selectors, awaited };
    }
    if (named.length !== 1) return null;
    if (head.type === 'parenthesized_expression') {
      node = head;
      continue;
    }
    if (awaited) return null;
    if (head.type === 'await_expression') {
      awaited = true;
      node = head;
      continue;
    }
    if (head.type === 'unary_expression' && head.namedChild(0)?.type === 'await_expression') {
      awaited = true;
      node = head.namedChild(0)!;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Receiver of a member call whose postfix head is a parenthesized expression —
 * `(await svc.getUserAsync()).save()` (DART-04).
 *
 * `computeReceiverText` names a receiver only from a bare head, so this call
 * used to carry NO receiver and was resolved as a receiver-less member call:
 * the free-call tier bound `save` through the wildcard import, whose per-file
 * export index keeps the FIRST declaration of each simple name, and the call
 * reached `Address.save` — a wrong owner decided by declaration order.
 *
 * Two halves. The receiver TEXT is the precision half: a site with a receiver
 * resolves through that receiver, and one that cannot be typed is a recorded
 * `receiver-unresolved` drop, never a name guess. The structural CHAIN
 * (`2|svc|cgetUserAsync|a`) is the recall half: the shared fold types
 * `getUserAsync` through its hoisted return binding — `Future<User>`, kept
 * WHOLE by `awaitableReturnSpelling` so that a member called on the un-awaited
 * Future is never typed as a member of `User` — and the await hop takes what
 * Dart's `elementTypeOf` await route yields (`dartAwaitedType`: `Future<User>`
 * → `User`). The hop is identity only when the language declines (the position
 * is not awaitable). This is the same fold the languages whose grammars hand
 * the shared walker a receiver node go through. That walker cannot read Dart's flat selector run, so the steps
 * are built here and encoded with the one shared codec, which also enforces
 * the depth cap (a chain it refuses leaves the site with text only).
 *
 * Returns `null` when the head is not parenthesized, leaving every other shape
 * exactly as it was.
 */
function parenthesizedReceiver(
  nameSelector: SyntaxNode,
  links: DartTreeLinks,
  last: SyntaxNode | null = links.get(nameSelector.id)!.previous,
): { readonly text: string; readonly chain: string | undefined } | null {
  const outer: SyntaxNode[] = [];
  let cur = last;
  while (cur !== null && (cur.type === 'selector' || ASSIGNABLE_SELECTORS.has(cur.type))) {
    outer.push(cur);
    cur = links.get(cur.id)!.previous;
  }
  if (cur === null || cur.type !== 'parenthesized_expression') return null;
  outer.reverse();
  const run = parenthesizedRun(cur);
  // Parentheses around a bare name are transparent: `(svc).save()` IS
  // `svc.save()`, so it takes the ordinary text route.
  if (run !== null && !run.awaited && run.selectors.length === 0 && outer.length === 0) {
    return { text: run.base.text, chain: undefined };
  }
  let text = cur.text;
  for (const s of outer) text += s.text;
  if (run === null) return { text, chain: undefined };
  const innerSteps = dartSelectorSteps(run.selectors);
  const outerSteps = dartSelectorSteps(outer);
  if (innerSteps === null || outerSteps === null) return { text, chain: undefined };
  const steps: MixedChainStep[] = [...innerSteps];
  if (run.awaited) steps.push({ kind: 'await' });
  steps.push(...outerSteps);
  return { text, chain: encodeReceiverChain(run.base.text, steps) };
}

function emitSelectorReference(
  selector: SyntaxNode,
  out: CaptureMatch[],
  seenReadSpans: Set<string>,
  links: DartTreeLinks,
): void {
  // `super.member` and the final member of an assignment target are bare
  // assignable selectors; other postfix members have a `selector` wrapper.
  const inner = selector.type === 'selector' ? selector.namedChild(0) : selector;
  if (inner === null) return;

  // A `selector(argument_part)` is the call marker; the callee is the
  // immediately-preceding sibling.
  if (inner.type === 'argument_part') {
    const prev = links.get(selector.id)!.previous;
    if (prev === null) return;
    const arity = countArgs(inner);

    if (prev.type === 'identifier') {
      const name = prev.text;
      if (DART_BUILT_INS.has(name)) return; // legacy suppresses built-in-named calls
      // Dart has no `new`: an UpperCamelCase callee is a constructor call by
      // convention (types are UpperCamelCase) — tag it so `constructorCallTargetsClass`
      // links `Foo()` to the Class node (the legacy DAG emits that edge even for an
      // implicit constructor). A lowercase callee is an ordinary free function call.
      const tag = /^[A-Z]/.test(name) ? '@reference.call.constructor' : '@reference.call.free';
      out.push({
        [tag]: nodeToCapture(tag, prev),
        '@reference.name': nodeToCapture('@reference.name', prev),
        '@reference.arity': syntheticCapture('@reference.arity', prev, String(arity)),
      });
      return;
    }
    if (prev.type === 'selector' || ASSIGNABLE_SELECTORS.has(prev.type)) {
      const prevInner = prev.type === 'selector' ? prev.namedChild(0) : prev;
      if (prevInner === null) return;
      if (ASSIGNABLE_SELECTORS.has(prevInner.type)) {
        const nameId = selectorName(prevInner);
        if (nameId === null) return;
        if (DART_BUILT_INS.has(nameId.text)) return; // legacy suppresses built-in-named calls
        const recv = computeReceiverText(prev, links);
        // A parenthesized head (`(await svc.getUserAsync()).save()`) names no
        // receiver text of its own; see `parenthesizedReceiver`.
        const paren = recv === null ? parenthesizedReceiver(prev, links) : null;
        const receiverText = recv ?? paren?.text ?? null;
        const cm: CaptureMatch = {
          '@reference.call.member': nodeToCapture('@reference.call.member', nameId),
          '@reference.name': nodeToCapture('@reference.name', nameId),
          '@reference.arity': syntheticCapture('@reference.arity', nameId, String(arity)),
          ...(receiverText !== null
            ? { '@reference.receiver': syntheticCapture('@reference.receiver', prev, receiverText) }
            : {}),
          // Anchored on the name, like `@reference.call.member`, so the site's
          // anchor (the widest `@reference.*` capture) does not move.
          ...(paren?.chain !== undefined
            ? {
                '@reference.receiver-chain': syntheticCapture(
                  '@reference.receiver-chain',
                  nameId,
                  paren.chain,
                ),
              }
            : {}),
        };
        out.push(cm);
      }
    }
    return;
  }

  // A member not followed by a call is a read, except the final selector on
  // an assignment's left side. Intermediate receivers remain reads.
  if (ASSIGNABLE_SELECTORS.has(inner.type)) {
    const next = links.get(selector.id)!.next;
    const isCall =
      next !== null && next.type === 'selector' && next.namedChild(0)?.type === 'argument_part';
    if (isCall) return;

    const nameId = selectorName(inner);
    if (nameId === null) return;
    const recv = computeReceiverText(selector, links);
    if (recv === null) return;

    const spanKey = `${nameId.startIndex}-${nameId.endIndex}`;
    if (seenReadSpans.has(spanKey)) return;
    seenReadSpans.add(spanKey);

    const target = links.get(selector.id)!.parent;
    const isWrite =
      target?.type === 'assignable_expression' &&
      target.lastNamedChild?.id === selector.id &&
      links.get(target.id)?.parent?.childForFieldName('left')?.id === target.id;
    const tag = isWrite ? '@reference.write.member' : '@reference.read.member';
    out.push({
      [tag]: nodeToCapture(tag, nameId),
      '@reference.name': nodeToCapture('@reference.name', nameId),
      '@reference.receiver': syntheticCapture('@reference.receiver', selector, recv),
    });
  }
}

interface DartCascadeReceiver {
  readonly text: string;
  readonly chain?: string;
}

/** Each cascade section starts again at the original receiver. Its direct
 * selector/argument children then form an ordinary member chain. Keeping the
 * receiver even when its type is unknown prevents a free-call name guess.
 *
 * tree-sitter keeps a comment as a NAMED sibling, so in a commented builder
 * chain (`o`, then `// first` and `..apply(1)`, then `// second` and
 * `..apply(2)`) the node before a section is the comment. Read as the
 * receiver, its text typed nothing and every later section inherited it: the
 * calls vanished with no outcome row. Comments of either kind are stepped
 * over, before a section and inside one. */
function emitCascadeReference(
  cascade: SyntaxNode,
  out: CaptureMatch[],
  links: DartTreeLinks,
  receivers: Map<number, DartCascadeReceiver>,
): void {
  let previous = links.get(cascade.id)!.previous;
  while (previous !== null && DART_COMMENT_TYPES.has(previous.type)) {
    previous = links.get(previous.id)?.previous ?? null;
  }
  const paren = parenthesizedReceiver(cascade, links, previous);
  const base = (previous?.type === 'cascade_section' ? receivers.get(previous.id) : undefined) ?? {
    text:
      computeReceiverText(cascade, links, previous) ??
      paren?.text ??
      previous?.text ??
      '<unknown cascade receiver>',
    chain: paren?.chain,
  };
  receivers.set(cascade.id, base);
  let text = base.text;
  const decoded = decodeReceiverChain(base.chain);
  const steps: MixedChainStep[] = [...(decoded?.steps ?? [])];
  let structural = decoded !== undefined && !decoded.truncated;
  const children = cascade.namedChildren.filter((child) => !DART_COMMENT_TYPES.has(child.type));
  for (let i = 0; i < children.length; i++) {
    const selector = children[i]!;
    if (selector.type !== 'cascade_selector' && !ASSIGNABLE_SELECTORS.has(selector.type)) break;
    const nameId = selectorName(selector);
    if (nameId === null) {
      text += selector.text;
      structural = false; // Never use a chain that omitted an unsupported hop.
      continue;
    }
    const args = children[i + 1];
    const call = args?.type === 'argument_part';
    if (call && !DART_BUILT_INS.has(nameId.text)) {
      const chain =
        structural && steps.length > 0
          ? encodeReceiverChain(decoded!.baseReceiverName, steps)
          : undefined;
      out.push({
        '@reference.call.member': nodeToCapture('@reference.call.member', nameId),
        '@reference.name': nodeToCapture('@reference.name', nameId),
        '@reference.arity': syntheticCapture('@reference.arity', nameId, String(countArgs(args))),
        '@reference.receiver': syntheticCapture('@reference.receiver', nameId, text),
        ...(chain === undefined
          ? {}
          : {
              '@reference.receiver-chain': syntheticCapture(
                '@reference.receiver-chain',
                nameId,
                chain,
              ),
            }),
      });
    }
    text += `.${nameId.text}${call ? args.text : ''}`;
    steps.push({ kind: call ? 'call' : 'field', name: nameId.text });
    if (call) i++;
  }
}

// ─── Local-variable constructor / call-result type inference ────────────────

/**
 * Is `node` the callee of a construction / free call written directly at this
 * position — a bare identifier whose next named sibling is a `selector`
 * carrying an `argument_part` (`Outer()`)?
 *
 * Dart has no `new` keyword, so a constructor call and a free call are the same
 * shape; the resolver decides which by looking the name up. Anything else — a
 * literal, a member call, an index — is NOT this shape and is left alone rather
 * than guessed at.
 */
function isDirectConstruction(node: SyntaxNode | null): node is SyntaxNode {
  if (node === null || node.type !== 'identifier') return false;
  const next = node.nextNamedSibling;
  return next !== null && next.type === 'selector' && next.namedChild(0)?.type === 'argument_part';
}

/** Find the callee identifier of a `var x = Callee(…)` / `await Callee(…)`
 *  initializer (a direct free-call / constructor); returns null for member
 *  calls or non-call values. */
function findDirectCallValue(initVarDef: SyntaxNode): SyntaxNode | null {
  const firstValue = initVarDef.childForFieldName('value');
  if (firstValue === null) return null;

  if (firstValue.type === 'identifier') {
    // The call must be the ENTIRE initializer, as in the awaited branch below:
    // `make().then((u) => u.address)` yields the `.then` result and
    // `make().field` the field, not `make()`'s value. Binding the first callee
    // was DART-07; it became a typed wrong edge once `(await f)` could unwrap
    // the callee's `Future<T>` through the fold.
    return isDirectConstruction(firstValue) &&
      firstValue.nextNamedSibling!.nextNamedSibling === null
      ? firstValue
      : null;
  }
  if (firstValue.type === 'unary_expression' || firstValue.type === 'await_expression') {
    let aw = firstValue;
    if (aw.type === 'unary_expression') {
      const inner = aw.namedChild(0);
      if (inner === null) return null;
      aw = inner;
    }
    if (aw.type === 'await_expression') {
      // `namedChild(0)` is the awaited callee; its next named sibling is
      // `namedChild(1)`, so `isDirectConstruction` asks exactly the same
      // question this branch used to spell out. The call must be the ENTIRE
      // awaited operand: `await make().then((_) => Address())` yields the
      // `.then` result, not `make()`'s, so a trailing selector of any kind
      // declines (the qualified helper below has the same check).
      const id = aw.namedChild(0);
      if (isDirectConstruction(id) && id.nextNamedSibling!.nextNamedSibling === null) return id;
    }
  }
  return null;
}

/** Fallback census owner for declarations outside emitted lexical scopes.
 * The per-file tree index supplies it without a native parent walk. */
function outermostBody(node: SyntaxNode, links: DartTreeLinks): SyntaxNode {
  return links.get(node.id)!.outermostBody;
}

/** What one outermost body binds and writes, computed once per body. */
interface DartBodyCensus {
  /** Binders per name: declarators, formal parameters (the member's own and
   *  every closure's / local function's), catch variables, for-in variables
   *  and every pattern binder — the `visitDartBinderName` family. */
  readonly binders: ReadonlyMap<string, number>;
  /** Names that are the target of `=`, an op-assignment or `++`/`--`
   *  anywhere in the body, nested closures included. */
  readonly assigned: ReadonlySet<string>;
}

/** Conservative fallback for an initializer outside an emitted lexical scope.
 * Memoize one census per enclosing body/file; ordinary locals reuse the
 * declarations collected by Pass B and never walk their body again. */
function dartBodyCensus(body: SyntaxNode, memo: DartClassMemo): DartBodyCensus {
  const key = nodeSpanKey(body);
  const cached = memo.censusByBody.get(key);
  if (cached !== undefined) return cached;
  const binders = new Map<string, number>();
  const assigned = new Set<string>();
  const count = (name: string): void => {
    binders.set(name, (binders.get(name) ?? 0) + 1);
  };
  const signature = signatureBefore(body);
  if (signature !== null && OWN_SIGNATURE_TYPES.has(signature.type)) {
    walkNamedTree(signature, (n) => visitDartBinderName(n, count));
  }
  walkNamedTree(body, (node) => {
    visitDartBinderName(node, count);
    if (node.type === 'assignable_expression') {
      // The target of `=`, `+=`, `??=`, `++` — exactly one named child, the name.
      const only = node.namedChildCount === 1 ? node.namedChild(0) : null;
      if (only !== null && only.type === 'identifier') assigned.add(only.text);
    }
  });
  const census: DartBodyCensus = { binders, assigned };
  memo.censusByBody.set(key, census);
  return census;
}

const OWN_SIGNATURE_TYPES: ReadonlySet<string> = new Set([
  'method_signature',
  'function_signature',
  'formal_parameter_list',
  // A top-level setter (a class member's is wrapped in a `method_signature`);
  // its body opens a Function scope (DART-10). A getter declares no parameter.
  'setter_signature',
]);

/** The signature a body belongs to: its previous named sibling, past the
 *  comments tree-sitter keeps as named siblings between the two (the inverse
 *  of the walk in `findFunctionBody`). */
function signatureBefore(body: SyntaxNode): SyntaxNode | null {
  let sibling = body.previousNamedSibling;
  while (sibling !== null && DART_COMMENT_TYPES.has(sibling.type)) {
    sibling = sibling.previousNamedSibling;
  }
  return sibling;
}

/** Infer only a single declaration with no writes to that lexical binding.
 * Pass B assigns captured writes to the nearest declaring scope, so shadowing
 * locals and sibling closures cannot invalidate or type one another. A
 * declaration outside an emitted scope uses the conservative body census. */
function dartLocalInferenceAllowed(
  initVarDef: SyntaxNode,
  name: string,
  memo: DartClassMemo,
  links: DartTreeLinks,
): boolean {
  const census =
    memo.inferenceByInitializer.get(initVarDef.id) ??
    dartBodyCensus(outermostBody(initVarDef, links), memo);
  return (census.binders.get(name) ?? 0) <= 1 && !census.assigned.has(name);
}

/** A simple dotted call as the whole initializer, with or without await.
 * Namespace calls and uniquely typed instance methods are followed after
 * finalization, preserving the producer’s return-type scope. Longer chains
 * such as `rp.make().other` are deliberately not reduced to the first call. */
function qualifiedCallValue(initVarDef: SyntaxNode): string | null {
  let head = initVarDef.childForFieldName('value');
  if (head?.type === 'unary_expression') head = head.namedChild(0);
  if (head?.type === 'await_expression') head = head.namedChild(0);
  if (head?.type !== 'identifier') return null;
  const member = head.nextNamedSibling;
  const call = member?.nextNamedSibling;
  const inner = member?.type === 'selector' ? member.namedChild(0) : null;
  const name = inner?.type === 'unconditional_assignable_selector' ? selectorName(inner) : null;
  if (
    name === null ||
    call?.type !== 'selector' ||
    call.namedChild(0)?.type !== 'argument_part' ||
    call.nextNamedSibling !== null
  ) {
    return null;
  }
  return `${head.text}.${name.text}`;
}

/**
 * Callee identifier of a class field initialized by a direct constructor call —
 * `var b = Outer();` / `final b = Outer();` — or `null` for anything else.
 *
 * Dart spells a class field as `declaration(<keyword>, initialized_identifier_list(
 * initialized_identifier))`, NOT the `initialized_variable_definition` that
 * `emitVarTypeBinding` handles — that is the LOCAL form. So an unannotated field
 * had no type binding and could not act as a call receiver (#2807), even though
 * its annotated twin resolved fine.
 *
 * Takes the field's own `@declaration.name` node, whose next named sibling IS
 * the initializer — `initialized_identifier(<name> <value> …)`. Deliberately NOT
 * a search down from the `@declaration.property` node: one `declaration` can
 * hold SEVERAL declarators (`var a = X(), b = Y();`), which the query matches
 * once each with the same property node, so a first-descendant search hands
 * every declarator the FIRST one's initializer and types `b` as `X`.
 */
function dartFieldConstructorCallee(nameNode: SyntaxNode): SyntaxNode | null {
  const value = nameNode.nextNamedSibling;
  return isDirectConstruction(value) ? value : null;
}

/** Is the initializer `await …` (tree-sitter-dart: `unary_expression(await_expression)`)? */
function isAwaitedInitializer(initVarDef: SyntaxNode): boolean {
  let value = initVarDef.childForFieldName('value');
  if (value?.type === 'unary_expression') value = value.namedChild(0);
  return value?.type === 'await_expression';
}

function emitVarTypeBinding(
  initVarDef: SyntaxNode,
  out: CaptureMatch[],
  memo: DartClassMemo,
  links: DartTreeLinks,
): void {
  const nameNode = initVarDef.childForFieldName('name');
  // A local named `_` declares nothing (Dart 3.7 wildcard variables), so its
  // initializer types no `_` read. Only a local reaches here: the grammar
  // wraps a field or a top-level variable in `initialized_identifier` or
  // `static_final_declaration`, never `initialized_variable_definition`.
  if (nameNode === null || (nameNode.text === '_' && dartUsesWildcardVariables(initVarDef))) return;
  const callee = findDirectCallValue(initVarDef)?.text ?? qualifiedCallValue(initVarDef);
  if (callee === null) return;
  // A name bound more than once or assigned anywhere in its outermost body is
  // never inferred, awaited or not — see `dartLocalInferenceAllowed`.
  if (!dartLocalInferenceAllowed(initVarDef, nameNode.text, memo, links)) return;
  const awaited = isAwaitedInitializer(initVarDef);
  // An awaited call result is bound to its CALLEE, whose return binding
  // carries `Future<T>` whole (`awaitableReturnSpelling`). The marker tells the
  // chain follow to take what that return yields under `await`
  // (`dartAwaitedType`: `Future<C>` → `C`) instead of the Future itself —
  // a `Future<C>`-typed `x` would make `x.m()` a typed receiver that names no
  // class, which records neither an edge nor a drop. `await Foo()` is marked
  // too: awaiting a constructed value yields that value, and the route
  // answers `undefined` for a non-awaitable, so the binding stays `Foo`.
  out.push({
    '@type-binding.constructor': nodeToCapture('@type-binding.constructor', initVarDef),
    ...(awaited
      ? { '@type-binding.awaited': syntheticCapture('@type-binding.awaited', initVarDef, 'true') }
      : {}),
    '@type-binding.name': syntheticCapture('@type-binding.name', initVarDef, nameNode.text),
    '@type-binding.type': syntheticCapture('@type-binding.type', initVarDef, callee),
  });
}

// ─── Heritage ───────────────────────────────────────────────────────────────

/**
 * Type an inference-typed field from a constructor call ASSIGNED to it —
 * `var r; C() { r = Outer(); }` and `this.r = Outer();` (#2807).
 *
 * Dart is the one language here that writes a field with NO receiver prefix, so
 * `r = Outer()` is syntactically identical to assigning a constructor-local. The
 * discriminator is the class's own declared field set: a bare name binds only
 * when the enclosing class declares it AND the enclosing member binds no name of
 * its own that would shadow it (`collectDartBodyShadows` — parameters, locals,
 * closure parameters, catch bindings, loop variables), which is exactly when
 * Dart itself resolves `r` to the field. A `this.`-prefixed write is unambiguous
 * and needs neither test.
 *
 * Emitted as `constructor-inferred`, the weakest source, so a field that also
 * carries an annotation keeps it. The narrow `@type-binding.dart-field` marker
 * rides the name node for `dartBindingScopeFor` to hoist on — the binding has to
 * land on the Class scope, since the assignment sits inside a constructor's own
 * Function scope where `typeOfMemberOnClass` never looks.
 */
function emitDartFieldAssignmentBindings(
  classNode: SyntaxNode,
  out: CaptureMatch[],
  memo: DartClassMemo,
): void {
  const body = findChild(classNode, 'class_body');
  if (body === null) return;

  // `namedChildren` allocates a fresh wrapper array on every access
  // (node-tree-sitter), and the loop below walks the same list — read it once.
  const members = body.namedChildren;

  const fields = dartClassFieldNames(body, memo);
  if (fields.size === 0) return;

  for (const member of members) {
    if (member === null || member.type !== 'function_body') continue;

    // A STATIC member's body can never write this class's INSTANCE fields.
    // Dart's static scope holds only the class's static members, so a bare
    // `z = Outer()` inside `static void make()` binds a LIBRARY-level `z` (or is
    // a compile error) — never the same-named instance field. Binding it anyway
    // did not merely add an edge: the write landed on the Class scope at the
    // same `constructor-inferred` strength as the constructor's own, and the
    // `>=` tie-break in `scope-extractor` let it DISPLACE the correct type, so
    // `z.inner()` resolved to the wrong class (#2807 review). The instance
    // static-vs-instance collision TypeScript and JavaScript allow cannot arise
    // in Dart — one class may not declare a static and an instance member of the
    // same name — so this is the only shape the defect takes here.
    //
    // Grammar: every class-member body is a `function_body` whose PREVIOUS named
    // sibling is a `method_signature` (method, constructor, factory, getter,
    // setter, operator, `async`), and `static` is an anonymous direct child of
    // that signature, ahead of the inner `*_signature` node. Detection is the
    // shared `hasKeyword` on child TEXT, never `child.type === 'static'`, which
    // a grammar bump silently breaks — the same rule TypeScript's
    // `isStaticMethodThis` follows.
    //
    // A body whose signature cannot be read at all (a null or unexpected
    // previous sibling — parse recovery) DECLINES to bind: staticness is
    // undecidable there, and a missed field type costs an edge while a wrong one
    // destroys a correct binding.
    const signature = member.previousNamedSibling;
    if (signature === null || signature.type !== 'method_signature') continue;
    if (hasKeyword(signature, 'static')) continue;

    // Still lazy per assignment, but the memo is now FILE-wide and shared with
    // Pass A's read-side mask, which asks the same question of the same body.
    // The laziness that used to matter here (87-100% of eagerly built sets were
    // discarded, ~15% of total Dart emission) no longer buys much for a class
    // that declares fields — Pass A has already forced those bodies — so this
    // reads the memo rather than paying a second walk. It still short-circuits
    // for a body whose class declares no fields, since `fields.size === 0`
    // returned above before either pass touched it.
    //
    // Not visible to `bench/scope-capture`, which is a RATIO gate — this work is
    // linear, so a constant factor leaves the ratio at 1.0.
    const shadowsOf = (): ReadonlySet<string> => dartBodyShadows(member, memo);

    walkNamedTree(member, (node) => {
      if (node.type !== 'assignment_expression') return;
      const target = node.namedChild(0);
      if (target === null || target.type !== 'assignable_expression') return;

      const first = target.namedChild(0);
      if (first === null) return;
      let fieldNameNode: SyntaxNode | null = null;
      if (first.type === 'identifier' && target.namedChildCount === 1) {
        // Bare `r = …`: a field only when declared here and not shadowed. The
        // `fields` test runs FIRST so the shadow set is only ever built for a
        // name the class actually declares.
        if (!fields.has(first.text) || shadowsOf().has(first.text)) return;
        fieldNameNode = first;
      } else if (first.type === 'this') {
        const selector = target.namedChild(1);
        if (selector === null || selector.type !== 'unconditional_assignable_selector') return;
        const nameNode = selector.namedChild(0);
        if (nameNode === null || nameNode.type !== 'identifier') return;
        fieldNameNode = nameNode;
      } else {
        return;
      }
      if (fieldNameNode === null) return;

      // RHS must be a direct construction; anything else is left alone rather
      // than guessed at.
      const callee = node.namedChild(1);
      if (!isDirectConstruction(callee)) return;

      out.push({
        '@type-binding.constructor': nodeToCapture('@type-binding.constructor', node),
        '@type-binding.dart-field': syntheticCapture(
          '@type-binding.dart-field',
          fieldNameNode,
          '1',
        ),
        '@type-binding.name': syntheticCapture(
          '@type-binding.name',
          fieldNameNode,
          fieldNameNode.text,
        ),
        '@type-binding.type': syntheticCapture('@type-binding.type', callee, callee.text),
      });
    });
  }
}

/**
 * Per-file memo for the two class-shaped questions the passes share, keyed by
 * node span. `emitDartScopeCaptures` owns one and threads it; nothing survives
 * the call, so a re-parse cannot serve a stale answer.
 */
interface DartClassMemo {
  readonly fieldsByClassBody: Map<string, ReadonlySet<string>>;
  readonly shadowsByBody: Map<string, ReadonlySet<string>>;
  readonly censusByBody: Map<string, DartBodyCensus>;
  readonly inferenceByInitializer: Map<number, DartBodyCensus>;
}

const nodeSpanKey = (node: SyntaxNode): string => `${node.startIndex}:${node.endIndex}`;

/**
 * The names a `class_body` declares as INSTANCE-or-static fields, from
 * `declaration(… initialized_identifier_list … initialized_identifier)` — the
 * shape every stored Dart field takes, annotated or not.
 */
function dartClassFieldNames(classBody: SyntaxNode, memo: DartClassMemo): ReadonlySet<string> {
  const key = nodeSpanKey(classBody);
  const cached = memo.fieldsByClassBody.get(key);
  if (cached !== undefined) return cached;

  const fields = new Set<string>();
  for (const member of classBody.namedChildren) {
    if (member === null || member.type !== 'declaration') continue;
    const list = findChild(member, 'initialized_identifier_list');
    if (list === null) continue;
    for (const init of list.namedChildren) {
      if (init === null || init.type !== 'initialized_identifier') continue;
      const nameNode = init.namedChild(0);
      if (nameNode !== null && nameNode.type === 'identifier') fields.add(nameNode.text);
    }
  }
  memo.fieldsByClassBody.set(key, fields);
  return fields;
}

function dartBodyShadows(bodyNode: SyntaxNode, memo: DartClassMemo): ReadonlySet<string> {
  const key = nodeSpanKey(bodyNode);
  const cached = memo.shadowsByBody.get(key);
  if (cached !== undefined) return cached;
  const shadows = collectDartBodyShadows(bodyNode);
  memo.shadowsByBody.set(key, shadows);
  return shadows;
}

/**
 * The READ half of the bare-name field discipline: the field names a member
 * body REBINDS, published on that member's Function scope as
 * `Scope.ownsReceivers` (#2701) so the receiver walk stops there instead of
 * reaching the Class scope (#2807 review).
 *
 * `emitDartFieldAssignmentBindings` above declines to WRITE a binding for a name
 * the body shadows, but the shadow set gated writes only. A bare-name READ of a
 * shadowing binder the resolver cannot type — `for (final conn in xs) {
 * conn.inner(); }`, where the element type of `xs` is not modelled — therefore
 * walked straight past the local and hit the class field binding this same
 * feature mints, resolving `conn.inner()` to the CONSTRUCTOR's type. That turns
 * "no edge" into a WRONG edge, the one failure mode
 * `scope-resolution/passes/compound-receiver.ts` says must never happen, and it
 * was introduced by the write side rather than pre-existing: delete the
 * constructor and the same read emits nothing.
 *
 * `ownsReceivers` is the right primitive because the walk consults
 * `typeBindings` FIRST at every scope (`scope/walkers.ts`) and only then honours
 * the mask. A shadow the resolver CAN type still wins — an annotated parameter
 * `void probe(Beta conn)` keeps `Beta`, because
 * `synthesizeDartSignatureBindings` anchors parameter bindings on this same
 * body node, so they land on this same Function scope. The mask only fires
 * where the alternative was a fabricated type.
 *
 * ── SCOPE OF THE MASK, AND ITS ACCEPTED COSTS ────────────────────────────────
 *
 * `shadows ∩ fields`, and nothing wider. Three consequences are taken knowingly
 * rather than hidden:
 *
 *  1. NOT every locally bound name is masked — only ones the enclosing class
 *     also declares as a field. A library-level `var logger = Logger();`
 *     shadowed by a loop variable of the same name still resolves against the
 *     library binding and can still produce the wrong edge. That is the general
 *     form of the same defect and arguably the more correct fix, but it changes
 *     resolution for code this feature never touched; it is recorded here as a
 *     known limitation rather than implemented.
 *  2. The mask is BODY-WIDE, exactly as `collectDartBodyShadows` is on the write
 *     side. A member that binds `conn` anywhere — a nested closure, one `case`
 *     arm — masks `conn` for the whole member, so a read of the genuine field
 *     elsewhere in that member loses its edge. Deliberate symmetry: the write
 *     side already declines body-wide, and losing an edge is the error this
 *     whole line of work chooses over inventing one.
 *  3. `fields` is EVERY field the class declares, not only the ones the
 *     constructor-write feature types. An ANNOTATED field shadowed by a binder
 *     is masked too, so this reaches resolution that predates #2807 — and it is
 *     meant to: which name a body's bare read refers to is a fact about Dart, not
 *     about how the field acquired its type. `mixin` bodies are reached for the
 *     same reason (the grammar gives a mixin a `class_body` as well), even though
 *     `emitDartFieldAssignmentBindings` mints nothing for them. `extension`
 *     bodies are a different node (`extension_body`) and are left alone.
 *
 * Returns `undefined` — not an empty marker — when nothing is masked, so the
 * emitted capture set is unchanged for every body that does not shadow a field.
 * Names are sorted so the capture text (and every fingerprint over it) is
 * order-stable.
 */
function dartShadowedFieldsCapture(bodyNode: SyntaxNode, memo: DartClassMemo): Capture | undefined {
  // Only a CLASS-MEMBER body can shadow a field: `function_body` whose parent is
  // the `class_body`. A closure's `function_expression_body` and a top-level
  // function are both excluded, and neither needs the mask — a closure's binders
  // are already in its enclosing member's body-wide shadow set, and the walk
  // passes through the enclosing member's Function scope on its way out.
  if (bodyNode.type !== 'function_body') return undefined;
  const classBody = bodyNode.parent;
  if (classBody === null || classBody.type !== 'class_body') return undefined;

  const fields = dartClassFieldNames(classBody, memo);
  if (fields.size === 0) return undefined;
  const shadows = dartBodyShadows(bodyNode, memo);
  if (shadows.size === 0) return undefined;

  const masked: string[] = [];
  for (const name of fields) {
    if (shadows.has(name)) masked.push(name);
  }
  if (masked.length === 0) return undefined;
  masked.sort();
  return syntheticCapture('@receiver-owner.shadowed-fields', bodyNode, JSON.stringify(masked));
}

/**
 * Every name BOUND by one class-member body — the shadow set the bare-name
 * branch of `emitDartFieldAssignmentBindings` tests against.
 *
 * A local `var` is only ONE of Dart's binders, and a bare `r = Outer()` writes
 * whichever binder wins, so a set built from local declarations alone made a
 * write to any OTHER binder look like a field write. `void reset(Alpha r) { r =
 * Alpha(); }` in a class with a field `r` retyped the FIELD to `Alpha` —
 * fabricating an edge and displacing the type the constructor had correctly
 * given it. Formal parameters are the sharpest case because they are not even
 * inside the body: `function_body` is a SIBLING of the `method_signature` that
 * carries them, so no walk of the body can ever see one.
 *
 * Dart 3 patterns are the SAME defect a second time: `var (r, n) = …;`,
 * `if (o case Beta r)`, `case Beta r:`, `for (var (r, _) in xs)`, list / map /
 * object / rest / cast / null-check / null-assert patterns and pattern
 * assignments all bind `r` through node types no earlier list named, so each of
 * them let a write retype the field. `addDartBinderName` now enumerates the
 * pattern family from the grammar rather than from reported shapes.
 *
 * Deliberately over-approximate in the shadow direction. The set is body-wide
 * (a binder in a nested closure, a `case` arm or a collection-literal element
 * shadows for the whole body), a parameter shape whose name cannot be read
 * contributes nothing rather than being guessed at, and a bare name inside a
 * pattern shadows whether it binds or merely references a constant. All err
 * toward DECLINING to bind, which is the right error: a missed field type costs
 * an edge, a wrong one produces an edge to the wrong class and destroys a
 * correct binding — the failure mode this whole line of work exists to avoid
 * (see `scope-resolution/passes/compound-receiver.ts`).
 */
function collectDartBodyShadows(bodyNode: SyntaxNode): Set<string> {
  const shadows = new Set<string>();
  // The enclosing function's own formal parameters live OUTSIDE the body, on
  // the `method_signature` sibling that precedes it — the shape every class
  // member takes (method, constructor, factory, static, getter, setter,
  // operator, `async`/`async*`) — past any comment between the two, now that
  // such a member opens its own scope (DART-10) for the mask to ride on.
  const signature = signatureBefore(bodyNode);
  const add = (name: string): void => {
    if (name === '_' && dartUsesWildcardVariables(bodyNode)) return;
    shadows.add(name);
  };
  if (signature !== null && signature.type === 'method_signature') {
    walkNamedTree(signature, (n) => visitDartBinderName(n, add));
  }
  walkNamedTree(bodyNode, (n) => visitDartBinderName(n, add));
  return shadows;
}

/** Every node type `visitDartBinderName` reads a binder from — its `case` labels. */
const DART_BINDER_NODE_TYPES: ReadonlySet<string> = new Set([
  'initialized_variable_definition',
  'for_loop_parts',
  'formal_parameter',
  'catch_parameters',
  'initialized_identifier',
  'variable_pattern',
  'constant_pattern',
  'record_pattern',
  'list_pattern',
  'map_pattern',
  'object_pattern',
  'rest_pattern',
  'cast_pattern',
  'null_check_pattern',
  'null_assert_pattern',
]);

/**
 * Hand `visit` the name `node` binds, if it binds one.
 *
 * The `case` list is the whole point of this function and the reason it is
 * separate: an INCOMPLETE list of binder forms is the exact defect this file has
 * now shipped three times (formal parameters, then every Dart 3 pattern, then
 * the awaited-inference guard that enumerated its own shorter list and missed
 * closure parameters and catch variables). It is enumerated against
 * `vendor/tree-sitter-dart/grammar.js`, not against the shapes a bug report
 * happened to carry, and it is the ONE list: the field-shadow set
 * (`collectDartBodyShadows`) and the call-result inference census
 * (`dartBodyCensus`) both read it. Lexical ownership reads a narrower,
 * declaration-sensitive subset (`visitDartDeclaredName`): an over-approximation
 * that only makes those two decline would, as ownership, stop every lookup.
 *
 * `DART_BINDER_NODE_TYPES` gates the switch, so a node type missing from it is
 * ignored by every reader at once; a new `case` must be added to both.
 */
function visitDartBinderName(node: SyntaxNode, visit: (name: string) => void): void {
  if (!DART_BINDER_NODE_TYPES.has(node.type)) return;
  switch (node.type) {
    // `var s;`, `final r = 1;`, and the FIRST declarator of `var a = 1, b = 2;`.
    // `for_loop_parts` carries the for-IN variable on the same `name` field
    // (`for (var r in xs)`); the C-style form instead nests a
    // `local_variable_declaration` the walk reaches on its own.
    case 'initialized_variable_definition':
    case 'for_loop_parts': {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) visit(nameNode.text);
      return;
    }
    // Formal parameters — of the enclosing member, of a closure
    // (`function_expression`), and of a nested `local_function_declaration`.
    case 'formal_parameter': {
      const name = dartParameterName(node);
      if (name !== null) visit(name);
      return;
    }
    // `on E catch (e, stack)` — every identifier in the list is a binding.
    case 'catch_parameters': {
      for (const child of node.namedChildren) {
        if (child !== null && child.type === 'identifier') visit(child.text);
      }
      return;
    }
    // Second and later declarators of `var a = 1, b = 2;` — fieldless, so the
    // name is the first named child. (A class field is this node type too, but
    // only ever under `initialized_identifier_list`, which no body contains.)
    case 'initialized_identifier': {
      const first = node.namedChild(0);
      if (first !== null && first.type === 'identifier') visit(first.text);
      return;
    }
    // ── Dart 3 patterns ──────────────────────────────────────────────────────
    //
    // EVERY pattern node the grammar emits, and every one of them takes its
    // DIRECT `identifier` children. The grammar rules that would carry a binder
    // are `_pattern_field`, `_map_pattern_entry`, `_list_pattern_element`,
    // `_parenthesized_pattern`, `_outer_pattern`, `_guarded_pattern` and the
    // logical/relational tiers — ALL hidden (`_`-prefixed), so they emit no node
    // of their own and inline their children onto whichever visible pattern node
    // encloses them. Reading direct children is therefore what actually sees a
    // binder; there is no field to ask for (`variable_pattern`,
    // `pattern_variable_declaration` and `constant_pattern` declare none).
    //
    // The first two are where a binder truly lands, and are alone sufficient:
    //   `variable_pattern` — `Beta s` / `final s` / `var s`.
    //   `constant_pattern` — a BARE name (`(s, n)`, `[s, t]`, `{'k': s}`,
    //      `Point(:s)`, `...s`, `(s)`). Dart itself decides bare-name-binds-vs-
    //      references-a-constant from the enclosing `final`/`var`, and
    //      tree-sitter gives both the same node, so `case kLimit:` shadows too.
    //      Over-shadowing a constant reference costs an edge; the other
    //      direction fabricates one.
    // The containers after them are DEFENCE, not routing — the walk reaches
    // nested patterns on its own. They matter because the hidden `_pattern_field`
    // already drops a NON-binder label identifier straight onto `record_pattern`
    // / `object_pattern` (and a key onto `map_pattern`), which is proof that this
    // grammar inlines identifiers onto containers. If a grammar revision ever
    // inlines a real binder the same way, it is shadowed here on arrival instead
    // of becoming the third instance of this bug.
    //
    // DELIBERATELY EXCLUDED — `pattern_variable_declaration`, `pattern_assignment`
    // and `for_loop_parts` hold the pattern and the `=`/`in` RHS at the SAME
    // child level (`var [s, t] = xs` → `identifier xs` is a direct child), so
    // taking their direct identifiers would shadow the SOURCE expression's name,
    // which binds nothing. Their pattern child is a case below. Also excluded:
    // `type_identifier` (never an `identifier`, so `Beta` in `Beta s` and `Point`
    // in `Point(…)` cannot be mistaken for binders), `qualified` inside a
    // `constant_pattern` (`Colors.red` nests one level deeper — a qualified name
    // is always a constant reference), and relational/equality operands
    // (`case > kLimit`), which the hidden tier drops onto the enclosing
    // STATEMENT rather than any pattern node.
    case 'variable_pattern':
    case 'constant_pattern':
    case 'record_pattern':
    case 'list_pattern':
    case 'map_pattern':
    case 'object_pattern':
    case 'rest_pattern':
    case 'cast_pattern':
    case 'null_check_pattern':
    case 'null_assert_pattern': {
      for (const child of node.namedChildren) {
        if (child !== null && child.type === 'identifier') visit(child.text);
      }
      return;
    }
    default:
      return;
  }
}

/** The name a `formal_parameter` binds, across every shape the grammar gives it. */
function dartParameterName(param: SyntaxNode): string | null {
  // `Alpha r`, `final Alpha r`, `void Function(int) r`, `{required Beta r}`,
  // `[Delta r]` — all carry an explicit `name` field.
  const named = param.childForFieldName('name');
  if (named !== null) return named.text;

  const only = param.namedChild(0);
  if (only === null) return null;
  // An untyped closure parameter (`(r) { … }`) is a bare identifier with no
  // field to read it from.
  if (only.type === 'identifier') return only.text;
  // `this.r` / `super.r` bind a parameter NAMED `r` that is initialized from
  // the field — a later bare `r = …` writes that parameter, not the field, so
  // these shadow exactly like any other.
  if (only.type === 'constructor_param' || only.type === 'super_formal_parameter') {
    for (let i = only.namedChildCount - 1; i >= 0; i--) {
      const child = only.namedChild(i);
      if (child !== null && child.type === 'identifier') return child.text;
    }
  }
  return null;
}

function emitHeritage(classNode: SyntaxNode, out: CaptureMatch[]): void {
  const nameNode = classNode.childForFieldName('name');
  if (nameNode === null) return;
  const className = nameNode.text;

  const superclass = classNode.childForFieldName('superclass');
  if (superclass !== null) {
    // `extends Base` — the direct `type_identifier` child of `superclass`
    // (the `mixins` node, if present, nests separately). Routed through the
    // generic inherits pre-pass → EXTENDS (the base resolves to a class).
    for (let i = 0; i < superclass.namedChildCount; i++) {
      const c = superclass.namedChild(i);
      if (c !== null && c.type === 'type_identifier') {
        // `extends Base<User>` spells the arguments in a SIBLING node, so the
        // anchor's own text cannot carry them; the sub-tag does (#2912).
        const args = typeArgumentsAfter(superclass, i);
        out.push({
          '@reference.inherits': nodeToCapture('@reference.inherits', c),
          '@reference.name': nodeToCapture('@reference.name', c),
          ...(args === null
            ? {}
            : { '@reference.type-arguments': nodeToCapture('@reference.type-arguments', args) }),
        });
        break;
      }
    }
    // `with M1, M2` — mixin application → IMPLEMENTS (Dart mixin dispatch).
    const mixins = findChild(superclass, 'mixins');
    if (mixins !== null) {
      emitHeritageMarkers(mixins, 'with', className, out);
    }
  }

  // `implements I1, I2` — Dart `implements <class>` is IMPLEMENTS regardless
  // of the target's symbol kind, so it cannot use the target-kind pre-pass.
  const interfaces = classNode.childForFieldName('interfaces');
  if (interfaces !== null) {
    emitHeritageMarkers(interfaces, 'implements', className, out);
  }
}

function emitExtensionImplementsHeritage(extensionNode: SyntaxNode, out: CaptureMatch[]): void {
  const nameNode = extensionNode.childForFieldName('name');
  if (nameNode === null) return;

  const body = extensionNode.childForFieldName('body');
  const header =
    body === null
      ? extensionNode.text
      : extensionNode.text.slice(0, body.startIndex - extensionNode.startIndex);
  const implementsIndex = header.indexOf('implements');
  if (implementsIndex === -1) return;

  const className = nameNode.text;
  const interfaces = header.slice(implementsIndex + 'implements'.length);
  for (const rawInterface of splitTopLevelCommaList(interfaces)) {
    const target = /^[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rawInterface)?.[1];
    if (target === undefined) continue;
    const payload = encodeMarker('heritage', ['implements', target, className]);
    out.push({ '@import.heritage': syntheticCapture('@import.heritage', nameNode, payload) });
  }
}

function splitTopLevelCommaList(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angleDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') {
      angleDepth++;
      continue;
    }
    if (ch === '>' && angleDepth > 0) {
      angleDepth--;
      continue;
    }
    if (ch === ',' && angleDepth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

function emitHeritageMarkers(
  container: SyntaxNode,
  kind: 'implements' | 'with',
  className: string,
  out: CaptureMatch[],
): void {
  for (let i = 0; i < container.namedChildCount; i++) {
    const c = container.namedChild(i);
    if (c === null || c.type !== 'type_identifier') continue;
    // `implements Validator<String>` / `with M<int>`: the arguments ride the
    // marker payload, because this heritage never becomes a reference SITE —
    // `emitDartHeritageEdges` reads the marker and emits the edge (#2912).
    // Dropped rather than encoded when the spelling contains the marker's own
    // ':' delimiter, which `encodeMarker` rejects outright; absence is the
    // fail-open value everywhere this is read.
    const args = typeArgumentsAfter(container, i)?.text;
    const fields =
      args === undefined || args.includes(':')
        ? [kind, c.text, className]
        : [kind, c.text, className, args];
    const payload = encodeMarker('heritage', fields);
    out.push({ '@import.heritage': syntheticCapture('@import.heritage', c, payload) });
  }
}

/** The `type_arguments` node written immediately after `container`'s named
 *  child at `index` — the arguments of the type that child names — or `null`
 *  when that type was written without any. */
function typeArgumentsAfter(container: SyntaxNode, index: number): SyntaxNode | null {
  const next = container.namedChild(index + 1);
  return next !== null && next.type === 'type_arguments' ? next : null;
}

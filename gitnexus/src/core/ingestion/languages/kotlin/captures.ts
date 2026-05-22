import type { Capture, CaptureMatch, Range } from 'gitnexus-shared';
import {
  findNodeAtRange,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { computeKotlinArityMetadata } from './arity-metadata.js';
import { splitKotlinImportHeader } from './import-decomposer.js';
import { recordKotlinCacheHit, recordKotlinCacheMiss } from './cache-stats.js';
import { normalizeKotlinType } from './interpret.js';
import { synthesizeKotlinReceiverBinding } from './receiver-binding.js';
import { getKotlinParser, getKotlinScopeQuery } from './query.js';

const FUNCTION_DECL_TAGS = ['@declaration.function'] as const;

export function emitKotlinScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getKotlinParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getKotlinParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordKotlinCacheMiss();
  } else {
    recordKotlinCacheHit();
  }

  const out: CaptureMatch[] = [];
  const returnTypes = collectKotlinReturnTypeTexts(tree.rootNode);
  out.push(...synthesizeKotlinLocalAssignmentBindings(tree.rootNode, returnTypes));
  out.push(...synthesizeKotlinLoopBindings(tree.rootNode, returnTypes));
  out.push(...synthesizeKotlinSmartCastBindings(tree.rootNode));

  for (const match of getKotlinScopeQuery().matches(tree.rootNode)) {
    const grouped: Record<string, Capture> = {};
    for (const capture of match.captures) {
      const tag = '@' + capture.name;
      grouped[tag] = nodeToCapture(tag, capture.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    if (grouped['@import.statement'] !== undefined) {
      const importNode = findNodeAtRange(
        tree.rootNode,
        grouped['@import.statement']!.range,
        'import_header',
      );
      if (importNode !== null) {
        const decomposed = splitKotlinImportHeader(importNode);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
    }

    if (
      grouped['@reference.call.free'] !== undefined &&
      grouped['@reference.receiver'] !== undefined
    ) {
      continue;
    }

    if (grouped['@reference.read.member'] !== undefined) {
      const anchor = grouped['@reference.read.member']!;
      const navNode = findNodeAtRange(tree.rootNode, anchor.range, 'navigation_expression');
      if (navNode === null || !shouldEmitReadMember(navNode)) continue;
    }

    // Virtual dispatch via constructor type (#1762). When a property
    // declaration carries BOTH an explicit type annotation AND a
    // constructor-style call value (e.g. `val animal: Animal = Dog()`),
    // suppress the annotation capture so the constructor-inferred
    // binding wins. This matches Kotlin's virtual dispatch semantics:
    // `animal.speak()` should resolve to the overriding `Dog.speak`
    // (the dynamic type), not `Animal.speak` (the static annotation).
    //
    // The annotation source has higher precedence than constructor-
    // inferred in the generic scope-extractor (see
    // `typeBindingStrength` in scope-extractor.ts), so the only way to
    // make the constructor type prevail is to drop the annotation at
    // emission time.
    if (
      grouped['@type-binding.annotation'] !== undefined &&
      grouped['@type-binding.name'] !== undefined &&
      grouped['@type-binding.type'] !== undefined
    ) {
      const annotation = grouped['@type-binding.annotation']!;
      if (propertyDeclHasConstructorValue(tree.rootNode, annotation.range)) {
        continue;
      }
    }

    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const fnNode = findNodeAtRange(
        tree.rootNode,
        grouped['@scope.function']!.range,
        'function_declaration',
      );
      if (fnNode !== null) {
        out.push(...synthesizeKotlinReceiverBinding(fnNode));
      }
      continue;
    }

    const declTag = FUNCTION_DECL_TAGS.find((tag) => grouped[tag] !== undefined);
    if (declTag !== undefined) {
      const fnNode = findNodeAtRange(
        tree.rootNode,
        grouped[declTag]!.range,
        'function_declaration',
      );
      if (fnNode !== null) {
        const arity = computeKotlinArityMetadata(fnNode);
        if (arity.parameterCount !== undefined) {
          grouped['@declaration.parameter-count'] = syntheticCapture(
            '@declaration.parameter-count',
            fnNode,
            String(arity.parameterCount),
          );
        }
        if (arity.requiredParameterCount !== undefined) {
          grouped['@declaration.required-parameter-count'] = syntheticCapture(
            '@declaration.required-parameter-count',
            fnNode,
            String(arity.requiredParameterCount),
          );
        }
        if (arity.parameterTypes !== undefined) {
          grouped['@declaration.parameter-types'] = syntheticCapture(
            '@declaration.parameter-types',
            fnNode,
            JSON.stringify(arity.parameterTypes),
          );
        }
      }
    }

    const callTag = (
      ['@reference.call.free', '@reference.call.member', '@reference.call.constructor'] as const
    ).find((tag) => grouped[tag] !== undefined);
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = findNodeAtRange(tree.rootNode, grouped[callTag]!.range, 'call_expression');
      if (callNode !== null) {
        const args = callArguments(callNode);
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(args.length),
        );
        grouped['@reference.parameter-types'] = syntheticCapture(
          '@reference.parameter-types',
          callNode,
          JSON.stringify(args.map(inferArgType)),
        );
      }
    }

    out.push(grouped);

    const extensionFallback = extensionFreeCallFallback(grouped, tree.rootNode);
    if (extensionFallback !== null) out.push(extensionFallback);
  }

  return out;
}

function synthesizeKotlinLoopBindings(
  rootNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const localTypes = collectKotlinLocalTypeTexts(fnNode, returnTypes);
    for (const forNode of descendantsOfType(fnNode, 'for_statement')) {
      const variable = forNode.namedChildren.find((child) => child.type === 'variable_declaration');
      const name = variable?.namedChildren.find((child) => child.type === 'simple_identifier');
      if (variable === undefined || name === undefined) continue;

      const explicitType = variable.namedChildren.find((child) => isKotlinTypeNode(child));
      const iterable = forNode.namedChildren.find(
        (child) => child.id !== variable.id && child.type !== 'control_structure_body',
      );
      const rawType =
        explicitType?.text ??
        (iterable === undefined
          ? null
          : inferKotlinIterableElementType(iterable, localTypes, returnTypes));
      if (rawType === null || rawType.trim() === '') continue;

      const anchor =
        forNode.namedChildren.find((child) => child.type === 'control_structure_body') ?? forNode;
      out.push({
        '@type-binding.annotation': nodeToCapture('@type-binding.annotation', anchor),
        '@type-binding.name': syntheticCapture('@type-binding.name', name, name.text),
        '@type-binding.type': syntheticCapture(
          '@type-binding.type',
          explicitType ?? iterable ?? name,
          normalizeKotlinType(rawType),
        ),
      });
    }
  }
  return out;
}

/**
 * Synthesize narrowed type-bindings for Kotlin smart-cast forms — issue #1758.
 *
 * For each `when (x) { is T -> body }` and `if (x is T) body`, emits a
 * `@type-binding.annotation` capture binding `x → T` anchored on the body
 * node. The capture lands in the matching `@scope.block` scope (see query.ts
 * smart-cast scopes), shadowing the outer parameter binding for calls inside
 * the body without leaking across sibling arms or to `else`.
 *
 * Only narrows when:
 *   - the `when` subject is a `simple_identifier` (not a call or field chain);
 *   - the `when_entry` condition is exactly one `type_test` (skips `!is`,
 *     compound conditions, range/`in`/value patterns);
 *   - the `if_expression` condition is a `check_expression` of the form
 *     `<simple_identifier> is <user_type>` and the then-branch is a
 *     `control_structure_body`.
 *
 * `else` arms and non-narrowing conditions emit nothing — the fall-through to
 * the outer scope's declared type is the correct semantic.
 */
function synthesizeKotlinSmartCastBindings(rootNode: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];

  for (const whenNode of descendantsOfType(rootNode, 'when_expression')) {
    const subjectName = extractWhenSubjectIdentifier(whenNode);
    if (subjectName === null) continue;

    for (const entry of whenNode.namedChildren) {
      if (entry.type !== 'when_entry') continue;
      const narrowedType = extractIsTestTargetType(entry);
      if (narrowedType === null) continue;
      const body = entry.namedChildren.find((child) => child.type === 'control_structure_body');
      if (body === undefined) continue;
      out.push(buildNarrowedTypeBindingCapture(subjectName.node, body, narrowedType));
    }
  }

  for (const ifNode of descendantsOfType(rootNode, 'if_expression')) {
    const check = ifNode.namedChildren.find((child) => child.type === 'check_expression');
    if (check === undefined) continue;
    const subject = check.namedChildren.find((child) => child.type === 'simple_identifier');
    const typeNode = check.namedChildren.find((child) => isKotlinTypeNode(child));
    if (subject === undefined || typeNode === undefined) continue;
    // The first control_structure_body sibling is the then-branch; else
    // branches (when present) appear as the second control_structure_body
    // and are intentionally not narrowed.
    const body = ifNode.namedChildren.find((child) => child.type === 'control_structure_body');
    if (body === undefined) continue;
    out.push(buildNarrowedTypeBindingCapture(subject, body, typeNode));
  }

  return out;
}

function extractWhenSubjectIdentifier(whenNode: SyntaxNode): { node: SyntaxNode } | null {
  const subject = whenNode.namedChildren.find((child) => child.type === 'when_subject');
  if (subject === undefined) return null;
  const ident = subject.namedChildren.find((child) => child.type === 'simple_identifier');
  return ident === undefined ? null : { node: ident };
}

function extractIsTestTargetType(whenEntry: SyntaxNode): SyntaxNode | null {
  const condition = whenEntry.namedChildren.find((child) => child.type === 'when_condition');
  if (condition === undefined) return null;
  // Exactly one when_condition child must be a positive type_test.
  // Compound conditions (multiple `when_condition` siblings joined with
  // commas in some grammars) or negated `!is` are not safe to narrow.
  if (condition.namedChildCount !== 1) return null;
  const test = condition.namedChild(0);
  if (test === null || test.type !== 'type_test') return null;
  // `!is` produces a different node (`negated_type_test` in some grammars,
  // or an extra `!` child in others) — defend by checking text prefix.
  if (test.text.trim().startsWith('!')) return null;
  return test.namedChildren.find((child) => isKotlinTypeNode(child)) ?? null;
}

function buildNarrowedTypeBindingCapture(
  subject: SyntaxNode,
  bodyAnchor: SyntaxNode,
  typeNode: SyntaxNode,
): CaptureMatch {
  return {
    '@type-binding.annotation': nodeToCapture('@type-binding.annotation', bodyAnchor),
    '@type-binding.name': syntheticCapture('@type-binding.name', subject, subject.text),
    '@type-binding.type': syntheticCapture(
      '@type-binding.type',
      typeNode,
      normalizeKotlinType(typeNode.text),
    ),
    // Marker consumed by `kotlinBindingScopeFor` in simple-hooks.ts to
    // override the scope-extractor's auto-hoist. Unbraced arm bodies
    // (`is User -> obj.save()`) make the body anchor coincide with the
    // Block scope's range; without this marker the binding would hoist
    // to the enclosing function scope and lose its arm-local narrowing.
    '@type-binding.narrowed': syntheticCapture('@type-binding.narrowed', bodyAnchor, '1'),
  };
}

function synthesizeKotlinLocalAssignmentBindings(
  rootNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const classMembers = collectKotlinClassMembers(rootNode);
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const localTypes = new Map<string, string>();
    for (const prop of descendantsOfType(fnNode, 'property_declaration')) {
      const inferred = inferKotlinPropertyType(prop, localTypes, returnTypes, classMembers);
      if (inferred === null) continue;
      localTypes.set(inferred.name.text, inferred.rawType);
      if (inferred.synthetic) {
        out.push({
          '@type-binding.annotation': nodeToCapture('@type-binding.annotation', prop),
          '@type-binding.name': syntheticCapture(
            '@type-binding.name',
            inferred.name,
            inferred.name.text,
          ),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            inferred.source,
            normalizeKotlinType(inferred.rawType),
          ),
        });
      }
    }
  }
  return out;
}

interface KotlinClassMembers {
  /** className → fieldName → raw type text */
  readonly fields: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** className → methodName → raw return type text */
  readonly methods: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/**
 * Per-file class-member index — primary-constructor `val`/`var` params,
 * body property declarations, and method return types. Used by
 * `inferKotlinPropertyType` to walk single-level field and method chains
 * like `val addr = user.address` and `val city = addr.getCity()` (#1760).
 *
 * Indexes by simple class name only. Multi-class collisions inside a
 * single file will pick whichever class was visited last for that name
 * — acceptable because Kotlin forbids same-name top-level classes in
 * one file and per-file resolution is the design boundary here.
 */
function collectKotlinClassMembers(rootNode: SyntaxNode): KotlinClassMembers {
  const fields = new Map<string, Map<string, string>>();
  const methods = new Map<string, Map<string, string>>();
  for (const cls of descendantsOfType(rootNode, 'class_declaration')) {
    const className = cls.namedChildren.find((child) => child.type === 'type_identifier')?.text;
    if (className === undefined) continue;
    const fmap = fields.get(className) ?? new Map<string, string>();
    const mmap = methods.get(className) ?? new Map<string, string>();

    const primary = cls.namedChildren.find((child) => child.type === 'primary_constructor');
    if (primary !== undefined) {
      for (const param of primary.namedChildren) {
        if (param.type !== 'class_parameter') continue;
        // Constructor params are class fields ONLY when prefixed with
        // `val`/`var` (binding_pattern_kind). Plain `fn(x: Int)`-style
        // params remain locals to the constructor.
        if (param.namedChildren.find((c) => c.type === 'binding_pattern_kind') === undefined) {
          continue;
        }
        const fname = param.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
        const ftype = param.namedChildren.find((c) => isKotlinTypeNode(c))?.text;
        if (fname !== undefined && ftype !== undefined) fmap.set(fname, ftype);
      }
    }

    const body = cls.namedChildren.find((child) => child.type === 'class_body');
    if (body !== undefined) {
      for (const member of body.namedChildren) {
        if (member.type === 'property_declaration') {
          const v = member.namedChildren.find((c) => c.type === 'variable_declaration');
          const fname = v?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
          const ftype = v?.namedChildren.find((c) => isKotlinTypeNode(c))?.text;
          if (fname !== undefined && ftype !== undefined) fmap.set(fname, ftype);
        } else if (member.type === 'function_declaration') {
          const mname = member.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
          const paramsIdx = member.namedChildren.findIndex(
            (c) => c.type === 'function_value_parameters',
          );
          const rtype =
            paramsIdx < 0
              ? undefined
              : member.namedChildren.slice(paramsIdx + 1).find((c) => isKotlinTypeNode(c))?.text;
          if (mname !== undefined && rtype !== undefined) mmap.set(mname, rtype);
        }
      }
    }

    fields.set(className, fmap);
    methods.set(className, mmap);
  }
  return { fields, methods };
}

function collectKotlinLocalTypeTexts(
  fnNode: SyntaxNode,
  returnTypes: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of descendants(fnNode)) {
    if (node.type === 'parameter') {
      const name = descendantsOfType(node, 'simple_identifier')[0];
      const type = node.namedChildren.find((child) => isKotlinTypeNode(child));
      if (name !== undefined && type !== undefined) out.set(name.text, type.text);
      continue;
    }

    if (node.type === 'property_declaration') {
      const inferred = inferKotlinPropertyType(node, out, returnTypes);
      if (inferred !== null) out.set(inferred.name.text, inferred.rawType);
    }
  }
  return out;
}

function collectKotlinReturnTypeTexts(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const fnNode of descendantsOfType(rootNode, 'function_declaration')) {
    const name = fnNode.namedChildren.find((child) => child.type === 'simple_identifier');
    const paramsIndex = fnNode.namedChildren.findIndex(
      (child) => child.type === 'function_value_parameters',
    );
    const type =
      paramsIndex < 0
        ? undefined
        : fnNode.namedChildren.slice(paramsIndex + 1).find((child) => isKotlinTypeNode(child));
    if (name !== undefined && type !== undefined) out.set(name.text, type.text);
  }
  return out;
}

function inferKotlinPropertyType(
  prop: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  returnTypes: ReadonlyMap<string, string>,
  classMembers?: KotlinClassMembers,
): { name: SyntaxNode; rawType: string; source: SyntaxNode; synthetic: boolean } | null {
  const variable = prop.namedChildren.find((child) => child.type === 'variable_declaration');
  const name = variable?.namedChildren.find((child) => child.type === 'simple_identifier');
  if (variable === undefined || name === undefined) return null;

  const explicitType = variable.namedChildren.find((child) => isKotlinTypeNode(child));
  if (explicitType !== undefined) {
    return { name, rawType: explicitType.text, source: explicitType, synthetic: false };
  }

  const value = prop.namedChildren.find(
    (child) => child.id !== variable.id && child.type !== 'binding_pattern_kind',
  );
  if (value?.type === 'simple_identifier') {
    const rawType = localTypes.get(value.text);
    return rawType === undefined ? null : { name, rawType, source: value, synthetic: true };
  }

  if (value?.type === 'navigation_expression') {
    // `val addr = user.address` — receiver type → field on that class (#1760).
    const chained = inferKotlinNavigationFieldType(value, localTypes, classMembers);
    if (chained === null) return null;
    return { name, rawType: chained, source: value, synthetic: true };
  }

  if (value?.type === 'call_expression') {
    const callee = value.namedChildren.find(
      (child) => child.type === 'simple_identifier' || child.type === 'navigation_expression',
    );
    if (callee === undefined) return null;
    if (callee.type === 'simple_identifier') {
      const rawType =
        returnTypes.get(callee.text) ?? (isUppercaseName(callee.text) ? callee.text : null);
      if (rawType === null) return null;
      return { name, rawType, source: callee, synthetic: true };
    }
    // `val city = addr.getCity()` — receiver type → method return on that class (#1760).
    const chained = inferKotlinNavigationCallReturnType(callee, localTypes, classMembers);
    if (chained === null) return null;
    return { name, rawType: chained, source: callee, synthetic: true };
  }

  return null;
}

/** Resolve `receiver.field` → field's declared type, where `receiver`
 *  is a simple identifier whose type is in `localTypes` and `field`
 *  is declared on that type in `classMembers.fields`. Returns null
 *  when any link in the chain is unknown — safe over-conservative. */
function inferKotlinNavigationFieldType(
  nav: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  classMembers: KotlinClassMembers | undefined,
): string | null {
  if (classMembers === undefined) return null;
  const receiver = nav.namedChild(0);
  if (receiver === null || receiver.type !== 'simple_identifier') return null;
  const member = nav.namedChildren
    .find((c) => c.type === 'navigation_suffix')
    ?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
  if (member === undefined) return null;
  const recvType = localTypes.get(receiver.text);
  if (recvType === undefined) return null;
  return classMembers.fields.get(normalizeKotlinType(recvType))?.get(member) ?? null;
}

/** Resolve `receiver.method()` → method's declared return type, where
 *  `receiver` is a simple identifier whose type is in `localTypes` and
 *  `method` is declared on that type in `classMembers.methods`. */
function inferKotlinNavigationCallReturnType(
  navCallee: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  classMembers: KotlinClassMembers | undefined,
): string | null {
  if (classMembers === undefined) return null;
  const receiver = navCallee.namedChild(0);
  if (receiver === null || receiver.type !== 'simple_identifier') return null;
  const methodName = navCallee.namedChildren
    .find((c) => c.type === 'navigation_suffix')
    ?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
  if (methodName === undefined) return null;
  const recvType = localTypes.get(receiver.text);
  if (recvType === undefined) return null;
  return classMembers.methods.get(normalizeKotlinType(recvType))?.get(methodName) ?? null;
}

function inferKotlinIterableElementType(
  iterable: SyntaxNode,
  localTypes: ReadonlyMap<string, string>,
  returnTypes: ReadonlyMap<string, string>,
): string | null {
  if (iterable.type === 'simple_identifier') {
    const raw = localTypes.get(iterable.text);
    return raw === undefined ? null : kotlinContainerElementType(raw, 'values');
  }

  if (iterable.type === 'navigation_expression') {
    const receiver = iterable.namedChildren[0];
    const member = iterable.namedChildren
      .find((child) => child.type === 'navigation_suffix')
      ?.namedChildren.find((child) => child.type === 'simple_identifier')?.text;
    if (receiver?.type !== 'simple_identifier') return null;
    const raw = localTypes.get(receiver.text);
    return raw === undefined ? null : kotlinContainerElementType(raw, member ?? 'values');
  }

  if (iterable.type === 'call_expression') {
    const callee = iterable.namedChildren.find((child) => child.type === 'simple_identifier');
    if (callee === undefined) return null;
    const raw = returnTypes.get(callee.text);
    if (raw !== undefined) return kotlinContainerElementType(raw, 'values');
    // Cross-file fallback (#1759): the callee's return type is unknown
    // locally because the function lives in another file. Emit the
    // callee name itself as the binding's rawName; `propagateImported
    // ReturnTypes` will chain-follow `loopvar → callee → <ElementType>`
    // once the imported module's `callee → ElementType` mirror lands at
    // module scope. If `callee` isn't actually an imported callable
    // (e.g. a local lambda or unrelated symbol), chain-follow fails
    // safely and no edge is emitted.
    return callee.text;
  }

  return null;
}

function isUppercaseName(text: string): boolean {
  return /^[A-Z]/.test(text);
}

function kotlinContainerElementType(rawType: string, member: string): string | null {
  const parsed = parseKotlinGeneric(rawType);
  if (parsed === null) return normalizeKotlinType(rawType);

  const base = parsed.base.split('.').pop() ?? parsed.base;
  if (isKotlinMapType(base)) {
    if (member === 'keys') return parsed.args[0] ?? null;
    return parsed.args[1] ?? null;
  }
  if (isKotlinIterableType(base)) return parsed.args[0] ?? null;
  return normalizeKotlinType(rawType);
}

function parseKotlinGeneric(text: string): { base: string; args: string[] } | null {
  const trimmed = text.trim().replace(/\?$/, '');
  const open = trimmed.indexOf('<');
  const close = trimmed.lastIndexOf('>');
  if (open < 0 || close < open) return null;
  return {
    base: trimmed.slice(0, open).trim(),
    args: splitTopLevelKotlinArgs(trimmed.slice(open + 1, close)),
  };
}

function splitTopLevelKotlinArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((arg) => arg.length > 0);
}

function isKotlinMapType(base: string): boolean {
  return ['Map', 'MutableMap', 'HashMap', 'LinkedHashMap'].includes(base);
}

function isKotlinIterableType(base: string): boolean {
  return [
    'List',
    'MutableList',
    'ArrayList',
    'Set',
    'MutableSet',
    'Collection',
    'Iterable',
    'Sequence',
    'Array',
  ].includes(base);
}

function isKotlinTypeNode(node: SyntaxNode): boolean {
  return (
    node.type === 'user_type' || node.type === 'nullable_type' || node.type === 'function_type'
  );
}

function descendantsOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return descendants(node).filter((child) => child.type === type);
}

function descendants(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    out.push(child, ...descendants(child));
  }
  return out;
}

function shouldEmitReadMember(navNode: SyntaxNode): boolean {
  const parent = navNode.parent;
  if (parent === null) return true;
  if (parent.type === 'call_expression') return false;
  if (parent.type === 'directly_assignable_expression') return false;
  return true;
}

/** True when the property_declaration anchored at `range` has a
 *  `call_expression` value sibling (i.e. `val x: T = Foo()`). Used to
 *  suppress the explicit-annotation type-binding capture so the
 *  constructor-inferred binding wins (#1762). */
function propertyDeclHasConstructorValue(rootNode: SyntaxNode, range: Range): boolean {
  const propNode = findNodeAtRange(rootNode, range, 'property_declaration');
  if (propNode === null) return false;
  const variable = propNode.namedChildren.find((c) => c.type === 'variable_declaration');
  if (variable === undefined) return false;
  const value = propNode.namedChildren.find(
    (c) => c.id !== variable.id && c.type !== 'binding_pattern_kind',
  );
  return value?.type === 'call_expression';
}

function callArguments(callNode: SyntaxNode): SyntaxNode[] {
  const suffix = callNode.namedChildren.find((child) => child.type === 'call_suffix');
  if (suffix === undefined) return [];

  const valueArgs = suffix?.namedChildren.find((child) => child.type === 'value_arguments');
  const args = valueArgs?.namedChildren.filter((child) => child.type === 'value_argument') ?? [];
  const trailingLambdas = suffix.namedChildren.filter((child) => child.type === 'annotated_lambda');
  return [...args, ...trailingLambdas];
}

function inferArgType(argNode: SyntaxNode): string {
  const value = argNode.namedChild(0) ?? argNode;
  switch (value.type) {
    case 'integer_literal':
    case 'long_literal':
      return 'Int';
    case 'real_literal':
      return 'Double';
    case 'string_literal':
    case 'line_string_literal':
    case 'multi_line_string_literal':
      return 'String';
    case 'character_literal':
      return 'Char';
    case 'boolean_literal':
      return 'Boolean';
    case 'call_expression': {
      const first = value.namedChild(0);
      return first?.type === 'simple_identifier' ? first.text : '';
    }
    default:
      return '';
  }
}

function extensionFreeCallFallback(
  grouped: Record<string, Capture>,
  rootNode: SyntaxNode,
): CaptureMatch | null {
  const member = grouped['@reference.call.member'];
  const receiver = grouped['@reference.receiver'];
  const name = grouped['@reference.name'];
  if (member === undefined || receiver === undefined || name === undefined) return null;

  const callNode = findNodeAtRange(rootNode, member.range, 'call_expression');
  if (callNode === null) return null;
  const receiverNode = findNodeAtRange(rootNode, receiver.range);
  if (receiverNode === null || !isLiteralReceiver(receiverNode)) return null;

  const out: Record<string, Capture> = {
    '@reference.call.free': syntheticCapture('@reference.call.free', callNode, callNode.text),
    '@reference.name': syntheticCapture('@reference.name', callNode, name.text),
  };
  if (grouped['@reference.arity'] !== undefined)
    out['@reference.arity'] = grouped['@reference.arity'];
  if (grouped['@reference.parameter-types'] !== undefined) {
    out['@reference.parameter-types'] = grouped['@reference.parameter-types'];
  }
  return out;
}

function isLiteralReceiver(node: SyntaxNode): boolean {
  return [
    'integer_literal',
    'long_literal',
    'real_literal',
    'string_literal',
    'line_string_literal',
    'multi_line_string_literal',
    'character_literal',
    'boolean_literal',
  ].includes(node.type);
}

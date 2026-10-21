import type { MixedChainStep } from 'gitnexus-shared';

import type { SyntaxNode } from './ast-helpers.js';
import { CALL_ARGUMENT_LIST_TYPES } from './ast-helpers.js';
import { subscriptBase } from './callable-flow-captures.js';

/** Node types representing call expressions across supported languages. */
export const CALL_EXPRESSION_TYPES = new Set([
  'call_expression', // TS/JS/C/C++/Go/Rust
  'method_invocation', // Java
  'member_call_expression', // PHP
  'nullsafe_member_call_expression', // PHP ?.
  'call', // Python/Ruby
  'invocation_expression', // C#
]);

/**
 * Hard limit on chain depth to prevent runaway recursion.
 * For `a.b().c().d()`, the chain has depth 2 (b and c before d).
 *
 * A chain deeper than this is DISCARDED WHOLE, not truncated:
 * `extractMixedChain` returns an undefined base and the encoder refuses to mint
 * a partial chain, because a base-side prefix decodes cleanly as a shorter,
 * complete-looking chain and would type the receiver against the wrong member.
 * Correct, but it means a builder chain one hop too long contributes nothing at
 * all rather than degrading.
 *
 * DELIBERATELY NOT RAISED. Measured (see bench/receiver-resolution/BASELINE.md,
 * `fourHopChain`): a 4-step chain mints NOTHING at this cap — confirmed by
 * probing the emitter directly — and the site still RESOLVES, because the text
 * cascade that owns the fallback path runs to `COMPOUND_RECEIVER_MAX_DEPTH` (8)
 * and answers where the structural fold declined.
 *
 * So the cap bounds which chains are typed STRUCTURALLY, not which calls
 * resolve. Raising it moves work from the cascade to the fold without changing
 * any edge, and the fixture that proves it is committed so the next person to
 * reach for this number has the measurement rather than the intuition.
 */
export const MAX_CHAIN_DEPTH = 3;

/**
 * Count direct arguments for a call expression across common tree-sitter grammars.
 * Returns undefined when the argument container cannot be located cheaply.
 */
export const countCallArguments = (callNode: SyntaxNode | null | undefined): number | undefined => {
  if (!callNode) return undefined;

  // Direct field or direct child (most languages)
  let argsNode: SyntaxNode | null | undefined =
    callNode.childForFieldName('arguments') ??
    callNode.children.find((child) => CALL_ARGUMENT_LIST_TYPES.has(child.type));

  // Kotlin/Swift: call_expression → call_suffix → value_arguments
  // Search one level deeper for languages that wrap arguments in a suffix node
  if (!argsNode) {
    for (const child of callNode.children) {
      if (!child.isNamed) continue;
      const nested = child.children.find((gc) => CALL_ARGUMENT_LIST_TYPES.has(gc.type));
      if (nested) {
        argsNode = nested;
        break;
      }
    }
  }

  if (!argsNode) return undefined;

  let count = 0;
  for (const child of argsNode.children) {
    if (!child.isNamed) continue;
    if (child.type === 'comment') continue;
    count++;
  }

  return count;
};

// ── Call-form discrimination (Phase 1, Step D) ─────────────────────────

/**
 * AST node types that indicate a member-access wrapper around the callee name.
 * When nameNode.parent.type is one of these, the call is a member call.
 */
const MEMBER_ACCESS_NODE_TYPES = new Set([
  'member_expression', // TS/JS: obj.method()
  'attribute', // Python: obj.method()
  'member_access_expression', // C#: obj.Method()
  'field_expression', // Rust/C++: obj.method() / ptr->method()
  'selector_expression', // Go: obj.Method()
  'navigation_suffix', // Kotlin/Swift: obj.method() — nameNode sits inside navigation_suffix
  'member_binding_expression', // C#: user?.Method() — null-conditional access
  'unconditional_assignable_selector', // Dart: obj.method() — nameNode inside selector > unconditional_assignable_selector
]);

/**
 * Call node types that are inherently constructor invocations.
 * Only includes patterns that the tree-sitter queries already capture as @call.
 */
const CONSTRUCTOR_CALL_NODE_TYPES = new Set([
  'constructor_invocation', // Kotlin: Foo()
  'new_expression', // TS/JS/C++: new Foo()
  'object_creation_expression', // Java/C#/PHP: new Foo()
  'implicit_object_creation_expression', // C# 9: User u = new(...)
  'composite_literal', // Go: User{...}
  'struct_expression', // Rust: User { ... }
]);

/**
 * AST node types for scoped/qualified calls (e.g., Foo::new() in Rust, Foo::bar() in C++).
 */
const SCOPED_CALL_NODE_TYPES = new Set([
  'scoped_identifier', // Rust: Foo::new()
  'qualified_identifier', // C++: ns::func()
]);

type CallForm = 'free' | 'member' | 'constructor';

/**
 * Infer whether a captured call site is a free call, member call, or constructor.
 * Returns undefined if the form cannot be determined.
 *
 * Works by inspecting the AST structure between callNode (@call) and nameNode (@call.name).
 * No tree-sitter query changes needed — the distinction is in the node types.
 */
export const inferCallForm = (callNode: SyntaxNode, nameNode: SyntaxNode): CallForm | undefined => {
  // 1. Constructor: callNode itself is a constructor invocation (Kotlin)
  if (CONSTRUCTOR_CALL_NODE_TYPES.has(callNode.type)) {
    return 'constructor';
  }

  // 2. Member call: nameNode's parent is a member-access wrapper
  const nameParent = nameNode.parent;
  if (nameParent && MEMBER_ACCESS_NODE_TYPES.has(nameParent.type)) {
    return 'member';
  }

  // 3. PHP: the callNode itself distinguishes member vs free calls
  if (
    callNode.type === 'member_call_expression' ||
    callNode.type === 'nullsafe_member_call_expression'
  ) {
    return 'member';
  }
  if (callNode.type === 'scoped_call_expression') {
    return 'member'; // static call Foo::bar()
  }

  // 4. Java method_invocation: member if it has an 'object' field
  if (callNode.type === 'method_invocation' && callNode.childForFieldName('object')) {
    return 'member';
  }

  // 4b. Ruby call with receiver: obj.method
  if (callNode.type === 'call' && callNode.childForFieldName('receiver')) {
    return 'member';
  }

  // 5. Scoped calls (Rust Foo::new(), C++ ns::func()): treat as free
  //    The receiver is a type, not an instance — handled differently in Phase 3
  if (nameParent && SCOPED_CALL_NODE_TYPES.has(nameParent.type)) {
    return 'free';
  }

  // 6. Default: if nameNode is a direct child of callNode, it's a free call
  if (nameNode.parent === callNode || nameParent?.parent === callNode) {
    return 'free';
  }

  return undefined;
};

/**
 * Extract the receiver identifier for member calls.
 * Only captures simple identifiers — returns undefined for complex expressions
 * like getUser().save() or arr[0].method().
 */
const SIMPLE_RECEIVER_TYPES = new Set([
  'identifier',
  'simple_identifier',
  'variable_name', // PHP $variable (tree-sitter-php)
  'name', // PHP name node
  'this', // TS/JS/Java/C# this.method()
  'self', // Rust/Python self.method()
  'super', // TS/JS/Java/Kotlin/Ruby super.method()
  'super_expression', // Kotlin wraps super in super_expression
  'base', // C# base.Method()
  'parent', // PHP parent::method()
  'constant', // Ruby CONSTANT.method() (uppercase identifiers)
]);

export const extractReceiverName = (nameNode: SyntaxNode): string | undefined => {
  const parent = nameNode.parent;
  if (!parent) return undefined;

  // PHP: member_call_expression / nullsafe_member_call_expression — receiver is on the callNode
  // Java: method_invocation — receiver is the 'object' field on callNode
  // For these, parent of nameNode is the call itself, so check the call's object field
  const callNode = parent.parent ?? parent;

  let receiver: SyntaxNode | null = null;

  // Try standard field names used across grammars
  receiver =
    parent.childForFieldName('object') ?? // TS/JS member_expression, Python attribute, PHP, Java
    parent.childForFieldName('value') ?? // Rust field_expression
    parent.childForFieldName('operand') ?? // Go selector_expression
    parent.childForFieldName('expression') ?? // C# member_access_expression
    parent.childForFieldName('argument'); // C++ field_expression

  // Java method_invocation: 'object' field is on the callNode, not on nameNode's parent
  if (!receiver && callNode.type === 'method_invocation') {
    receiver = callNode.childForFieldName('object');
  }

  // PHP: member_call_expression has 'object' on the call node
  if (
    !receiver &&
    (callNode.type === 'member_call_expression' ||
      callNode.type === 'nullsafe_member_call_expression')
  ) {
    receiver = callNode.childForFieldName('object');
  }

  // Ruby: call node has 'receiver' field
  if (!receiver && parent.type === 'call') {
    receiver = parent.childForFieldName('receiver');
  }

  // PHP scoped_call_expression (parent::method(), self::method()):
  // nameNode's direct parent IS the scoped_call_expression (name is a direct child)
  if (
    !receiver &&
    (parent.type === 'scoped_call_expression' || callNode.type === 'scoped_call_expression')
  ) {
    const scopedCall = parent.type === 'scoped_call_expression' ? parent : callNode;
    receiver = scopedCall.childForFieldName('scope');
    // relative_scope wraps 'parent'/'self'/'static' — unwrap to get the keyword
    if (receiver?.type === 'relative_scope') {
      receiver = receiver.firstChild;
    }
  }

  // Dart: unconditional_assignable_selector is inside a `selector`, which is a sibling
  // of the receiver in the expression_statement.  For `user.save()`, the previous named
  // sibling of the `selector` is `identifier [user]`.
  if (!receiver && parent.type === 'unconditional_assignable_selector') {
    const selectorNode = parent.parent; // selector [.save]
    if (selectorNode) {
      receiver = selectorNode.previousNamedSibling;
    }
  }

  // C# null-conditional: user?.Save() → conditional_access_expression wraps member_binding_expression
  if (!receiver && parent.type === 'member_binding_expression') {
    const condAccess = parent.parent;
    if (condAccess?.type === 'conditional_access_expression') {
      receiver = condAccess.firstNamedChild;
    }
  }

  // Kotlin/Swift: navigation_expression target is the first child
  if (!receiver && parent.type === 'navigation_suffix') {
    const navExpr = parent.parent;
    if (navExpr?.type === 'navigation_expression') {
      // First named child is the target (receiver)
      for (const child of navExpr.children) {
        if (child.isNamed && child !== parent) {
          receiver = child;
          break;
        }
      }
    }
  }

  if (!receiver) return undefined;

  // Only capture simple identifiers — refuse complex expressions
  if (SIMPLE_RECEIVER_TYPES.has(receiver.type)) {
    return receiver.text;
  }

  // Python super().method(): receiver is a call node `super()` — extract the function name
  if (receiver.type === 'call') {
    const func = receiver.childForFieldName('function');
    if (func?.text === 'super') return 'super';
  }

  return undefined;
};

/**
 * Extract the raw receiver AST node for a member call.
 * Unlike extractReceiverName, this returns the receiver node regardless of its type —
 * including call_expression / method_invocation nodes that appear in chained calls
 * like `svc.getUser().save()`.
 *
 * Returns undefined when the call is not a member call or when no receiver node
 * can be found (e.g. top-level free calls).
 */
export const extractReceiverNode = (nameNode: SyntaxNode): SyntaxNode | undefined => {
  const parent = nameNode.parent;
  if (!parent) return undefined;

  const callNode = parent.parent ?? parent;

  let receiver: SyntaxNode | null = null;

  receiver =
    parent.childForFieldName('object') ??
    parent.childForFieldName('value') ??
    parent.childForFieldName('operand') ??
    parent.childForFieldName('expression') ??
    parent.childForFieldName('argument');

  if (!receiver && callNode.type === 'method_invocation') {
    receiver = callNode.childForFieldName('object');
  }

  if (
    !receiver &&
    (callNode.type === 'member_call_expression' ||
      callNode.type === 'nullsafe_member_call_expression')
  ) {
    receiver = callNode.childForFieldName('object');
  }

  if (!receiver && parent.type === 'call') {
    receiver = parent.childForFieldName('receiver');
  }

  if (
    !receiver &&
    (parent.type === 'scoped_call_expression' || callNode.type === 'scoped_call_expression')
  ) {
    const scopedCall = parent.type === 'scoped_call_expression' ? parent : callNode;
    receiver = scopedCall.childForFieldName('scope');
    if (receiver?.type === 'relative_scope') {
      receiver = receiver.firstChild;
    }
  }

  // Dart: unconditional_assignable_selector — receiver is previous sibling of the selector
  if (!receiver && parent.type === 'unconditional_assignable_selector') {
    const selectorNode = parent.parent;
    if (selectorNode) {
      receiver = selectorNode.previousNamedSibling;
    }
  }

  if (!receiver && parent.type === 'member_binding_expression') {
    const condAccess = parent.parent;
    if (condAccess?.type === 'conditional_access_expression') {
      receiver = condAccess.firstNamedChild;
    }
  }

  if (!receiver && parent.type === 'navigation_suffix') {
    const navExpr = parent.parent;
    if (navExpr?.type === 'navigation_expression') {
      for (const child of navExpr.children) {
        if (child.isNamed && child !== parent) {
          receiver = child;
          break;
        }
      }
    }
  }

  return receiver ?? undefined;
};

// ── Chained-call extraction ───────────────────────────────────────────────

/** Node types representing member/field access across languages. */
/**
 * Await expressions, per grammar. The walk previously stopped here — an await
 * node is neither a call nor a field access — so `(await svc.getUserAsync()).save()`
 * minted NO chain at all and the receiver fell to the text cascade.
 */
const AWAIT_EXPRESSION_NODE_TYPES = new Set([
  'await_expression', // TS/JS/C#/Rust
  'await', // Python
]);

/**
 * Subscript / index expressions, per grammar. Same story as await: the walk
 * stopped, so `repos[0].save()` minted no chain — which is why `indexElement`
 * is an INVISIBLE-GAP (no edge AND no recorded drop) in all 14 languages, the
 * most uniform cell in the matrix.
 */
const SUBSCRIPT_NODE_TYPES = new Set([
  'subscript_expression', // TS/JS/PHP/C/C++
  'subscript', // Python
  'index_expression', // Go/Rust
  'element_access_expression', // C#
  'array_access', // Java
  'indexing_expression', // Kotlin
  'element_reference', // Ruby
]);

/**
 * Call nodes that spell a SUBSCRIPT. Swift has no subscript node: `repos[0]`
 * parses as `call_expression → call_suffix → value_arguments`, exactly like a
 * call, except that the argument list is delimited by `[`/`]` rather than
 * `(`/`)`. Walked as a call it named no member (or, for `svc.users[0]`, named
 * `users` as if it were a method), so the subscript never became an index step.
 *
 * Keyed by the suffix node type; the value is the argument-list node type
 * inside it. The opening `[` token is what tells a subscript from a call.
 */
const BRACKETED_CALL_SUFFIXES = new Map<string, string>([
  ['call_suffix', 'value_arguments'], // Swift `repos[0]`
]);

/** Is `node` a call node that is really a subscript, `repos[0]`? */
function isBracketedSubscriptCall(node: SyntaxNode): boolean {
  if (!CALL_EXPRESSION_TYPES.has(node.type)) return false;
  const suffix = node.lastNamedChild;
  if (suffix === null) return false;
  const argumentListType = BRACKETED_CALL_SUFFIXES.get(suffix.type);
  if (argumentListType === undefined) return false;
  const argumentList = suffix.firstNamedChild;
  return argumentList?.type === argumentListType && argumentList.firstChild?.type === '[';
}

/**
 * Can the chain walk descend into this node, or is it the base?
 *
 * ONE predicate for all four branches. The call and field branches previously
 * tested only the call/field sets, so a receiver like `x[0].f().g()` stopped at
 * the subscript and returned the literal text `x[0]` as the base — which
 * `isEncodableSegment` accepts, minting a chain whose base binds to nothing. And
 * `(await f()).g.h()` returned `await f()`, rejected on whitespace, minting no
 * chain at all. Adding a fifth step kind must not require remembering four
 * separate call sites.
 */
function isChainableReceiverNode(node: SyntaxNode): boolean {
  return (
    CALL_EXPRESSION_TYPES.has(node.type) ||
    FIELD_ACCESS_NODE_TYPES.has(node.type) ||
    AWAIT_EXPRESSION_NODE_TYPES.has(node.type) ||
    SUBSCRIPT_NODE_TYPES.has(node.type) ||
    CONDITIONAL_ACCESS_NODE_TYPES.has(node.type)
  );
}

const FIELD_ACCESS_NODE_TYPES = new Set([
  'member_expression', // TS/JS
  'member_access_expression', // C#
  'selector_expression', // Go
  'field_expression', // Rust/C++
  'field_access', // Java
  'attribute', // Python
  'navigation_expression', // Kotlin/Swift
  'member_binding_expression', // C# null-conditional (user?.Address)
]);

/**
 * Null-conditional access, which splits one member access across two nodes.
 * C# parses `svc?.GetUser()` as
 * `conditional_access_expression(condition: svc, member_binding_expression)`:
 * the receiver sits in the outer node's `condition` field and the member name
 * in the binding child. Read like any other callee, the step was named
 * `.GetUser` and had no inner receiver, so no chain was built and the call was
 * lost without a drop. As a receiver (`svc?.Address.Save()`) the node stopped
 * the walk, and its whole text became the base.
 *
 * Keyed by node type; the value is the field that holds the receiver.
 */
const CONDITIONAL_ACCESS_NODE_TYPES = new Map<string, string>([
  ['conditional_access_expression', 'condition'], // C# `svc?.GetUser()`, `svc?.Address`, `repos?[0]`
]);

/** The binding child of a conditional access that names a member: C# `?.Name`. */
const MEMBER_BINDING_NODE_TYPES = new Set(['member_binding_expression']);

/** The binding child of a conditional access that is a subscript: C# `?[0]`. */
const ELEMENT_BINDING_NODE_TYPES = new Set(['element_binding_expression']);

/** The receiver of a conditional access, or `null` for any other node. */
function conditionalAccessReceiver(node: SyntaxNode): SyntaxNode | null {
  const field = CONDITIONAL_ACCESS_NODE_TYPES.get(node.type);
  return field === undefined ? null : node.childForFieldName(field);
}

/**
 * One step in a mixed receiver chain.
 *
 * Owned by `gitnexus-shared` — it is part of the ScopeExtractor output
 * contract, and resolution consumes it. Re-exported here so the producer's
 * existing importers keep a single import site.
 */
export type { MixedChainStep };

/**
 * Walk a receiver AST node that is itself a call expression, accumulating the
 * chain of intermediate method names up to MAX_CHAIN_DEPTH.
 *
 * For `svc.getUser().save()`, called with the receiver of `save` (getUser() call):
 *   returns { chain: ['getUser'], baseReceiverName: 'svc' }
 *
 * For `a.b().c().d()`, called with the receiver of `d` (c() call):
 *   returns { chain: ['b', 'c'], baseReceiverName: 'a' }
 */
export function extractCallChain(
  receiverCallNode: SyntaxNode,
): { chain: string[]; baseReceiverName: string | undefined } | undefined {
  const chain: string[] = [];
  let current: SyntaxNode = receiverCallNode;

  while (CALL_EXPRESSION_TYPES.has(current.type) && chain.length < MAX_CHAIN_DEPTH) {
    // Extract the method name from this call node.
    const funcNode =
      current.childForFieldName?.('function') ??
      current.childForFieldName?.('name') ??
      current.childForFieldName?.('method'); // Ruby `call` node
    let methodName: string | undefined;
    let innerReceiver: SyntaxNode | null = null;
    if (funcNode) {
      // member_expression / attribute: last named child is the method identifier
      methodName = funcNode.lastNamedChild?.text ?? funcNode.text;
    }
    // Kotlin/Swift: call_expression exposes callee as firstNamedChild, not a field.
    // navigation_expression: method name is in navigation_suffix → simple_identifier.
    if (!funcNode && current.type === 'call_expression') {
      const callee = current.firstNamedChild;
      if (callee?.type === 'navigation_expression') {
        const suffix = callee.lastNamedChild;
        if (suffix?.type === 'navigation_suffix') {
          methodName = suffix.lastNamedChild?.text;
          // The receiver is the part of navigation_expression before the suffix
          for (let i = 0; i < callee.namedChildCount; i++) {
            const child = callee.namedChild(i);
            if (child && child.type !== 'navigation_suffix') {
              innerReceiver = child;
              break;
            }
          }
        }
      }
    }
    if (!methodName) break;
    chain.unshift(methodName); // build chain outermost-last

    // Walk into the receiver of this call to continue the chain
    if (!innerReceiver && funcNode) {
      innerReceiver =
        funcNode.childForFieldName?.('object') ??
        funcNode.childForFieldName?.('value') ??
        funcNode.childForFieldName?.('operand') ??
        funcNode.childForFieldName?.('expression');
    }
    // Java method_invocation: object field is on the call node
    if (!innerReceiver && current.type === 'method_invocation') {
      innerReceiver = current.childForFieldName?.('object');
    }
    // PHP member_call_expression
    if (
      !innerReceiver &&
      (current.type === 'member_call_expression' ||
        current.type === 'nullsafe_member_call_expression')
    ) {
      innerReceiver = current.childForFieldName?.('object');
    }
    // Ruby `call` node: receiver field is on the call node itself
    if (!innerReceiver && current.type === 'call') {
      innerReceiver = current.childForFieldName?.('receiver');
    }

    if (!innerReceiver) break;

    if (CALL_EXPRESSION_TYPES.has(innerReceiver.type)) {
      current = innerReceiver; // continue walking
    } else {
      // Reached a simple identifier — the base receiver
      return {
        chain,
        baseReceiverName: unwrapTransparentReceiver(innerReceiver).text || undefined,
      };
    }
  }

  return chain.length > 0 ? { chain, baseReceiverName: undefined } : undefined;
}

/**
 * Walk a receiver AST node that may interleave field accesses and method calls,
 * building a unified chain of steps up to MAX_CHAIN_DEPTH.
 *
 * For `svc.getUser().address.save()`, called with the receiver of `save`
 * (`svc.getUser().address`, a field access node):
 *   returns { chain: [{ kind:'call', name:'getUser' }, { kind:'field', name:'address' }],
 *             baseReceiverName: 'svc' }
 *
 * For `user.getAddress().city.getName()`, called with receiver of `getName`
 * (`user.getAddress().city`):
 *   returns { chain: [{ kind:'call', name:'getAddress' }, { kind:'field', name:'city' }],
 *             baseReceiverName: 'user' }
 *
 * Pure field chains and pure call chains are special cases (all steps same kind).
 */
/**
 * Node types that wrap an expression without changing what it denotes, so a
 * receiver chain's BASE can be read through them.
 *
 * `svc!` (TS non-null assertion) and `(svc)` denote exactly `svc`; taking the
 * wrapper's own text instead yields `svc!` / `(svc)`, which matches no binding
 * and silently costs the chain its base.
 *
 * Deliberately EXCLUDES a cast (`x as T`, `(T)x`): a cast changes the type an
 * expression denotes, so reading through one would type the receiver as the
 * operand rather than as the cast target.
 *
 * Keyed by node type; the value is the operator text that has to TERMINATE the
 * node for the peel to apply, `null` for a node type that is transparent
 * unconditionally, or `SOLE_ELEMENT` for a tuple node that is transparent only
 * when it holds exactly one element.
 *
 * The gated entry exists because Swift force-unwrap (`self.a!`) is the exact
 * semantic of TypeScript's `non_null_expression` — it yields the wrapped type —
 * but Swift parses it as the general `postfix_expression`, which ALSO carries
 * user-defined postfix operators. Those can return anything, so peeling that
 * node type unconditionally would type the receiver as the operand and could
 * produce a confidently wrong owner. Reading the operator keeps the peel to the
 * case that is provably type-preserving.
 *
 * The `SOLE_ELEMENT` entry exists because Swift has no parenthesized-expression
 * node: `(await svc.getUserAsync())` parses as a `tuple_expression` with one
 * element. Only that shape denotes its operand. Rust also emits
 * `tuple_expression`, and there `(svc,)` is a real one-element tuple; the
 * trailing comma is an extra child, so the gate leaves it alone, as it does
 * Swift's labelled `(x: svc)` and every tuple of two or more.
 */
const SOLE_ELEMENT = Symbol('sole-element');

const TRANSPARENT_RECEIVER_WRAPPERS = new Map<string, string | null | typeof SOLE_ELEMENT>([
  ['non_null_expression', null], // TypeScript `svc!`
  ['parenthesized_expression', null], // `(svc)`
  // NOT Swift-only: Kotlin's `!!` non-null assertion parses as the same node type
  // and is equally type-preserving, so it is peeled too. Measured — the
  // receiver-resolution bench moved `kotlin.nonNullAssert` VISIBLE-GAP ->
  // RESOLVES when this landed, which is how the Kotlin effect was discovered
  // rather than assumed. Any other grammar emitting `postfix_expression` is
  // affected as well; the `!` gate, not the language, is what bounds this.
  ['postfix_expression', '!'], // Swift `self.a!`, Kotlin `a!!`
  // C#'s null-forgiving `svc!`. The same node type carries `x++` and `x--`,
  // which the `!` gate leaves alone.
  ['postfix_unary_expression', '!'], // C# `svc!`
  ['tuple_expression', SOLE_ELEMENT], // Swift `(await svc.getUserAsync())`
]);

/** Is `node` a wrapper that denotes exactly what its operand denotes? */
function isTransparentReceiverWrapper(node: SyntaxNode): boolean {
  // `node.type` is a native getter, and this predicate runs on every receiver
  // node. Crossing it twice for two separate table lookups measured 376 ns/check
  // against 188 ns for the single read below.
  const operator = TRANSPARENT_RECEIVER_WRAPPERS.get(node.type);
  // `undefined` is "not in the table"; `null` is "in the table, ungated". The
  // two are distinguishable, so one `get` answers both questions — no separate
  // `has` probe, and one crossing of the native `node.type` getter.
  if (operator === undefined) return false;
  if (operator === null) return true;
  // `(`, the element, `)`: anything more is a comma, a label or a second
  // element, and then the node is a real tuple.
  if (operator === SOLE_ELEMENT) return node.childCount === 3 && node.namedChildCount === 1;
  // The operator is an anonymous token, so it is not in `namedChildren`; the
  // node's own text is the reliable place to read it. Deliberately NOT
  // `node.lastChild` — measured 3x SLOWER (the child wrapper allocation
  // dominates), and the token surfaces with type `bang`, not `!`.
  return node.text.trimEnd().endsWith(operator);
}

/**
 * Iteration bound for the wrapper peel. Its OWN constant, not `MAX_CHAIN_DEPTH`.
 *
 * The two answer unrelated questions — "how many chain hops do we type?" versus
 * "how many redundant parens might someone write?" — and sharing one number
 * meant raising the chain cap silently widened this loop as a side effect. That
 * coupling is easy to miss precisely because the shared name reads as
 * intentional. `((x))` nests twice; nothing real nests deeply.
 */
const MAX_TRANSPARENT_WRAPPER_DEPTH = 3;

/** Peel transparent wrappers off a base receiver node. */
function unwrapTransparentReceiver(node: SyntaxNode): SyntaxNode {
  let current = node;
  for (let i = 0; i < MAX_TRANSPARENT_WRAPPER_DEPTH && isTransparentReceiverWrapper(current); i++) {
    const inner = current.namedChildren?.find((c) => c !== null);
    if (inner === undefined || inner === null) break;
    current = inner;
  }
  return current;
}

/**
 * Callee nodes that carry EXPLICIT TYPE ARGUMENTS inside them.
 *
 * TypeScript, Java and Kotlin put `<User>` beside the callee, in a sibling field,
 * so the walk never sees it. These grammars put it inside the callee node:
 * C# `svc.GetTyped<User>()` and C++ `svc->getTyped<User>()` wrap the member
 * name, so the step was named `GetTyped<User>` and matched no member. Rust's
 * `svc.get_typed::<User>()` wraps the whole field access, so the walk found no
 * name and no inner receiver, and minted no chain at all.
 *
 * Type arguments pick an instantiation. They never change which member is
 * called, so the step name loses nothing when they are dropped. Substituting
 * them into a generic return type is a separate problem: C++
 * `template <typename T> T* getTyped()` still has no return type to fold.
 *
 * Keyed by node type. The value is the field that holds the callee without its
 * type arguments, or `null` where the grammar gives that child no field name
 * (it is then the first named child).
 */
const TYPE_ARGUMENT_CALLEE_NODE_TYPES = new Map<string, string | null>([
  ['generic_name', null], // C# `GetTyped<User>`
  ['template_method', 'name'], // C++ `svc->getTyped<User>`
  ['template_function', 'name'], // C++ `getTyped<User>`
  ['dependent_name', null], // C++ `svc->template getTyped<User>`, wraps a template_method
  ['generic_function', 'function'], // Rust `svc.get_typed::<User>`, wraps the field access
]);

/** Iteration bound for the type-argument peel. `dependent_name` nests a
 *  `template_method`, so real code needs two. */
const MAX_TYPE_ARGUMENT_PEEL_DEPTH = 3;

/** `node` without the explicit type arguments it carries, if any. */
function stripTypeArguments(node: SyntaxNode): SyntaxNode {
  let current = node;
  for (let i = 0; i < MAX_TYPE_ARGUMENT_PEEL_DEPTH; i++) {
    const field = TYPE_ARGUMENT_CALLEE_NODE_TYPES.get(current.type);
    if (field === undefined) break;
    const inner = field === null ? current.firstNamedChild : current.childForFieldName(field);
    if (inner === null) break;
    current = inner;
  }
  return current;
}

/**
 * The member a call's callee names, without type arguments. For a
 * null-conditional callee (`svc?.GetUser`) that is the name inside its member
 * binding; an element binding (`handlers?[0]()`) names no member.
 */
function calleeMemberName(funcNode: SyntaxNode): string | undefined {
  const member = funcNode.lastNamedChild;
  if (member === null) return funcNode.text;
  if (!CONDITIONAL_ACCESS_NODE_TYPES.has(funcNode.type)) return stripTypeArguments(member).text;
  const name = MEMBER_BINDING_NODE_TYPES.has(member.type) ? member.childForFieldName('name') : null;
  return name === null ? undefined : stripTypeArguments(name).text;
}

export function extractMixedChain(
  receiverNode: SyntaxNode,
): { chain: MixedChainStep[]; baseReceiverName: string | undefined } | undefined {
  const chain: MixedChainStep[] = [];
  let current: SyntaxNode = receiverNode;

  while (chain.length < MAX_CHAIN_DEPTH) {
    // Peel transparent wrappers at LOOP ENTRY, not only where a base is
    // returned. `(await svc.getUserAsync()).save()` hands this walk a
    // `parenthesized_expression`, which matches no branch below, so the walk
    // fell straight through to the base case with an empty chain and minted
    // nothing — the await step could never be reached.
    current = unwrapTransparentReceiver(current);
    const subscriptCall = isBracketedSubscriptCall(current);
    if (CALL_EXPRESSION_TYPES.has(current.type) && !subscriptCall) {
      // ── Call expression: extract method name + inner receiver ────────────
      const callee =
        current.childForFieldName?.('function') ??
        current.childForFieldName?.('name') ??
        current.childForFieldName?.('method');
      // Rust's turbofish wraps the whole field access, so peel it before
      // reading either the name or the receiver.
      const funcNode = callee ? stripTypeArguments(callee) : null;
      let methodName: string | undefined;
      let innerReceiver: SyntaxNode | null = null;

      if (funcNode) {
        methodName = calleeMemberName(funcNode);
      }
      // Kotlin/Swift: call_expression → navigation_expression
      if (!funcNode && current.type === 'call_expression') {
        const callee = current.firstNamedChild;
        if (callee?.type === 'navigation_expression') {
          const suffix = callee.lastNamedChild;
          if (suffix?.type === 'navigation_suffix') {
            methodName = suffix.lastNamedChild?.text;
            for (let i = 0; i < callee.namedChildCount; i++) {
              const child = callee.namedChild(i);
              if (child && child.type !== 'navigation_suffix') {
                innerReceiver = child;
                break;
              }
            }
          }
        }
      }
      if (!methodName) break;
      chain.unshift({ kind: 'call', name: methodName });

      if (!innerReceiver && funcNode) {
        innerReceiver =
          funcNode.childForFieldName?.('object') ??
          funcNode.childForFieldName?.('value') ??
          funcNode.childForFieldName?.('operand') ??
          funcNode.childForFieldName?.('argument') ?? // C/C++ field_expression
          funcNode.childForFieldName?.('expression') ??
          conditionalAccessReceiver(funcNode);
      }
      if (!innerReceiver && current.type === 'method_invocation') {
        innerReceiver = current.childForFieldName?.('object') ?? null;
      }
      if (
        !innerReceiver &&
        (current.type === 'member_call_expression' ||
          current.type === 'nullsafe_member_call_expression')
      ) {
        innerReceiver = current.childForFieldName?.('object') ?? null;
      }
      if (!innerReceiver && current.type === 'call') {
        innerReceiver = current.childForFieldName?.('receiver') ?? null;
      }
      if (!innerReceiver) break;

      if (isChainableReceiverNode(innerReceiver)) {
        current = innerReceiver;
      } else {
        return {
          chain,
          baseReceiverName: unwrapTransparentReceiver(innerReceiver).text || undefined,
        };
      }
    } else if (FIELD_ACCESS_NODE_TYPES.has(current.type)) {
      // ── Field/member access: extract property name + inner object ─────────
      let propertyName: string | undefined;
      let innerObject: SyntaxNode | null = null;

      if (current.type === 'navigation_expression') {
        for (const child of current.children ?? []) {
          if (child.type === 'navigation_suffix') {
            for (const sc of child.children ?? []) {
              if (sc.isNamed && sc.type !== '.') {
                propertyName = sc.text;
                break;
              }
            }
          } else if (child.isNamed && !innerObject) {
            innerObject = child;
          }
        }
      } else if (current.type === 'attribute') {
        innerObject = current.childForFieldName?.('object') ?? null;
        propertyName = current.childForFieldName?.('attribute')?.text;
      } else {
        innerObject =
          current.childForFieldName?.('object') ??
          current.childForFieldName?.('value') ??
          current.childForFieldName?.('operand') ??
          current.childForFieldName?.('argument') ?? // C/C++ field_expression
          current.childForFieldName?.('expression') ??
          null;
        propertyName = (
          current.childForFieldName?.('property') ??
          current.childForFieldName?.('field') ??
          current.childForFieldName?.('name')
        )?.text;
      }

      if (!propertyName) break;
      chain.unshift({ kind: 'field', name: propertyName });

      if (!innerObject) break;

      if (isChainableReceiverNode(innerObject)) {
        current = innerObject;
      } else {
        return {
          chain,
          baseReceiverName: unwrapTransparentReceiver(innerObject).text || undefined,
        };
      }
    } else if (AWAIT_EXPRESSION_NODE_TYPES.has(current.type)) {
      // Name-free: the awaited call's method name already lives on its own
      // `call` step, so this records only that an await happened.
      chain.unshift({ kind: 'await' });
      const inner =
        current.childForFieldName?.('argument') ??
        current.childForFieldName?.('expression') ??
        current.namedChildren?.find((c: SyntaxNode) => c !== null) ??
        null;
      if (!inner) break;
      if (isChainableReceiverNode(inner)) {
        current = inner;
      } else {
        return {
          chain,
          baseReceiverName: unwrapTransparentReceiver(inner).text || undefined,
        };
      }
    } else if (subscriptCall || SUBSCRIPT_NODE_TYPES.has(current.type)) {
      // Name-free: a subscript key is a VALUE, not an identifier the resolver
      // could look up, so there is no member name to record.
      chain.unshift({ kind: 'index' });
      // Shared per-grammar table — it knows Python's `value` and Java's `array`,
      // which a locally-written ladder omitted (they worked only because the
      // container happened to be the first named child, an ordering coincidence
      // rather than a contract). Falls back for grammars whose subscript node
      // carries no `index` field.
      const obj =
        subscriptBase(current) ??
        current.childForFieldName?.('object') ??
        current.childForFieldName?.('argument') ??
        current.childForFieldName?.('operand') ??
        current.childForFieldName?.('expression') ??
        current.namedChildren?.find((c: SyntaxNode) => c !== null) ??
        null;
      if (!obj) break;
      if (isChainableReceiverNode(obj)) {
        current = obj;
      } else {
        return {
          chain,
          baseReceiverName: unwrapTransparentReceiver(obj).text || undefined,
        };
      }
    } else if (CONDITIONAL_ACCESS_NODE_TYPES.has(current.type)) {
      // ── Null-conditional access as a receiver: `svc?.Address`, `repos?[0]` ──
      const binding = current.lastNamedChild;
      if (binding !== null && MEMBER_BINDING_NODE_TYPES.has(binding.type)) {
        const name = binding.childForFieldName('name')?.text;
        if (!name) break;
        chain.unshift({ kind: 'field', name });
      } else if (binding !== null && ELEMENT_BINDING_NODE_TYPES.has(binding.type)) {
        chain.unshift({ kind: 'index' });
      } else {
        break;
      }
      const inner = conditionalAccessReceiver(current);
      if (!inner) break;
      if (isChainableReceiverNode(inner)) {
        current = inner;
      } else {
        return {
          chain,
          baseReceiverName: unwrapTransparentReceiver(inner).text || undefined,
        };
      }
    } else if (current.type === 'selector') {
      // ── Dart: flat selector siblings (user.address.save() uses selector nodes) ──
      // Extract field name from unconditional_assignable_selector child
      const uas = current.namedChildren?.find(
        (c: SyntaxNode) => c.type === 'unconditional_assignable_selector',
      );
      const propertyName = uas?.namedChildren?.find(
        (c: SyntaxNode) => c.type === 'identifier',
      )?.text;
      if (!propertyName) break;
      chain.unshift({ kind: 'field', name: propertyName });

      // Walk to previous sibling for the next step in the chain
      const prev = current.previousNamedSibling;
      if (!prev) break;
      if (prev.type === 'selector') {
        current = prev;
      } else {
        // Base receiver (identifier or other terminal)
        return { chain, baseReceiverName: prev.text || undefined };
      }
    } else {
      // Simple identifier — this is the base receiver
      return chain.length > 0 ? { chain, baseReceiverName: current.text || undefined } : undefined;
    }
  }

  return chain.length > 0 ? { chain, baseReceiverName: undefined } : undefined;
}

/** Arg types per call position (literals + optional TypeEnv for ids); undefined if unusable */
export const extractCallArgTypes = (
  callNode: SyntaxNode,
  inferLiteralType: (node: SyntaxNode) => string | undefined,
  typeEnvLookup?: (varName: string, callNode: SyntaxNode) => string | undefined,
): (string | undefined)[] | undefined => {
  let argList: SyntaxNode | undefined =
    callNode.childForFieldName?.('arguments') ??
    callNode.children.find(
      (c: SyntaxNode) =>
        c.type === 'arguments' || c.type === 'argument_list' || c.type === 'value_arguments',
    );
  if (!argList) {
    const callSuffix = callNode.children.find((c: SyntaxNode) => c.type === 'call_suffix');
    if (callSuffix) {
      argList = callSuffix.children.find((c: SyntaxNode) => c.type === 'value_arguments');
    }
  }
  if (!argList) return undefined;

  const argTypes: (string | undefined)[] = [];
  for (const arg of argList.namedChildren) {
    if (arg.type === 'comment') continue;
    const valueNode =
      arg.childForFieldName?.('value') ??
      arg.childForFieldName?.('expression') ??
      (arg.type === 'argument' || arg.type === 'value_argument'
        ? (arg.firstNamedChild ?? arg)
        : arg);
    let inferred = inferLiteralType(valueNode);
    if (!inferred && typeEnvLookup && valueNode.type === 'identifier') {
      inferred = typeEnvLookup(valueNode.text, callNode);
    }
    argTypes.push(inferred);
  }

  if (argTypes.every((t) => t === undefined)) return undefined;
  return argTypes;
};

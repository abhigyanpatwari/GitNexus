import type { SyntaxNode } from './ast-helpers.js';
import { CALL_ARGUMENT_LIST_TYPES } from './ast-helpers.js';

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

/** One step in a mixed receiver chain. */
export type MixedChainStep = { kind: 'field' | 'call'; name: string };

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
      return { chain, baseReceiverName: innerReceiver.text || undefined };
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
export function extractMixedChain(
  receiverNode: SyntaxNode,
): { chain: MixedChainStep[]; baseReceiverName: string | undefined } | undefined {
  const chain: MixedChainStep[] = [];
  let current: SyntaxNode = receiverNode;

  while (chain.length < MAX_CHAIN_DEPTH) {
    if (CALL_EXPRESSION_TYPES.has(current.type)) {
      // ── Call expression: extract method name + inner receiver ────────────
      const funcNode =
        current.childForFieldName?.('function') ??
        current.childForFieldName?.('name') ??
        current.childForFieldName?.('method');
      let methodName: string | undefined;
      let innerReceiver: SyntaxNode | null = null;

      if (funcNode) {
        methodName = funcNode.lastNamedChild?.text ?? funcNode.text;
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
          null;
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

      if (
        CALL_EXPRESSION_TYPES.has(innerReceiver.type) ||
        FIELD_ACCESS_NODE_TYPES.has(innerReceiver.type)
      ) {
        current = innerReceiver;
      } else {
        return { chain, baseReceiverName: innerReceiver.text || undefined };
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

      if (
        CALL_EXPRESSION_TYPES.has(innerObject.type) ||
        FIELD_ACCESS_NODE_TYPES.has(innerObject.type)
      ) {
        current = innerObject;
      } else {
        return { chain, baseReceiverName: innerObject.text || undefined };
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

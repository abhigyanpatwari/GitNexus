/**
 * Which constructor type bindings (`x <- T$new()`) may type a receiver: only those whose name the
 * frame binds to nothing but that constructor.
 *
 * The scope query emits one `@type-binding.constructor` per `x <- T$new()`, `x = T$new()` and
 * `x <<- T$new()`, and the shared extractor keeps one type per name per scope, the later binding
 * winning. On its own that types `x` as `T` however else the frame binds `x`: a second class, an
 * untyped value, a loop variable, a formal, `rm(x)`. R calls the method of whatever `x` holds at
 * the call, which the order of bindings alone does not decide (branches, loops, closures). So a
 * constructor types `x` only when every binding of `x` in its frame agrees with it, and otherwise
 * the receiver is left untyped: an unresolved call, never an edge to another class's method.
 *
 * A frame is the file's top level (`program`) or a `function_definition`. The braces of
 * `local({...})` and of every other call belong to the enclosing frame. Frames are per file: a
 * package namespace spans files, so a rebinding in another file is not seen.
 *
 * Each binding of a name gives one signature in its frame:
 *  - `ctor:T` for `x <- T$new()`, `x = T$new()`, `x <<- T$new()` and the right-assignment forms
 *    (`T$new() -> x` binds no type, but it still counts), with `T` read as the query reads it;
 *  - neutral for `NULL` and a constant (`x$m()` on one always errors, so it never names another
 *    class for a call that runs) and for a write through `x` that leaves it by `$`, `@`, `[[` or
 *    `[` (`x$a <- v`, `x[[i]] <- v`, `names(x$a) <- v`): an R6 instance is a reference, so the
 *    write keeps it the same object, as for `self`;
 *  - `other` for anything else: another value, a formal, a `for` variable, `rm(x)` or
 *    `remove(x)` (a name, a string, or `list = "x"`), `assign("x", ...)` and
 *    `delayedAssign("x", ...)` with a literal name, and a replacement call applied to `x` itself
 *    (`class(x) <- v` binds `x` to what the setter returns).
 *
 * `<<-` and `->>` never bind in their own frame: they record their signature into every strictly
 * enclosing frame up to the top level (at the top level, into the top level). So in
 * `function() { x <<- User$new(); x$save() }` the name is free in the function and the call stays
 * untyped.
 *
 * `with()` and `within()` are not modelled, nor `assign()` with a computed name or another
 * environment (read as the current frame).
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { rBareName } from './bare-name.js';
import { isRConstantValue } from './assignment.js';

const OTHER = 'other';
const NEUTRAL = 'neutral';

/** `T$new()` (any extract operator, as the type-binding query reads it): `ctor:T`, else null. */
function constructorSignature(value: SyntaxNode): string | null {
  if (value.type !== 'call') return null;
  const fn = value.childForFieldName('function');
  if (fn?.type !== 'extract_operator') return null;
  const lhs = fn.childForFieldName('lhs');
  const rhs = fn.childForFieldName('rhs');
  if (lhs?.type !== 'identifier' || rhs?.type !== 'identifier' || rhs.text !== 'new') return null;
  return 'ctor:' + rBareName(lhs.text);
}

/** The signature an assigned value gives its name. */
function valueSignature(value: SyntaxNode | null): string {
  if (value === null) return OTHER;
  if (value.type === 'null' || isRConstantValue(value)) return NEUTRAL;
  return constructorSignature(value) ?? OTHER;
}

/** The first argument value of a call (`x` of `class(x)`), or null. */
function firstArgumentValue(call: SyntaxNode): SyntaxNode | null {
  const args = call.childForFieldName('arguments');
  if (args === null) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type === 'argument') return arg.childForFieldName('value');
  }
  return null;
}

/**
 * The base identifier a complex assignment target writes through, and whether the step that
 * leaves it is a replacement call (`class(x)`: `x` is rebound to what the setter returns) rather
 * than a field step (`x$a`, `x@a`, `x[[i]]`, `x[i]`, also under a call: `names(x$a)`).
 */
function complexTargetBase(target: SyntaxNode): { base: SyntaxNode; viaCall: boolean } | null {
  let viaCall = false;
  for (let node: SyntaxNode | null = target; node !== null; ) {
    switch (node.type) {
      case 'identifier':
        return { base: node, viaCall };
      case 'extract_operator':
        viaCall = false;
        node = node.childForFieldName('lhs');
        break;
      case 'subset':
      case 'subset2':
        viaCall = false;
        node = node.childForFieldName('function');
        break;
      case 'call':
        viaCall = true;
        node = firstArgumentValue(node);
        break;
      default:
        return null;
    }
  }
  return null;
}

/** The name a string literal spells (its content as written), or null. */
function stringName(node: SyntaxNode): string | null {
  if (node.type !== 'string') return null;
  return node.childForFieldName('content')?.text ?? null;
}

/** The names `rm()`/`remove()` unbind, and the one `assign()`/`delayedAssign()` binds. */
function unboundOrAssignedNames(call: SyntaxNode): string[] {
  const fn = call.childForFieldName('function');
  if (fn?.type !== 'identifier') return [];
  const callee = fn.text;
  const isRemove = callee === 'rm' || callee === 'remove';
  if (!isRemove && callee !== 'assign' && callee !== 'delayedAssign') return [];
  const args = call.childForFieldName('arguments');
  if (args === null) return [];
  const names: string[] = [];
  let firstUnnamed: SyntaxNode | null = null;
  let namedX: SyntaxNode | null = null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'argument') continue;
    const value = arg.childForFieldName('value');
    if (value === null) continue;
    const argName = arg.childForFieldName('name')?.text;
    if (isRemove) {
      if (argName === undefined) {
        const name = value.type === 'identifier' ? rBareName(value.text) : stringName(value);
        if (name !== null) names.push(name);
      } else if (argName === 'list') {
        const name = stringName(value);
        if (name !== null) names.push(name);
      }
    } else if (argName === 'x') {
      namedX = value;
    } else if (argName === undefined && firstUnnamed === null) {
      firstUnnamed = value;
    }
  }
  const literal = namedX ?? firstUnnamed;
  if (!isRemove && literal !== null) {
    const name = stringName(literal);
    if (name !== null) names.push(name);
  }
  return names;
}

interface Anchor {
  readonly id: number;
  readonly name: string;
  readonly signature: string;
  readonly frame: number;
  /** For `<<-`: the frames it records into, which must agree too. */
  readonly enclosing: readonly number[];
}

/**
 * The ids of the `@type-binding.constructor` anchors (the assignment nodes) whose type binding
 * is kept: every non-neutral binding of the name in the anchor's frame is the same constructor
 * (and, for `<<-`, in every frame it assigns into). One top-down pass with an explicit stack;
 * no `.parent` call, so the work is linear in the size of the tree.
 */
export function rAgreedConstructorAnchors(root: SyntaxNode): Set<number> {
  /** frame id -> name -> signatures. */
  const signatures = new Map<number, Map<string, Set<string>>>();
  /** frame id -> enclosing frame id (absent for the top level). */
  const enclosingFrame = new Map<number, number>();
  const record = (frame: number, name: string, signature: string): void => {
    let names = signatures.get(frame);
    if (names === undefined) signatures.set(frame, (names = new Map()));
    let set = names.get(name);
    if (set === undefined) names.set(name, (set = new Set()));
    set.add(signature);
  };
  /** The frames `<<-` assigns into from `frame`: every strictly enclosing one, or the top level. */
  const outwardFrames = (frame: number): number[] => {
    const frames: number[] = [];
    for (let f = enclosingFrame.get(frame); f !== undefined; f = enclosingFrame.get(f)) {
      frames.push(f);
    }
    return frames.length > 0 ? frames : [frame];
  };
  const anchors: Anchor[] = [];

  const stack: { node: SyntaxNode; frame: number }[] = [{ node: root, frame: root.id }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node } = item;
    let frame = item.frame;
    if (node.type === 'function_definition') {
      enclosingFrame.set(node.id, frame);
      frame = node.id;
      const parameters = node.childForFieldName('parameters');
      for (let i = 0; parameters !== null && i < parameters.namedChildCount; i++) {
        const parameter = parameters.namedChild(i);
        if (parameter?.type !== 'parameter') continue;
        const name = parameter.childForFieldName('name');
        if (name?.type === 'identifier') record(frame, rBareName(name.text), OTHER);
      }
    } else if (node.type === 'for_statement') {
      const variable = node.childForFieldName('variable');
      if (variable?.type === 'identifier') record(frame, rBareName(variable.text), OTHER);
    } else if (node.type === 'binary_operator') {
      const operator = node.childForFieldName('operator')?.text;
      let target: SyntaxNode | null = null;
      let value: SyntaxNode | null = null;
      if (operator === '<-' || operator === '=' || operator === '<<-') {
        target = node.childForFieldName('lhs');
        value = node.childForFieldName('rhs');
      } else if (operator === '->' || operator === '->>') {
        target = node.childForFieldName('rhs');
        value = node.childForFieldName('lhs');
      }
      if (target !== null) {
        const outward = operator === '<<-' || operator === '->>';
        const into = outward ? outwardFrames(frame) : [frame];
        if (target.type === 'identifier') {
          const name = rBareName(target.text);
          const signature = valueSignature(value);
          for (const f of into) record(f, name, signature);
          // The query emits a constructor binding for the left-assignment forms only.
          if (operator !== '->' && operator !== '->>' && signature.startsWith('ctor:')) {
            anchors.push({ id: node.id, name, signature, frame, enclosing: outward ? into : [] });
          }
        } else {
          const written = complexTargetBase(target);
          if (written?.viaCall === true) {
            for (const f of into) record(f, rBareName(written.base.text), OTHER);
          }
        }
      }
    } else if (node.type === 'call') {
      for (const name of unboundOrAssignedNames(node)) record(frame, name, OTHER);
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child !== null) stack.push({ node: child, frame });
    }
  }

  /** The non-neutral signatures of `name` in `frame`. */
  const real = (frame: number, name: string): string[] => {
    const set = signatures.get(frame)?.get(name);
    return set === undefined ? [] : [...set].filter((signature) => signature !== NEUTRAL);
  };
  const kept = new Set<number>();
  for (const anchor of anchors) {
    const own = real(anchor.frame, anchor.name);
    if (own.length !== 1 || own[0] !== anchor.signature) continue;
    if (anchor.enclosing.some((f) => real(f, anchor.name).some((s) => s !== anchor.signature))) {
      continue;
    }
    kept.add(anchor.id);
  }
  return kept;
}

/**
 * A predicate over `@type-binding.constructor` anchor nodes, built on its first use: the tree is
 * walked once per file, and only for a file that has a constructor binding at all.
 */
export function rConstructorAnchorTest(root: SyntaxNode): (anchor: SyntaxNode) => boolean {
  let kept: Set<number> | undefined;
  return (anchor) => (kept ??= rAgreedConstructorAnchors(root)).has(anchor.id);
}

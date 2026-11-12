import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { recordRubyMemberDispatch } from './member-dispatch.js';
import {
  findChild,
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getRubyParser, getRubyScopeQuery } from './query.js';
import { recordRubyCacheHit, recordRubyCacheMiss } from './cache-stats.js';
import { synthesizeRubyReceiverBinding, findEnclosingClassOrModule } from './receiver-binding.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { splitQualifiedName } from '../../utils/qualified-name.js';
import { encodeMarker } from '../../utils/heritage-marker.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';
import { synthesizeReceiverChainCapture } from '../../utils/receiver-chain-captures.js';

const FUNCTION_NODE_TYPES = ['method', 'singleton_method'] as const;
const HERITAGE_CALL_NAMES: ReadonlySet<string> = new Set(['include', 'extend', 'prepend']);
const ATTR_CALL_NAMES: ReadonlySet<string> = new Set([
  'attr_accessor',
  'attr_reader',
  'attr_writer',
]);

const RUBY_CALLABLE_CAPTURE_OPTIONS = {
  functionNodeTypes: new Set(['method', 'singleton_method', 'lambda']),
  callNodeTypes: new Set(['call']),
  parameterListNodeTypes: new Set(['method_parameters', 'argument_list']),
  parameterNodeTypes: new Set([
    'identifier',
    'optional_parameter',
    'splat_parameter',
    'hash_splat_parameter',
    'block_parameter',
  ]),
  bindingNodeTypes: new Set(['assignment']),
  assignmentNodeTypes: new Set(['assignment', 'operator_assignment']),
  identifierNodeTypes: new Set([
    'identifier',
    'constant',
    'instance_variable',
    'class_variable',
    'global_variable',
  ]),
  functionScopedValueBindings: true,
  callableProtocolMethods: new Set(['call']),
  // A bare receiver-less identifier in value position is a method CALL in
  // Ruby (`action = process` stores process's RETURN value) — only explicit
  // reference forms (method(:x), &:x, lambda/proc) reference the callable.
  bareNamesAreCalls: true,
  valueAlternatives: (node: SyntaxNode) => rubyValueAlternatives(node),
  extractCallableReference: (node: SyntaxNode) => {
    if (node.type !== 'call') return undefined;
    const method = node.childForFieldName('method');
    if (method?.text !== 'method' && method?.text !== 'public_method') return undefined;
    const args = node.childForFieldName('arguments');
    const symbol = args?.namedChildren.find(
      (child): child is SyntaxNode => child !== null && child.type === 'simple_symbol',
    );
    if (symbol === undefined) return undefined;
    const name = symbol.text.replace(/^:/, '');
    return name.length === 0 ? undefined : { name, anchor: symbol };
  },
} as const;

/**
 * Branches of a statement-bodied `if` / `unless` / `elsif` (#3354). They field
 * `condition` / `consequence` / `alternative` like a ternary, but their
 * branches are `then` / `else` STATEMENT LISTS, so the shared ternary rule
 * would dig an identifier out of whichever statement it found (`g = h; 0`
 * flowed `h`, although the branch evaluates to `0`). A branch holding one
 * statement is that statement's value. A longer branch is skipped: it adds
 * no alternative, while the other branches still flow. Every alternative
 * emitted is a value the conditional really evaluates to, so skipping cannot
 * add an edge. It only drops the skipped branch's own value. The `elsif`
 * chain is walked here, so one multi-statement `elsif` no longer hides the
 * branches after it. When no branch is a single statement, the whole
 * conditional stays one opaque source. The `c ? a : b` ternary
 * (`conditional`) is left to the shared rule.
 */
function rubyValueAlternatives(node: SyntaxNode): readonly SyntaxNode[] | undefined {
  if (node.type !== 'if' && node.type !== 'unless' && node.type !== 'elsif') return undefined;
  const branches: SyntaxNode[] = [];
  for (let link: SyntaxNode | null = node; link !== null; ) {
    const consequence: SyntaxNode | null = link.childForFieldName('consequence');
    const alternative: SyntaxNode | null = link.childForFieldName('alternative');
    link = alternative?.type === 'elsif' ? alternative : null;
    for (const branch of [consequence, link === null ? alternative : null]) {
      if (branch === null) continue;
      const statements = branch.namedChildren.filter(
        (child): child is SyntaxNode => child !== null && child.type !== 'comment',
      );
      const [statement] = statements;
      if (statements.length === 1 && statement !== undefined) branches.push(statement);
    }
  }
  return branches.length > 0 ? branches : [node];
}

/**
 * Build the full `.`-joined qualified owner name for a heritage/attr call by
 * walking ALL enclosing class/module ancestors (not just the immediate one),
 * so a same-tail nested owner (`module Outer; class Inner`) is keyed by its
 * full path `Outer.Inner` instead of the bare tail `Inner` — which otherwise
 * collapses both same-tail owners onto one `__heritage__`/`__property__` marker
 * key (last-wins) and cross-wires their mixin / attr_accessor edges (#1982).
 * Handles the compact `class Outer::Inner` form (name is a `scope_resolution`)
 * via the shared normalizer, so the marker owner byte-matches the resolution
 * def's `qualifiedName`. Returns undefined when there is no enclosing class/module.
 */
function buildEnclosingQualifiedName(callNode: SyntaxNode): string | undefined {
  const segments: string[] = [];
  let current: SyntaxNode | null = callNode.parent;
  while (current !== null) {
    if (current.type === 'class' || current.type === 'module') {
      const nameNode = current.childForFieldName('name');
      if (nameNode !== null) segments.unshift(...splitQualifiedName(nameNode.text));
    }
    // Stop at the file root — nothing above `program` contributes a Ruby
    // class/module scope segment (#1982 perf; avoids walking to the very top
    // for every heritage/attr call).
    if (current.type === 'program') break;
    current = current.parent;
  }
  return segments.length > 0 ? segments.join('.') : undefined;
}

/**
 * Does this `@ivar` write land on an INSTANCE of the enclosing LEXICAL class?
 *
 * In Ruby an instance variable belongs to whatever `self` is at the point of
 * the write, so this is really a question about `self`, and `self` is an
 * instance of the enclosing lexical class only inside an ordinary `def` whose
 * own definition site is that class's body. Every other arrangement writes an
 * ivar some instance of this class will never see:
 *
 *   class C
 *     @shared = Outer.new        # class body:       self == C
 *     def self.build             # singleton_method: self == C
 *       @pool = Outer.new
 *     end
 *     class << self              # singleton_class:  self == C
 *       def warm; @cache = Outer.new; end
 *     end
 *     Other.class_eval do        # block receiver:   self == Other
 *       def warm; @far = Outer.new; end
 *     end
 *     other.instance_eval { @alien = Outer.new }   # self == other
 *     def run; @pool.inner; end  # reads nil — @pool was never set on an instance
 *   end
 *
 * So the walk stops on the FIRST ancestor that decides who `self` is, and
 * answers true only for an ordinary `method` reached without crossing any
 * boundary that could have moved `self` elsewhere. `method` alone is NOT
 * sufficient — a `def` nested in a `class << self` body, or in a `class_eval`
 * block, is reached through a `method` node first — hence the flag rather than
 * an early return (#2807).
 *
 * ── WHY BLOCKS ARE A HARD STOP, WITHOUT LOOKING AT THE CALL THEY BELONG TO ──
 *
 * A block is the one construct whose `self` (and whose "default definee", the
 * class a `def` inside it attaches to) is chosen by its RECEIVER, not by its
 * syntax. `Foo.class_eval do … end`, `Class.new do … end`, `Struct.new(:x) do …
 * end`, `Data.define(:x) do … end`, `Module.new`, `refine`, `define_method`,
 * `instance_eval`, `instance_exec`, `module_eval` and `class_exec` all rebind
 * it; `[1].each do … end` does not.
 *
 * Telling those apart would need an enumeration of every method that rebinds a
 * block's `self`, and that set is OPEN: any user-defined method can do it to a
 * block it merely receives —
 *
 *   def helper(&blk) = Foo.class_eval(&blk)
 *   helper { def warm; @far = Outer.new; end }   # attaches to Foo, not here
 *
 * — so no allow-list of "safe" call names is sound, and a deny-list of known
 * rebinders is exactly the incomplete enumeration that produced this bug. The
 * only complete answer available from the block's own syntax is that ownership
 * is unprovable, so every block boundary is a stop. That over-discards a plain
 * `each`/`tap` block, whose `self` really is the instance; per the safety
 * doctrine (see `scope-resolution/passes/compound-receiver.ts`) a missed edge is
 * the acceptable cost and a fabricated edge on the wrong class is not.
 *
 * A `class` / `module` keyword nested INSIDE a block still terminates the walk
 * with a true answer, and correctly so: that keyword sets the definee lexically
 * no matter what surrounds it, so `Class.new do class Inner; def m; @a = …`
 * writes a real `Inner` instance field.
 *
 * ── FORMS THAT CANNOT REACH HERE AT ALL ────────────────────────────────────
 *
 * `obj.instance_variable_set(:@a, Outer.new)` is a `call`, not an `assignment`,
 * and `Foo.class_eval "def warm; @a = Outer.new; end"` hides its body in a
 * `string` node. Neither parses into the `(assignment left: (instance_variable)
 * …)` pattern in query.ts, so neither ever produces the marker this gate reads.
 *
 * Deliberately conservative. A write this returns false for simply binds no
 * type at all, which costs at most a missed edge; returning true too eagerly
 * invents a call from a receiver that is always nil.
 */
function isRubyInstanceIvarWrite(ivarNode: SyntaxNode | undefined): boolean {
  if (ivarNode === undefined) return false;
  let insideMethodBody = false;
  for (let ancestor = ivarNode.parent; ancestor !== null; ancestor = ancestor.parent) {
    switch (ancestor.type) {
      // `def self.x` / `def obj.x`, and `class << self` / `class << obj`.
      case 'singleton_method':
      case 'singleton_class':
        return false;
      // Every block body: `do … end` and `{ … }` are the only two the grammar
      // produces. `lambda` (`->`) always wraps its body in one of them, so it
      // can never be the first boundary today — it is listed because the
      // boundary IS the lambda, and a grammar change must not silently
      // un-guard it.
      case 'do_block':
      case 'block':
      case 'lambda':
        return false;
      // `BEGIN { … }` / `END { … }` are program-level bodies whose execution is
      // relocated out of the enclosing method (before the program, and at exit);
      // Ruby warns when they appear in a method body at all. Rather than assert
      // whose `self` runs them, the doctrine applies: unprovable, so discard.
      // Reachable — tree-sitter parses `END { @a = Outer.new }` inside a `def`
      // as an `end_block` under that method's body.
      case 'begin_block':
      case 'end_block':
        return false;
      case 'method':
        insideMethodBody = true;
        break;
      // The owning body. Reaching it without crossing any of the boundaries
      // above means the write is an instance write exactly when a `def` body
      // enclosed it.
      case 'class':
      case 'module':
      case 'program':
        return insideMethodBody;
      // Everything else is control flow that cannot move `self`: `if`/`unless`
      // (`then`), `case`/`when`, `while`, `for`/`do`, `begin`/`rescue`/`ensure`.
      default:
        break;
    }
  }
  return false;
}

/** Whether an ordinary `def` has a provable lexical class/module definee. */
function isRubyLexicalMethod(node: SyntaxNode): boolean {
  if (node.type !== 'method') return false;
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    switch (ancestor.type) {
      // Singleton bodies choose a different definee. A block's receiver can
      // also rebind it, including through user helpers (see the ivar gate).
      case 'singleton_method':
      case 'singleton_class':
      case 'do_block':
      case 'block':
      case 'lambda':
      case 'begin_block':
      case 'end_block':
        return false;
      case 'class':
      case 'module':
      case 'program':
        return true;
    }
  }
  return false;
}

// ─── Bare identifier reads (RUBY-04) ──────────────────────────────────────
//
// `(body_statement (identifier)) @reference.call.free` captures a receiver-
// less, paren-less name that is a statement of its own as a zero-arity call.
// Ruby decides that question LEXICALLY: the name is a variable read when a
// formal parameter, a block parameter or an assignment seen earlier in the
// enclosing scope has bound it, and a method call otherwise (`target()`,
// `self.target` and `target arg` call the method regardless). Emitting the
// call for a bound name produced `run → Host#target` for
// `def target; end; def run(target); target; end` — a wrong edge, not a
// missing one — so the capture is dropped when the name is bound.
//
// Scopes, from tree-sitter-ruby: a `method` / `singleton_method` body sees
// its own parameters and nothing outside itself; a `block` / `do_block` /
// `lambda` body sees its own parameters (and `|x; y|` block locals) plus
// every enclosing scope's names; `class` / `module` / `singleton_class` /
// `program` bodies hold their own locals and close the walk. Every binding
// is POSITIONAL: it counts only when it starts before the read. Ruby registers
// a local when the parser passes its assignment (`target; target = 1` still
// calls) and a parameter when it passes the parameter's NAME, left to right —
// so a default expression sees the parameters declared before it and the
// parameter it belongs to (`def run(target = … target …)` reads the nil local,
// a circular reference), but not a later one (`def run(x = … target …,
// target: nil)` calls the method). A nested scope's bindings never leak out
// (a block's `|target|` or its `target = a` is invisible after the block, so
// a bare `target` there is a call again). A header expression Ruby evaluates
// in the ENCLOSING scope — a singleton method's receiver (`def (target =
// x).run`), a class's or module's name expression (`class (target =
// Object)::Inner`), a class's superclass, a `class << value` value — binds in
// that enclosing scope, not in the body, and a read inside such a header is
// answered by the enclosing scope. A `BEGIN { … }` / `END { … }` body shares
// the locals of the scope around it, so it is neither a scope nor a boundary.
// A pattern's expression parts (a string / regex / symbol / subshell
// `interpolation`, a `lambda` pattern's parameters, a `^pin`) are not binding
// positions, and neither is a hash argument that tree-sitter-ruby parses as a
// pattern match (`put !x => target`).
//
// One place where source order is not parse order: Ruby lexes a heredoc body
// when it reaches the body's `<<~EOS` token, before the rest of that line. A
// read inside a body is therefore compared as if it sat at its opener: what
// was bound before the token (a parameter, an earlier local, an earlier part
// of the line, an earlier body of the same line) makes it a read, while an
// assignment later on the opener line has not happened yet — in
// `other(<<~EOS, target = 1)` a read inside the body is a call.
//
// Each scope's bindings are indexed once per file at their earliest parse
// position and cached by scope node id. Files with heredocs also get a parse-
// order index: their bodies belong at the opener, including when the opener's
// method or block closes before the physical body. Both binding collection
// and the read's ancestor walk follow that same connection.

/**
 * Scopes whose body sees nothing bound outside them. `begin_block` /
 * `end_block` (`BEGIN { … }` / `END { … }`) are deliberately absent, and are
 * not open scopes either: they share the locals of the scope around them
 * (Ruby's own example shares one local across `BEGIN`, `END` and the
 * program), so an assignment inside one binds the enclosing scope and a read
 * inside one sees it. (The ivar walker's `self` boundary is a different
 * question.)
 */
const RUBY_CLOSED_LOCAL_SCOPES: ReadonlySet<string> = new Set([
  'method',
  'singleton_method',
  'class',
  'module',
  'singleton_class',
  'program',
]);

/**
 * Header fields of a scope node that Ruby evaluates in the ENCLOSING scope:
 * a `singleton_method`'s receiver (`object`), a `class`'s `name` and
 * `superclass`, a `module`'s `name`, a `singleton_class`'s `value`. Their
 * bindings belong to the scope that contains the header, never to the body.
 * A plain constant name binds nothing; only an expression such as
 * `class (target = Object)::Inner` does.
 */
const RUBY_SCOPE_HEADER_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['singleton_method', ['object']],
  ['class', ['name', 'superclass']],
  ['module', ['name']],
  ['singleton_class', ['value']],
]);

/** The header-field children of `node`, when it is a scope kind that has them. */
function rubyScopeHeaderNodes(node: SyntaxNode): SyntaxNode[] {
  const fields = RUBY_SCOPE_HEADER_FIELDS.get(node.type);
  if (fields === undefined) return [];
  const out: SyntaxNode[] = [];
  for (const field of fields) {
    const child = node.childForFieldName(field);
    if (child !== null) out.push(child);
  }
  return out;
}

/** Scopes whose body also sees every enclosing scope's bindings. */
const RUBY_OPEN_LOCAL_SCOPES: ReadonlySet<string> = new Set(['block', 'do_block', 'lambda']);

/**
 * Nodes that bind a local name at a position seen before the rest of the
 * scope, with the field holding the binding target: `assignment` /
 * `operator_assignment` `left` (`target = …`, `a, target = …`, `target ||= …`),
 * `for` `pattern`, `rescue` `variable` (`rescue => target`), and the patterns
 * of `case … in`, `expr => pattern` and `expr in pattern`.
 */
const RUBY_LOCAL_BINDING_SITES: ReadonlyMap<string, string> = new Map([
  ['assignment', 'left'],
  ['operator_assignment', 'left'],
  ['for', 'pattern'],
  ['rescue', 'variable'],
  ['in_clause', 'pattern'],
  ['match_pattern', 'pattern'],
  ['test_pattern', 'pattern'],
]);

/** Containers an assignment / `for` / `rescue` target passes through to the names it binds. */
const RUBY_LHS_CONTAINERS: ReadonlySet<string> = new Set([
  'left_assignment_list',
  'destructured_left_assignment',
  'rest_assignment',
  'exception_variable',
]);

/** Name → earliest parse position at which one scope binds it. */
export type RubyScopeBindings = ReadonlyMap<string, number>;
type RubyBindingVisitor = (name: string, start: number) => void;

/**
 * Names a `method_parameters` / `block_parameters` / `lambda_parameters` node
 * declares, each at its NAME node's offset. Optional, keyword, splat,
 * hash-splat and block parameters carry the name in a `name` field; a
 * destructured parameter `(a, b)` nests plain identifiers; block locals
 * (`|x; target|`) are plain identifiers too. A default VALUE is an
 * expression, not a declared name.
 */
function collectRubyParameterNames(paramsNode: SyntaxNode | null, visit: RubyBindingVisitor): void {
  if (paramsNode === null) return;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const child = paramsNode.namedChild(i);
    if (child === null) continue;
    if (child.type === 'identifier') {
      visit(child.text, child.startIndex);
    } else if (child.type === 'destructured_parameter') {
      collectRubyParameterNames(child, visit);
    } else {
      const name = child.childForFieldName('name');
      if (name !== null && name.type === 'identifier') visit(name.text, name.startIndex);
    }
  }
}

/**
 * Names an assignment-like target binds itself (not a receiver it writes
 * into), each at ITS OWN offset: in `a[… target …], target = …` the first
 * target's subscript is parsed before the second target declares the name,
 * so a bare read there is still a call.
 */
function collectRubyLhsNames(target: SyntaxNode, visit: RubyBindingVisitor): void {
  if (target.type === 'identifier') {
    visit(target.text, target.startIndex);
    return;
  }
  if (!RUBY_LHS_CONTAINERS.has(target.type)) return;
  for (let i = 0; i < target.namedChildCount; i++) {
    const child = target.namedChild(i);
    if (child !== null) collectRubyLhsNames(child, visit);
  }
}

/**
 * Pattern nodes whose named children are themselves patterns (tree-sitter-
 * ruby `_pattern_top_expr_body` / `_pattern_expr` / `_pattern_expr_basic`).
 * Everything else a pattern position can hold is a VALUE, not a binding
 * position: literals, `string` / `regex` / `delimited_symbol` / `subshell` /
 * heredoc bodies (whose `interpolation` holds expressions), a `lambda` (its
 * parameters are its own), a `^target` / `^(expr)` pin, a `constant` /
 * `scope_resolution` (also the `class` field of an array / find / hash
 * pattern), and ranges. `keyword_pattern`, `as_pattern`, `splat_parameter`
 * and `hash_splat_parameter` are handled by name below.
 */
const RUBY_PATTERN_CONTAINERS: ReadonlySet<string> = new Set([
  'array_pattern',
  'find_pattern',
  'hash_pattern',
  'alternative_pattern',
  'parenthesized_pattern',
]);

/**
 * Names a `case … in` / `=>` / `in` pattern binds, each where it is written.
 * Only true binding positions count (`RUBY_PATTERN_CONTAINERS`); an
 * expression nested in a pattern — `"x#{target}"`, `/#{target}/`,
 * `->(target) { }`, `^(target)` — reads or declares nothing in the enclosing
 * scope.
 */
function collectRubyPatternNames(pattern: SyntaxNode, visit: RubyBindingVisitor): void {
  switch (pattern.type) {
    case 'identifier':
      visit(pattern.text, pattern.startIndex);
      return;
    case 'keyword_pattern': {
      const value = pattern.childForFieldName('value');
      if (value !== null) {
        collectRubyPatternNames(value, visit);
        return;
      }
      // `{target:}` — a key with no value binds a local of the key's name.
      // The quoted form `{"target":}` binds the string's content; a key with
      // interpolation is a SyntaxError in a pattern and binds nothing here.
      const key = pattern.childForFieldName('key');
      if (key === null) return;
      if (key.type === 'string') {
        const content = key.namedChildCount === 1 ? key.namedChild(0) : null;
        if (content !== null && content.type === 'string_content') {
          visit(content.text, key.startIndex);
        }
        return;
      }
      visit(key.text.replace(/:$/, ''), key.startIndex);
      return;
    }
    case 'as_pattern': {
      const bound = pattern.childForFieldName('name');
      if (bound !== null) visit(bound.text, bound.startIndex);
      const value = pattern.childForFieldName('value');
      if (value !== null) collectRubyPatternNames(value, visit);
      return;
    }
    case 'splat_parameter':
    case 'hash_splat_parameter': {
      const bound = pattern.childForFieldName('name');
      if (bound !== null) visit(bound.text, bound.startIndex);
      return;
    }
    default: {
      // Only a pattern CONTAINER is entered; a value (literal, string with
      // interpolation, regex, lambda, pin, constant, range) binds nothing.
      if (!RUBY_PATTERN_CONTAINERS.has(pattern.type)) return;
      for (let i = 0; i < pattern.namedChildCount; i++) {
        const child = pattern.namedChild(i);
        if (child !== null) collectRubyPatternNames(child, visit);
      }
    }
  }
}

/** Containers whose elements are arguments, where Ruby reads `key => value` as a hash pair. */
const RUBY_ARGUMENT_CONTAINERS: ReadonlySet<string> = new Set([
  'argument_list',
  'array',
  'element_reference',
]);

/**
 * Whether a `match_pattern` / `test_pattern` node is tree-sitter-ruby's
 * reading of a hash argument. The grammar parses `s.put !x => target` as
 * `argument_list (unary operand: (match_pattern …))` with no ERROR node (also
 * `put :a, -x => target`, `[!x => target]`, `s[!x => target]`), while Ruby
 * reads the hash `{ !x => target }`, which binds nothing. A rightward pattern
 * match is a statement, so climbing through the `unary` wrappers and landing
 * in an argument container means it is an association; the statement
 * `!x => target` (its `unary` sits in a statement list) still binds.
 */
function rubyPatternMatchIsHashArgument(node: SyntaxNode): boolean {
  let container = node.parent;
  while (container !== null && container.type === 'unary') container = container.parent;
  return container !== null && RUBY_ARGUMENT_CONTAINERS.has(container.type);
}

/**
 * Names bound at the binding site of a `RUBY_LOCAL_BINDING_SITES` node, each
 * at the offset where it is WRITTEN. That is the one rule Ruby's parser
 * follows: a local exists from the point its name appears in a binding
 * position, so anything parsed before that point — an earlier target's
 * subscript, the value of a rightward `=>` / `in` pattern — still calls.
 */
function collectRubyBindingSiteNames(node: SyntaxNode, visit: RubyBindingVisitor): void {
  const field = RUBY_LOCAL_BINDING_SITES.get(node.type);
  if (field === undefined) return;
  const site = node.childForFieldName(field);
  if (site === null) return;
  switch (node.type) {
    case 'assignment':
    case 'operator_assignment':
    case 'for':
    case 'rescue':
      collectRubyLhsNames(site, visit);
      return;
    case 'match_pattern':
    case 'test_pattern':
      if (rubyPatternMatchIsHashArgument(node)) return;
      // A rightward `value => pattern` / `value in pattern` parses the VALUE
      // before the pattern declares anything, so a bare read inside the value
      // (`[1].each do |a| target end => target`) is still a call.
      collectRubyPatternNames(site, visit);
      return;
    case 'in_clause':
      collectRubyPatternNames(site, visit);
      return;
    default:
      return;
  }
}

/**
 * Visits every binding one scope declares — its own parameters plus every
 * binding site inside it that is not inside a nested scope (whose locals do
 * not leak), plus the header expressions of nested scopes (evaluated here,
 * not in them), minus this scope's own header expressions (evaluated in ITS
 * enclosing scope) — each at the offset where the name is written.
 */
function forEachRubyScopeBinding(
  scope: SyntaxNode,
  visit: RubyBindingVisitor,
  heredocs: RubyHeredocLayout | null,
): void {
  collectRubyParameterNames(scope.childForFieldName('parameters'), visit);
  const ownHeaders = new Set(rubyScopeHeaderNodes(scope).map((n) => n.id));
  const pending: SyntaxNode[] = [];
  for (let i = 0; i < scope.namedChildCount; i++) {
    const child = scope.namedChild(i);
    if (child !== null && !ownHeaders.has(child.id)) pending.push(child);
  }
  while (pending.length > 0) {
    const node = pending.pop()!;
    // A physical body may be outside the scope that opened it. Only enter
    // it through its opener; otherwise its assignments leak into this scope.
    if (node.type === 'heredoc_body') continue;
    if (node.type === 'heredoc_beginning') {
      const body = heredocs?.bodies.get(node.id);
      if (body !== undefined) {
        for (const child of body.namedChildren) pending.push(child);
      }
      continue;
    }
    if (RUBY_CLOSED_LOCAL_SCOPES.has(node.type) || RUBY_OPEN_LOCAL_SCOPES.has(node.type)) {
      // A nested scope's bindings do not leak into this one — but its header
      // expressions run here.
      pending.push(...rubyScopeHeaderNodes(node));
      continue;
    }
    collectRubyBindingSiteNames(node, visit);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) pending.push(child);
    }
  }
}

/**
 * One scope's bindings keyed by name with the earliest parse position it binds
 * at. Built once per scope and cached for the file's capture pass.
 */
function rubyScopeBindings(
  scope: SyntaxNode,
  cache: Map<number, RubyScopeBindings>,
  heredocs: RubyHeredocLayout | null,
): RubyScopeBindings {
  const cached = cache.get(scope.id);
  if (cached !== undefined) return cached;
  const earliest = new Map<string, number>();
  forEachRubyScopeBinding(
    scope,
    (name, start) => {
      const position = heredocs === null ? start : heredocs.order.get(start);
      if (position === undefined) return;
      const prev = earliest.get(name);
      if (prev === undefined || position < prev) earliest.set(name, position);
    },
    heredocs,
  );
  cache.set(scope.id, earliest);
  return earliest;
}

/** A source span `[from, to)` of offsets. */
type RubySourceSpan = readonly [number, number];

/**
 * The rest of a heredoc body's opener line: from the end of the body's own
 * `heredoc_beginning` to the end of that line. Ruby lexes the body as soon
 * as it reaches that `<<~EOS` token, so a binding written in this span is
 * parsed AFTER every read inside the body, while one written before the
 * token, or in an earlier body of the same line, is parsed before it.
 *
 * tree-sitter-ruby does not link a body to its opener. The bodies opened on
 * one line are contiguous siblings in token order, and the first starts at
 * that line's end, so the body's index in that run picks its opener among
 * the line's `heredoc_beginning` nodes. When the counts disagree, return
 * `null`: guessing an opener could assign the body's locals to another scope.
 */
function rubyHeredocOpenerTail(body: SyntaxNode): RubySourceSpan | null {
  let first = body;
  let index = 0;
  let prev = first.previousNamedSibling;
  while (prev !== null && prev.type === 'heredoc_body' && prev.endIndex === first.startIndex) {
    first = prev;
    index++;
    prev = first.previousNamedSibling;
  }
  let count = index + 1;
  let last = body;
  let next = last.nextNamedSibling;
  while (next !== null && next.type === 'heredoc_body' && next.startIndex === last.endIndex) {
    count++;
    last = next;
    next = last.nextNamedSibling;
  }
  const row = first.startPosition.row;
  const openers = body.tree.rootNode
    .descendantsOfType('heredoc_beginning', { row, column: 0 }, first.startPosition)
    .filter((n) => n.startPosition.row === row && n.endIndex <= first.startIndex);
  const opener = openers.length === count ? openers[index] : undefined;
  return opener === undefined ? null : [opener.endIndex, first.startIndex];
}

interface RubyHeredocLayout {
  /** Opener id → physical body, and body id → lexical opener. */
  bodies: ReadonlyMap<number, SyntaxNode>;
  openers: ReadonlyMap<number, SyntaxNode>;
  /** Source offset → parse position, visiting a body at its opener. */
  order: ReadonlyMap<number, number>;
}

// Keyed by the capture pass's cache, so no tree survives that pass's lifetime.
const rubyHeredocLayouts = new WeakMap<Map<number, RubyScopeBindings>, RubyHeredocLayout | null>();

/**
 * Build the lexical connections and parse order once, only for files with
 * heredocs. An unmatched body is omitted: neither its reads nor its bindings
 * can prove a local read. Ordinary files continue to compare source offsets.
 */
function rubyHeredocLayout(
  root: SyntaxNode,
  cache: Map<number, RubyScopeBindings>,
): RubyHeredocLayout | null {
  const cached = rubyHeredocLayouts.get(cache);
  if (cached !== undefined) return cached;
  const physicalBodies = root.descendantsOfType('heredoc_body');
  if (physicalBodies.length === 0) {
    rubyHeredocLayouts.set(cache, null);
    return null;
  }
  const byEnd = new Map(root.descendantsOfType('heredoc_beginning').map((n) => [n.endIndex, n]));
  const bodies = new Map<number, SyntaxNode>();
  const openers = new Map<number, SyntaxNode>();
  for (const body of physicalBodies) {
    const tail = rubyHeredocOpenerTail(body);
    const opener = tail === null ? undefined : byEnd.get(tail[0]);
    if (opener !== undefined) {
      bodies.set(opener.id, body);
      openers.set(body.id, opener);
    }
  }
  const order = new Map<number, number>();
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'heredoc_body') continue;
    if (!order.has(node.startIndex)) order.set(node.startIndex, order.size);
    const children = (bodies.get(node.id) ?? node).namedChildren;
    for (const child of children.reverse()) pending.push(child);
  }
  const layout = { bodies, openers, order };
  rubyHeredocLayouts.set(cache, layout);
  return layout;
}

/**
 * Whether a bare `identifier` statement reads a parameter or local that is
 * bound before that point in an enclosing scope — in which case it is not a
 * method call and the `@reference.call.free` capture must not be emitted.
 * Exported for the unit test that pins the ordering rule on parsed trees,
 * including default-expression shapes the statement pattern never captures.
 */
export function rubyBareNameIsLocalRead(
  identifier: SyntaxNode,
  cache: Map<number, RubyScopeBindings>,
): boolean {
  const name = identifier.text;
  const heredocs = rubyHeredocLayout(identifier.tree.rootNode, cache);
  const readStart =
    heredocs === null ? identifier.startIndex : heredocs.order.get(identifier.startIndex);
  if (readStart === undefined) return false;
  let child: SyntaxNode = identifier;
  for (let scope = identifier.parent; scope !== null; child = scope, scope = scope.parent) {
    // The physical parent may be outside a method/block that closed on the
    // opener line. Continue through the opener's lexical ancestors instead.
    if (scope.type === 'heredoc_body') {
      const opener = heredocs?.openers.get(scope.id);
      if (opener === undefined) return false;
      scope = opener;
      continue;
    }
    const closed = RUBY_CLOSED_LOCAL_SCOPES.has(scope.type);
    if (!closed && !RUBY_OPEN_LOCAL_SCOPES.has(scope.type)) continue;
    // A read inside the scope's HEADER (a singleton receiver, a class or
    // module name, a superclass, a `class <<` value — reachable through a
    // `do` block or lambda body nested in it) is evaluated in the ENCLOSING
    // scope: this scope's parameters and locals are not visible there, and
    // its index (which excludes its own header) has nothing to say. Keep
    // climbing.
    if (closed && rubyScopeHeaderNodes(scope).some((header) => header.id === child.id)) continue;
    const boundAt = rubyScopeBindings(scope, cache, heredocs).get(name);
    if (boundAt !== undefined && boundAt < readStart) return true;
    if (closed) return false;
  }
  return false;
}

export function emitRubyScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getRubyParser>['parse']> | undefined;
  if (tree === undefined) {
    try {
      tree = parseSourceSafe(getRubyParser(), sourceText, undefined, {
        bufferSize: getTreeSitterBufferSize(sourceText),
      });
    } catch (err) {
      throw scopeExtractionError('parse', _filePath, err);
    }
    recordRubyCacheMiss();
  } else {
    recordRubyCacheHit();
  }

  let rawMatches: ReturnType<ReturnType<typeof getRubyScopeQuery>['matches']>;
  try {
    rawMatches = getRubyScopeQuery().matches(tree.rootNode);
  } catch (err) {
    throw scopeExtractionError('scope query', _filePath, err);
  }

  recordRubyMemberDispatch(tree.rootNode, _filePath);
  const out: CaptureMatch[] = [];
  // Per-scope binding index for the bare-identifier read check (RUBY-04),
  // built lazily and shared across every match of this file.
  const bareReadBindings = new Map<number, RubyScopeBindings>();
  const lexicalNamesByScope = new Map<number, readonly string[]>();

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    // Parallel tag -> captured SyntaxNode map. The query already hands us each
    // matched node as c.node, so anchors are used directly (via nodeIfType)
    // instead of re-deriving them with findNodeAtRange(tree.rootNode, ...) per
    // match — the O(matches x rootChildren) root-walk fixed for go #1915 /
    // python #1918, mirrored here.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // A tree-sitter pattern cannot say "and no singleton ancestor", so the
    // ownership test is a walk and the whole binding is dropped here when `self`
    // is the class object rather than an instance.
    //
    // Dropping the MARKER alone is not enough, and the class-body shape is why:
    // with the marker gone `rubyBindingScopeFor` declines to hoist and the
    // binding falls back to its innermost scope — which for `@shared = Outer.new`
    // written straight in the class body already IS the Class scope. It would
    // arrive at the wrong place by default. Discarding the match is the only
    // uniform answer, and it costs nothing that existed before: these ivar
    // patterns are new in #2807, so a class-object ivar simply goes back to
    // binding nothing, exactly as it did before the pattern was added.
    if (
      grouped['@type-binding.ivar-field'] !== undefined &&
      !isRubyInstanceIvarWrite(nodeMap['@type-binding.ivar-field'])
    ) {
      continue;
    }

    // Decompose require/require_relative/load into import captures
    if (grouped['@import.statement'] !== undefined) {
      const anchor = grouped['@import.statement']!;
      const callNode = nodeIfType(nodeMap['@import.statement'], 'call');
      if (callNode !== null) {
        const decomposed = decomposeRubyImport(callNode, anchor);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
      // Structural receiver chain for a call whose receiver is itself an
      // expression, so resolution can type it by folding over structure
      // instead of re-parsing the receiver's source text. Self-gating: a
      // non-call match, an absent receiver, or a chain with no nameable base
      // all leave `grouped` untouched.
      synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
      out.push(grouped);
      continue;
    }

    // Synthesize self receiver bindings for methods inside class/module
    if (grouped['@scope.function'] !== undefined) {
      const fnNode = nodeIfType(nodeMap['@scope.function'], ...FUNCTION_NODE_TYPES);
      if (fnNode !== null) {
        const enclosingNode = findEnclosingClassOrModule(fnNode);
        const receiver = synthesizeRubyReceiverBinding(fnNode, enclosingNode);
        if (receiver !== null) out.push(receiver);
        attachRubyLexicalNames(grouped, fnNode);
      }
      // Structural receiver chain for a call whose receiver is itself an
      // expression, so resolution can type it by folding over structure
      // instead of re-parsing the receiver's source text. Self-gating: a
      // non-call match, an absent receiver, or a chain with no nameable base
      // all leave `grouped` untouched.
      synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
      out.push(grouped);
      continue;
    }

    // A block scope (`do … end` / `{ … }`) lists the parameters it declares,
    // so the receiver walk stops on them (RUBY-03). The match carries only
    // `@scope.block`, so nothing below this branch applies to it.
    if (grouped['@scope.block'] !== undefined) {
      attachRubyLexicalNames(grouped, nodeMap['@scope.block']);
      out.push(grouped);
      continue;
    }

    // Reclassify declaration.function as declaration.method + attach arity
    if (grouped['@declaration.function'] !== undefined) {
      const fnNode = nodeIfType(nodeMap['@declaration.function'], ...FUNCTION_NODE_TYPES);
      if (fnNode !== null) {
        const enclosingNode = findEnclosingClassOrModule(fnNode);
        if (enclosingNode !== null) {
          const nameCap = grouped['@declaration.name'];
          delete (grouped as Record<string, Capture | undefined>)['@declaration.function'];
          grouped['@declaration.method'] = syntheticCapture(
            '@declaration.method',
            fnNode,
            fnNode.text,
          );
          if (nameCap !== undefined) {
            grouped['@declaration.name'] = nameCap;
          }
        }

        // Preserve AST classification across declaration.function → method
        // reclassification. Parsing the source prefix here would confuse
        // `def target.target` with an ordinary def and miss comments after def.
        if (isRubyLexicalMethod(fnNode)) {
          grouped['@declaration.lexical-method'] = syntheticCapture(
            '@declaration.lexical-method',
            fnNode,
            'true',
          );
        }

        const arity = computeRubyDeclarationArity(fnNode);
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
      // Structural receiver chain for a call whose receiver is itself an
      // expression, so resolution can type it by folding over structure
      // instead of re-parsing the receiver's source text. Self-gating: a
      // non-call match, an absent receiver, or a chain with no nameable base
      // all leave `grouped` untouched.
      synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
      out.push(grouped);
      continue;
    }

    // A bare identifier statement that names a parameter or an earlier-bound
    // local is a variable read, not a call (RUBY-04; see the section above).
    // Only the paren-less form is in question — the pattern anchors
    // `@reference.call.free` on the `body_statement` and `@reference.name` on
    // the bare `identifier`; a `call` anchor (`target()`, `target arg`,
    // `self.target`) is a call whatever is bound.
    if (
      grouped['@reference.call.free'] !== undefined &&
      nodeIfType(nodeMap['@reference.call.free'], 'body_statement') !== null
    ) {
      const bare = nodeIfType(nodeMap['@reference.name'], 'identifier');
      if (bare !== null && rubyBareNameIsLocalRead(bare, bareReadBindings)) continue;
      // The read check accounts for declaration order and closed Ruby scopes;
      // lexical-names deliberately carries neither. A surviving bare call
      // can therefore share a name with a later parameter or one in an outer
      // method. Dispatch it on self so that flat lexical claims do not erase
      // a call which the Ruby read check has already proved is not a local.
      if (bare !== null && rubyBareCallNeedsSelfReceiver(bare, lexicalNamesByScope)) {
        grouped['@reference.call.member'] = grouped['@reference.call.free']!;
        delete grouped['@reference.call.free'];
        grouped['@reference.receiver'] = syntheticCapture('@reference.receiver', bare, 'self');
      }
    }

    // Intercept heritage calls (include/extend/prepend) — encode as
    // special imports so emitHeritageEdges can emit IMPLEMENTS edges.
    if (grouped['@reference.call.free'] !== undefined && grouped['@reference.name'] !== undefined) {
      const callName = grouped['@reference.name']!.text;
      if (HERITAGE_CALL_NAMES.has(callName)) {
        const callNode = nodeIfType(nodeMap['@reference.call.free'], 'call');
        if (callNode !== null) {
          const ownerName = buildEnclosingQualifiedName(callNode);
          if (ownerName) {
            const argList = callNode.childForFieldName('arguments');
            if (argList !== null) {
              for (let ai = 0; ai < argList.namedChildCount; ai++) {
                const arg = argList.namedChild(ai);
                if (arg !== null && (arg.type === 'constant' || arg.type === 'scope_resolution')) {
                  // Normalize a qualified mixin arg (`Outer::Mixin`) to its dotted
                  // form (`Outer.Mixin`) BEFORE embedding it in the ':'-delimited
                  // __heritage__ marker: the raw `::` collides with the marker's `:`
                  // field separator and emitRubyMixinEdges mis-splits it, dropping
                  // the edge (#1982). The dotted form also matches the mixin def's
                  // qualifiedName key for resolution. Simple names are unchanged.
                  const mixinName = splitQualifiedName(arg.text).join('.');
                  out.push({
                    '@import.statement': grouped['@reference.call.free']!,
                    '@import.kind': syntheticCapture('@import.kind', callNode, 'namespace'),
                    '@import.source': syntheticCapture(
                      '@import.source',
                      callNode,
                      encodeMarker('heritage', [callName, mixinName, ownerName]),
                    ),
                    '@import.name': syntheticCapture('@import.name', callNode, mixinName),
                  });
                }
              }
            }
          }
        }
        continue;
      }

      // Intercept attr_accessor/attr_reader/attr_writer — encode as special
      // imports so emitHeritageEdges can create Property nodes + HAS_PROPERTY.
      // Also emit @declaration.property captures so each property ends up in
      // localDefs and gets reconciled into model.fields, enabling write-access
      // resolution via receiver-bound-calls (Case 4 → findOwnedMember).
      if (ATTR_CALL_NAMES.has(callName)) {
        const callNode = nodeIfType(nodeMap['@reference.call.free'], 'call');
        if (callNode !== null) {
          const ownerName = buildEnclosingQualifiedName(callNode);
          if (ownerName) {
            const argList = callNode.childForFieldName('arguments');
            if (argList !== null) {
              for (let ai = 0; ai < argList.namedChildCount; ai++) {
                const arg = argList.namedChild(ai);
                if (arg !== null && arg.type === 'simple_symbol') {
                  const propName = arg.text.replace(/^:/, '');
                  out.push({
                    '@import.statement': grouped['@reference.call.free']!,
                    '@import.kind': syntheticCapture('@import.kind', callNode, 'namespace'),
                    '@import.source': syntheticCapture(
                      '@import.source',
                      callNode,
                      encodeMarker('property', [callName, propName, ownerName]),
                    ),
                    '@import.name': syntheticCapture('@import.name', callNode, propName),
                  });
                  // Emit a property declaration so the property flows into
                  // localDefs → model.fields for receiver-bound write access.
                  out.push({
                    '@declaration.property': syntheticCapture(
                      '@declaration.property',
                      arg,
                      propName,
                    ),
                    '@declaration.name': syntheticCapture('@declaration.name', arg, propName),
                  });
                }
              }
            }
          }
        }
        continue;
      }
    }

    // Attach call arity for call expressions
    const callTag = (['@reference.call.free', '@reference.call.member'] as const).find(
      (t) => grouped[t] !== undefined,
    );
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = nodeIfType(nodeMap[callTag], 'call');
      if (callNode !== null) {
        const arity = computeRubyCallArity(callNode);
        grouped['@reference.arity'] = syntheticCapture('@reference.arity', callNode, String(arity));
      }
    }

    // Structural receiver chain for a call whose receiver is itself an
    // expression, so resolution can type it by folding over structure
    // instead of re-parsing the receiver's source text. Self-gating: a
    // non-call match, an absent receiver, or a chain with no nameable base
    // all leave `grouped` untouched.
    synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
    out.push(grouped);
  }

  // Second pass: member-call-return type bindings
  // Synthesize compound type bindings for `x = recv.method(...)` assignments.
  // The query-level @type-binding.call-return pattern only captures free calls
  // (!receiver). For member calls we need `x → recv.method()` so the compound
  // receiver resolver can chain-follow through the receiver's class scope.
  for (const assignNode of tree.rootNode.descendantsOfType('assignment')) {
    const left = assignNode.childForFieldName('left');
    const right = assignNode.childForFieldName('right');
    if (left === null || right === null) continue;
    if (left.type !== 'identifier' && left.type !== 'constant') continue;
    if (right.type !== 'call') continue;
    const recvNode = right.childForFieldName('receiver');
    const methodNode = right.childForFieldName('method');
    if (recvNode === null || methodNode === null) continue;
    // Skip .new calls — already handled by the constructor-inference query patterns
    if (methodNode.text === 'new') continue;
    const compoundName = `${recvNode.text}.${methodNode.text}()`;
    out.push({
      '@type-binding.call-return': syntheticCapture(
        '@type-binding.call-return',
        assignNode,
        assignNode.text,
      ),
      '@type-binding.name': syntheticCapture('@type-binding.name', assignNode, left.text),
      '@type-binding.type': syntheticCapture('@type-binding.type', assignNode, compoundName),
    });
  }

  // Third pass: YARD comment annotations (@param, @return, @type)
  for (const comment of tree.rootNode.descendantsOfType('comment')) {
    const text = comment.text;

    // @param name [Type]
    const paramMatch = text.match(/@param\s+(\w+)\s+\[([^\]]+)\]/);
    if (paramMatch) {
      const [, paramName, typeName] = paramMatch;
      const methodNode = findFollowingMethod(comment);
      if (
        methodNode !== null &&
        paramName &&
        typeName &&
        yardParamNameIsBindable(methodNode, paramName)
      ) {
        out.push({
          '@type-binding.parameter': syntheticCapture('@type-binding.parameter', methodNode, text),
          '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, paramName),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            methodNode,
            normalizeYardType(typeName),
          ),
        });
      }
    }

    // @param [Type] name (alternate YARD order)
    const paramAltMatch = text.match(/@param\s+\[([^\]]+)\]\s+(\w+)/);
    if (!paramMatch && paramAltMatch) {
      const [, typeName, paramName] = paramAltMatch;
      const methodNode = findFollowingMethod(comment);
      if (
        methodNode !== null &&
        paramName &&
        typeName &&
        yardParamNameIsBindable(methodNode, paramName)
      ) {
        out.push({
          '@type-binding.parameter': syntheticCapture('@type-binding.parameter', methodNode, text),
          '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, paramName),
          '@type-binding.type': syntheticCapture(
            '@type-binding.type',
            methodNode,
            normalizeYardType(typeName),
          ),
        });
      }
    }

    // @return [Type]
    const returnMatch = text.match(/@return\s+\[([^\]]+)\]/);
    if (returnMatch) {
      const [, typeName] = returnMatch;
      const methodNode = findFollowingMethod(comment);
      if (methodNode !== null && typeName) {
        const methodName = methodNode.childForFieldName('name')?.text;
        if (methodName) {
          out.push({
            '@type-binding.return': syntheticCapture('@type-binding.return', methodNode, text),
            '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, methodName),
            '@type-binding.type': syntheticCapture(
              '@type-binding.type',
              methodNode,
              normalizeYardType(typeName),
            ),
          });
        }
      } else if (typeName) {
        // YARD @return before attr_accessor/attr_reader/attr_writer: the
        // comment precedes a `call` node (not a method). Extract the
        // property name from the attr call's arguments and bind it to
        // the annotated return type. This enables field-type chains
        // like `user.address.save → Address#save`.
        const attrNode = findFollowingAttrCall(comment);
        if (attrNode !== null) {
          const argList = attrNode.childForFieldName('arguments');
          if (argList !== null) {
            for (let ai = 0; ai < argList.namedChildCount; ai++) {
              const arg = argList.namedChild(ai);
              if (arg !== null && arg.type === 'simple_symbol') {
                const propName = arg.text.replace(/^:/, '');
                out.push({
                  '@type-binding.return': syntheticCapture('@type-binding.return', attrNode, text),
                  '@type-binding.name': syntheticCapture('@type-binding.name', attrNode, propName),
                  '@type-binding.type': syntheticCapture(
                    '@type-binding.type',
                    attrNode,
                    normalizeYardType(typeName),
                  ),
                });
              }
            }
          }
        }
      }
    }
  }

  // Fourth pass: constructor-return inference for methods.
  // When a method's body ends with `ClassName.new(...)`, synthesize a
  // return-type binding `methodName → ClassName` on the method node.
  // This enables cross-file return-type propagation for factory methods
  // like `def self.get_user; User.new; end` → `get_user → User`.
  // Keys of methods that already got a return binding from the YARD pass above,
  // precomputed once. The previous `out.some(...)` per method was
  // O(methods x out.length) ~ O(n^2); this makes the dedup O(1) per method.
  // Key = `<name>:<return-binding startLine>`, matching the old AND condition.
  //
  // Snapshot-vs-live note (PR #1918 tri-review P3): the old `out.some` was
  // evaluated LIVE, so it also saw constructor-return bindings this very loop
  // pushed in earlier iterations. That made the old code suppress the 2nd of
  // two same-named methods one source row apart whose bodies both end in
  // `Const.new` (the 1st's pushed binding startLine == the 2nd's row via the
  // 1-based/0-based offset below). The snapshot is built from the YARD pass
  // only, so it no longer cross-suppresses — both bindings are emitted, which
  // is the intended behavior (the cross-suppression was unintended). This
  // corner is absent from fixtures, so the capture fingerprint is unchanged;
  // ruby-captures-golden.test.ts pins it explicitly.
  const yardReturnKeys = new Set<string>();
  for (const m of out) {
    const ret = m['@type-binding.return'];
    const name = m['@type-binding.name'];
    if (ret !== undefined && name !== undefined) {
      yardReturnKeys.add(`${name.text}:${ret.range.startLine}`);
    }
  }
  for (const methodNode of [
    ...tree.rootNode.descendantsOfType('method'),
    ...tree.rootNode.descendantsOfType('singleton_method'),
  ]) {
    const methodName = methodNode.childForFieldName('name')?.text;
    if (methodName === undefined) continue;
    // Skip if a YARD @return already created a return binding for this method.
    if (yardReturnKeys.has(`${methodName}:${methodNode.startPosition.row}`)) {
      continue;
    }
    const body = methodNode.childForFieldName('body');
    if (body === null) continue;
    // Find the last expression in the method body
    const lastChild = body.namedChildCount > 0 ? body.namedChild(body.namedChildCount - 1) : null;
    if (lastChild === null) continue;
    // Check if the last expression is a `ClassName.new(...)` call
    if (lastChild.type === 'call') {
      const recv = lastChild.childForFieldName('receiver');
      const meth = lastChild.childForFieldName('method');
      if (
        recv !== null &&
        meth !== null &&
        meth.text === 'new' &&
        (recv.type === 'constant' || recv.type === 'scope_resolution')
      ) {
        out.push({
          '@type-binding.return': syntheticCapture(
            '@type-binding.return',
            methodNode,
            `constructor-return: ${recv.text}.new`,
          ),
          '@type-binding.name': syntheticCapture('@type-binding.name', methodNode, methodName),
          '@type-binding.type': syntheticCapture('@type-binding.type', methodNode, recv.text),
        });
      }
    }
  }

  // Fifth pass: superclass inheritance (`class Foo < Bar`).
  // Emit `@reference.inherits` captures so the registry-primary scope-
  // resolution path produces EXTENDS edges (issue #1951). This mirrors the
  // C#/C++ inheritance synthesis: Ruby's superclass edges previously came
  // only from the legacy heritage-capture query (removed in #942), which the
  // worker pipeline drops for registry-primary languages → 0 inheritance edges
  // in worker mode. Mixins (include/extend/prepend) are NOT touched here — they
  // flow through `emitHeritageEdges` (the `__heritage__:` import path above),
  // an independent lane that stays intact when the legacy heritage leg is gated off.
  out.push(...synthesizeRubySuperclassReferences(tree.rootNode));
  out.push(...synthesizeCallableFlowCaptures(tree.rootNode, RUBY_CALLABLE_CAPTURE_OPTIONS));

  return out;
}

/**
 * Synthesize `@reference.inherits` captures from Ruby `class Foo < Bar`
 * superclass declarations so the shared `preEmitInheritanceEdges` pass can
 * resolve the base to a Class def and emit an EXTENDS edge.
 *
 * Scope is `class` nodes whose `superclass` field holds either a bare
 * `constant` base (`class D < Super`) or a qualified/scoped
 * `scope_resolution` base (`class C < Outer::Super`, `class E < A::B::C`) —
 * exactly the two shapes the config-driven legacy heritage alternation
 * captured (heritage-extractors/configs/ruby.ts
 * `rubyHeritageShapes: ['constant', 'scope_resolution']`). In prose: the
 * legacy query matched a `class` whose name is a `constant` and whose
 * `superclass` is either a `constant` or a `scope_resolution`, capturing the
 * superclass constant as the inherited base.
 *
 * Previously this pass emitted only for a direct `(constant)` child, so the
 * production registry-primary path silently dropped `Outer::Super`
 * superclasses while the legacy heritage leg captured them — the exact
 * EXTENDS/IMPLEMENTS-drop bug of #1951.
 *
 * THE PARITY CONTRACT: the `@reference.name` bare text must equal the legacy
 * leg's `normalizeSupertypeName(baseNode)` reduction. For a `scope_resolution`
 * (`Outer::Super`, `A::B::C`) the normalizer recurses into the `name:` field
 * and returns the trailing `constant` (`Super` / `C`); this synth mirrors that
 * by reading the same `name:` tail. A bare `constant` is unchanged
 * (byte-identical to the prior emission). `module` nodes are excluded (no
 * superclass field). Mixins (include/extend/prepend) are untouched — they flow
 * through the `__heritage__:` import lane above.
 *
 * Edge type (EXTENDS vs IMPLEMENTS) is decided downstream from the resolved
 * target's symbol kind — this pass only emits `@reference.inherits`.
 */
function synthesizeRubySuperclassReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  walkNamedTree(root, (node) => {
    if (node.type !== 'class') return;
    const superclass = node.childForFieldName('superclass');
    if (superclass === null) return;
    const baseNode = extractRubySuperclassBaseNode(superclass);
    if (baseNode === null) return;
    out.push({
      '@reference.inherits': nodeToCapture('@reference.inherits', baseNode),
      '@reference.name': nodeToCapture('@reference.name', baseNode),
    });
  });
  return out;
}

/**
 * Reduce a Ruby `superclass` node to the bare `constant` the resolver should
 * look up, at parity with the legacy heritage leg's
 * `normalizeSupertypeName(baseNode)`:
 *
 *   - direct `(constant)` child (`class D < Super`)       → that constant
 *     (unchanged from the original emission — kept byte-identical)
 *   - `(scope_resolution)` child (`class C < Outer::Super`,
 *     `class E < A::B::C`)                                → the trailing
 *     `name:` constant (`Super` / `C`)
 *
 * A `scope_resolution` nests qualifier-first, name-last
 * (`scope: (...) name: (constant)`), so the `name:` field is always the
 * trailing simple identifier — the same tail `normalizeSupertypeName` reaches
 * by recursing through its `name` field. Any other shape returns null (no
 * edge), keeping this emitter at parity with the legacy alternation
 * (`['constant', 'scope_resolution']`).
 */
function extractRubySuperclassBaseNode(superclass: SyntaxNode): SyntaxNode | null {
  const directConstant = findChild(superclass, 'constant');
  if (directConstant !== null) return directConstant;
  const scoped = findChild(superclass, 'scope_resolution');
  if (scoped !== null) {
    const tail = scoped.childForFieldName('name');
    if (tail !== null && tail.type === 'constant') return tail;
  }
  return null;
}

function decomposeRubyImport(callNode: SyntaxNode, anchor: Capture): CaptureMatch | null {
  const methodNode = callNode.childForFieldName('method');
  if (methodNode === null) return null;
  const methodName = methodNode.text;
  if (methodName !== 'require' && methodName !== 'require_relative' && methodName !== 'load') {
    return null;
  }

  const argsNode = callNode.childForFieldName('arguments');
  const argNode = argsNode !== null ? argsNode.namedChild(0) : callNode.namedChild(1);
  if (argNode === null) return null;

  let sourcePath: string;
  if (argNode.type === 'string') {
    const contentChild = argNode.namedChild(0);
    sourcePath =
      contentChild !== null && contentChild.type === 'string_content'
        ? contentChild.text
        : argNode.text.replace(/^['"]|['"]$/g, '');
  } else {
    return null;
  }

  if (sourcePath === '') return null;

  // require_relative always resolves from this file, including a bare sibling
  // spelling. Preserve that distinction for the provider's import resolver.
  if (
    methodName === 'require_relative' &&
    !sourcePath.startsWith('./') &&
    !sourcePath.startsWith('../') &&
    !sourcePath.startsWith('/')
  ) {
    sourcePath = `./${sourcePath}`;
  }

  const segments = sourcePath.replace(/\\/g, '/').split('/');
  const lastSegment = segments[segments.length - 1]!;
  const moduleName = lastSegment.replace(/\.rb$/, '');

  return {
    '@import.statement': anchor,
    '@import.kind': syntheticCapture('@import.kind', callNode, 'wildcard'),
    '@import.source': syntheticCapture('@import.source', callNode, sourcePath),
    '@import.name': syntheticCapture('@import.name', callNode, moduleName),
  };
}

function computeRubyDeclarationArity(fnNode: SyntaxNode): {
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
} {
  const params = fnNode.childForFieldName('parameters');
  if (params === null) return { parameterCount: 0, requiredParameterCount: 0 };

  let totalCount = 0;
  let requiredCount = 0;
  const paramTypes: string[] = [];

  for (let i = 0; i < params.namedChildCount; i++) {
    const child = params.namedChild(i);
    if (child === null) continue;

    switch (child.type) {
      case 'identifier':
        totalCount++;
        requiredCount++;
        paramTypes.push('');
        break;
      case 'optional_parameter':
        totalCount++;
        paramTypes.push('');
        break;
      case 'splat_parameter':
        totalCount++;
        paramTypes.push('*args');
        break;
      case 'hash_splat_parameter':
        totalCount++;
        paramTypes.push('**kwargs');
        break;
      case 'block_parameter':
        // &block not counted in arity
        break;
      case 'keyword_parameter': {
        totalCount++;
        const hasDefault = child.childForFieldName('value') !== null;
        if (!hasDefault) requiredCount++;
        paramTypes.push('');
        break;
      }
      default:
        totalCount++;
        requiredCount++;
        paramTypes.push('');
        break;
    }
  }

  return {
    parameterCount: totalCount,
    requiredParameterCount: requiredCount,
    parameterTypes: paramTypes.length > 0 ? paramTypes : undefined,
  };
}

function computeRubyCallArity(callNode: SyntaxNode): number {
  const argList = callNode.childForFieldName('arguments');
  if (argList === null) return 0;

  let count = 0;
  for (let i = 0; i < argList.namedChildCount; i++) {
    const child = argList.namedChild(i);
    if (child !== null && child.type !== 'block') count++;
  }
  return count;
}

function scopeExtractionError(stage: string, filePath: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(
    `[ruby] tree-sitter ${stage} failed for ${filePath}: ${reason}; skipping scope extraction for this file`,
  );
}

/**
 * Every node kind that can (re)bind a local name, with the field (or `null`
 * for the whole node) holding its binding positions, and — per kind — the
 * walker that decides whether the name is BOUND there rather than merely
 * mentioned (`siteBinds`). Enumerated from tree-sitter-ruby:
 *
 *   - `assignment` / `operator_assignment` `left`, `for` `pattern`: the
 *     target binds the name only when it IS the identifier or reaches it
 *     through `left_assignment_list` / `destructured_left_assignment` /
 *     `rest_assignment` (`a, user = …`, `(a, user), b = …`, `a, *user = …`).
 *     A `call` or `element_reference` target writes INTO a receiver
 *     (`user.name = x`, `user[0] = 1`, `user.a, user.b = …`, `user.count += 1`)
 *     and binds nothing.
 *   - `rescue` `variable` (`rescue => user`).
 *   - `lambda_parameters` of a stabby lambda, only when it declares the name
 *     AND one of its default values reads it (`->(user, x = user.save) { … }`).
 *     The parameter list sits outside the body block that lists the lambda's
 *     names (RUBY-03), so a read there would climb to the outer tag. A block
 *     (`|user|`, `|x; user|`), a lambda body and a nested `def inner(user)`
 *     declare their names on their own scope, where the receiver walk stops,
 *     so their shadowing no longer declines the tag.
 *   - `in_clause` / `match_pattern` / `test_pattern` `pattern`: identifiers in
 *     binding positions of a `case … in` / `=>` / `in` pattern — array/find/
 *     hash/alternative/parenthesized patterns, `=> name` (`as_pattern`),
 *     `*rest` / `**rest`, a `keyword_pattern` value, and the hash shorthand
 *     `{user:}` whose `keyword_pattern` has a key and no value. A pinned
 *     `^user` (`variable_reference_pattern`) or `^(expr)`
 *     (`expression_reference_pattern`) only READS and binds nothing.
 *
 * Known rebindings the AST cannot show (documented gaps, not guarded): a
 * regex named capture `/(?<user>…)/ =~ s`, `binding.local_variable_set`, `eval`.
 */
const REBINDING_POSITIONS: ReadonlyMap<string, string | null> = new Map([
  ['assignment', 'left'],
  ['operator_assignment', 'left'],
  ['for', 'pattern'],
  ['rescue', 'variable'],
  ['lambda_parameters', null],
  ['in_clause', 'pattern'],
  ['match_pattern', 'pattern'],
  ['test_pattern', 'pattern'],
]);

/**
 * Parameter names a `method_parameters` / `block_parameters` /
 * `lambda_parameters` node binds, in source order. Optional, keyword, splat,
 * hash-splat and block parameters carry the name in a `name` field; a
 * destructured parameter `(a, b)` nests plain identifiers; block locals
 * (`|x; user|`) are plain identifiers too. A default VALUE is not a name.
 */
function rubyParameterNames(paramsNode: SyntaxNode | null): string[] {
  const names: string[] = [];
  if (paramsNode === null) return names;
  const visit = (node: SyntaxNode): void => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null) continue;
      if (child.type === 'identifier') {
        names.push(child.text);
      } else if (child.type === 'destructured_parameter') {
        visit(child);
      } else {
        const name = child.childForFieldName('name');
        if (name !== null && name.type === 'identifier') names.push(name.text);
      }
    }
  };
  visit(paramsNode);
  return names;
}

/**
 * The parameters a scope node DECLARES, for `@scope.lexical-names` (RUBY-03).
 *
 * The shared receiver walk stops at the nearest scope that owns the receiver's
 * name, and a scope owns a name it holds no type for only through its lexical
 * names. Without them an untyped `|user|` was invisible, and the walk climbed
 * past it to a same-named outer binding: `user = User.new; items.each { |user|
 * user.save }` resolved the block's `user.save` to `User#save`.
 *
 * - `method` / `singleton_method` and `do_block` / `block` hold their own
 *   `parameters` field (a block's includes block locals, `|x; user|`).
 * - A stabby lambda's parameter list is a SIBLING of its body block
 *   (`(lambda parameters: (lambda_parameters) body: (block))`), and the body is
 *   the scope, so the lambda's names are listed on its body.
 *
 * Numbered (`_1`) and `it` parameters are not declared: the grammar parses them
 * as plain identifiers, `_1` cannot name an outer local, and `it` reads an
 * outer local of that name when one exists. Locals are not listed: in a block a
 * name the enclosing scope already binds is the SAME variable, so listing it
 * would cut a real capture; in a method a local does not exist before its first
 * assignment (`user.save` there still calls a `user` reader), and lexical names
 * carry no position.
 */
function rubyScopeLexicalNames(scopeNode: SyntaxNode): string[] {
  const names = rubyParameterNames(scopeNode.childForFieldName('parameters'));
  const parent = scopeNode.parent;
  if (parent !== null && parent.type === 'lambda') {
    const body = parent.childForFieldName('body');
    if (body !== null && body.id === scopeNode.id) {
      names.push(...rubyParameterNames(parent.childForFieldName('parameters')));
    }
  }
  return names;
}

/** Does a non-local bare call cross a parameter claim with an available self binding? */
function rubyBareCallNeedsSelfReceiver(
  identifier: SyntaxNode,
  namesByScope: Map<number, readonly string[]>,
): boolean {
  let hasMethod = false;
  let hasClaim = false;
  for (let scope = identifier.parent; scope !== null; scope = scope.parent) {
    if (scope.type === 'program') return false;
    if (scope.type === 'class' || scope.type === 'module') return hasMethod && hasClaim;
    const method = scope.type === 'method' || scope.type === 'singleton_method';
    if (!method && scope.type !== 'block' && scope.type !== 'do_block') continue;
    hasMethod ||= method;
    let names = namesByScope.get(scope.id);
    if (names === undefined) {
      names = rubyScopeLexicalNames(scope);
      namesByScope.set(scope.id, names);
    }
    hasClaim ||= names.includes(identifier.text);
  }
  return false;
}

/** Publish the parameters `scopeNode` declares on its scope match, when it declares any. */
function attachRubyLexicalNames(
  grouped: Record<string, Capture>,
  scopeNode: SyntaxNode | undefined,
): void {
  if (scopeNode === undefined) return;
  const names = rubyScopeLexicalNames(scopeNode);
  if (names.length === 0) return;
  grouped['@scope.lexical-names'] = syntheticCapture(
    '@scope.lexical-names',
    scopeNode,
    JSON.stringify(names),
  );
}

/** Containers an assignment / `for` target passes through to the names it binds. */
const LHS_CONTAINERS: ReadonlySet<string> = new Set([
  'left_assignment_list',
  'destructured_left_assignment',
  'rest_assignment',
  'exception_variable',
]);

/** Does an assignment-like TARGET bind `name` itself (not a receiver it writes into)? */
function lhsBinds(target: SyntaxNode, name: string): boolean {
  if (target.type === 'identifier') return target.text === name;
  if (!LHS_CONTAINERS.has(target.type)) return false;
  for (let i = 0; i < target.namedChildCount; i++) {
    const child = target.namedChild(i);
    if (child !== null && lhsBinds(child, name)) return true;
  }
  return false;
}

/** Does a `case … in` / `=>` / `in` pattern bind `name`? */
function patternBinds(pattern: SyntaxNode, name: string): boolean {
  switch (pattern.type) {
    case 'identifier':
      return pattern.text === name;
    case 'variable_reference_pattern':
    case 'expression_reference_pattern':
      // `^user` / `^(expr)` READ the local or the expression; they bind
      // nothing. (An assignment nested inside a pinned expression is a corner
      // that is accepted unseen.)
      return false;
    case 'keyword_pattern': {
      const value = pattern.childForFieldName('value');
      if (value !== null) return patternBinds(value, name);
      // `{user:}` — key with no value binds a local of the key's name.
      const key = pattern.childForFieldName('key');
      return key !== null && key.text.replace(/:$/, '') === name;
    }
    case 'as_pattern': {
      const bound = pattern.childForFieldName('name');
      if (bound !== null && bound.text === name) return true;
      const value = pattern.childForFieldName('value');
      return value !== null && patternBinds(value, name);
    }
    case 'splat_parameter':
    case 'hash_splat_parameter': {
      const bound = pattern.childForFieldName('name');
      return bound !== null && bound.text === name;
    }
    default: {
      // array/find/hash/alternative/parenthesized patterns and anything else:
      // recurse, so an unknown pattern kind errs toward declining.
      for (let i = 0; i < pattern.namedChildCount; i++) {
        const child = pattern.namedChild(i);
        if (child !== null && patternBinds(child, name)) return true;
      }
      return false;
    }
  }
}

/** Is `name` BOUND (not merely mentioned) at the binding site of a `REBINDING_POSITIONS` node? */
function siteBinds(nodeType: string, site: SyntaxNode, name: string): boolean {
  switch (nodeType) {
    case 'assignment':
    case 'operator_assignment':
    case 'for':
    case 'rescue':
      return lhsBinds(site, name);
    case 'lambda_parameters':
      return rubyParameterNames(site).includes(name) && parameterDefaultReads(site, name);
    case 'in_clause':
    case 'match_pattern':
    case 'test_pattern':
      return patternBinds(site, name);
    default:
      return false;
  }
}

/**
 * Does a default value in a parameter list read `name`? Optional and keyword
 * parameters hold their default in a `value` field; a destructured parameter
 * nests further parameters. Any identifier spelled `name` counts as a read.
 */
function parameterDefaultReads(paramsNode: SyntaxNode, name: string): boolean {
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const child = paramsNode.namedChild(i);
    if (child === null) continue;
    if (child.type === 'destructured_parameter') {
      if (parameterDefaultReads(child, name)) return true;
      continue;
    }
    const value = child.childForFieldName('value');
    if (value === null) continue;
    if (value.type === 'identifier' && value.text === name) return true;
    if (value.descendantsOfType('identifier').some((id) => id.text === name)) return true;
  }
  return false;
}

/**
 * True when `name` can be rebound anywhere in the method body — any of the
 * `REBINDING_POSITIONS`, at any depth. A nested block, lambda body or `def`
 * that declares the name is not a rebinding: it lists the name on its own
 * scope, where the receiver walk stops (RUBY-03), so an untyped same-named
 * local inside it no longer climbs to the outer tag.
 */
function isReboundInMethod(methodNode: SyntaxNode, name: string): boolean {
  for (const node of methodNode.descendantsOfType([...REBINDING_POSITIONS.keys()])) {
    const field = REBINDING_POSITIONS.get(node.type);
    const site = field === null || field === undefined ? node : node.childForFieldName(field);
    if (site !== null && siteBinds(node.type, site, name)) return true;
  }
  return false;
}

/**
 * Whether a YARD `@param` tag may type `name` inside `methodNode`.
 *
 * The tag's binding lives in the method's own scope (`rubyBindingScopeFor`
 * pins `@type-binding.parameter` there), where Pass 4 keeps the STRONGER of
 * two same-named facts: `parameter-annotation` (strength 2) outranks a
 * local's `constructor-inferred` type (strength 1, `typeBindingStrength`), so
 * `# @param user [AuditLog]` would override `user = User.new` in the body and
 * type `user.save` as `AuditLog#save` — before the pin the local won by scope
 * order. The tag therefore binds only a name that IS one of the method's
 * formal parameters (so a doc-drifted name types nothing), that is never
 * rebound anywhere in the body (`isReboundInMethod`), and that is not `self`
 * (the provider binds `self` itself; a `@param self` must not overwrite it).
 * Declining costs a missing edge; accepting would cost a wrong one.
 */
function yardParamNameIsBindable(methodNode: SyntaxNode, name: string): boolean {
  if (name === 'self') return false;
  if (!rubyParameterNames(methodNode.childForFieldName('parameters')).includes(name)) return false;
  return !isReboundInMethod(methodNode, name);
}

/**
 * Walk forward from a comment node, skipping consecutive comments,
 * and return the next `method` or `singleton_method` node (if any).
 */
function findFollowingMethod(commentNode: SyntaxNode): SyntaxNode | null {
  let sibling = commentNode.nextNamedSibling;
  while (sibling !== null && sibling.type === 'comment') {
    sibling = sibling.nextNamedSibling;
  }
  if (sibling === null) return null;
  if (sibling.type === 'method' || sibling.type === 'singleton_method') return sibling;
  // In tree-sitter-ruby, YARD comments before a method inside a class body
  // are children of `class`, while the method is inside `body_statement`.
  // Walk into body_statement to find the method.
  if (sibling.type === 'body_statement') {
    const first = sibling.firstNamedChild;
    if (first !== null && (first.type === 'method' || first.type === 'singleton_method')) {
      return first;
    }
  }
  return null;
}

/**
 * Walk forward from a comment node, skipping consecutive comments,
 * and return the next `call` node whose method is attr_accessor /
 * attr_reader / attr_writer (if any). Used to attach YARD `@return`
 * annotations to property declarations.
 */
function findFollowingAttrCall(commentNode: SyntaxNode): SyntaxNode | null {
  let sibling = commentNode.nextNamedSibling;
  while (sibling !== null && sibling.type === 'comment') {
    sibling = sibling.nextNamedSibling;
  }
  if (sibling === null) return null;
  if (sibling.type === 'call') {
    const methodNode = sibling.childForFieldName('method');
    if (methodNode !== null && ATTR_CALL_NAMES.has(methodNode.text)) {
      return sibling;
    }
  }
  return null;
}

/**
 * Normalize a YARD type string: for single-parameter generics like
 * `Array<User>` or `Array[User]` keep the inner type; for multi-param
 * generics like `Hash<Symbol, User>` strip the generic and return the
 * outer type name only.
 */
function normalizeYardType(raw: string): string {
  const trimmed = raw.trim();

  // Check for angle-bracket generics: Type<Inner> or Type<A, B>
  const angleMatch = trimmed.match(/^(\w+)<(.+)>$/);
  if (angleMatch) {
    const inner = angleMatch[2]!;
    // Single-param generic → return the inner type
    if (!inner.includes(',')) return inner.trim();
    // Multi-param generic → return the outer type
    return angleMatch[1]!;
  }

  // Check for bracket generics: Type[Inner]  (YARD sometimes uses this)
  const bracketMatch = trimmed.match(/^(\w+)\[(.+)\]$/);
  if (bracketMatch) {
    const inner = bracketMatch[2]!;
    if (!inner.includes(',')) return inner.trim();
    return bracketMatch[1]!;
  }

  return trimmed;
}

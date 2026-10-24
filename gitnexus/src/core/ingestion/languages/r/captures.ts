import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { getRParser, getRScopeQuery } from './query.js';
import { isRNonNamingScopeMatch } from './naming-argument.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { createSelfOwnerClassifier, fileBindsSelf, rR6MethodClassName } from './r6-self.js';

/**
 * Emit R scope captures — a single tree-sitter query run against the R
 * grammar (see `query.ts` for the capture shapes and the rationale for each
 * one). No programmatic enrichment is needed: unlike C/Zig/Rust, R's
 * declarations carry no synthesized arity/parameter metadata, and heritage
 * sites resolve directly by name (no marker encoding, unlike Ruby's
 * `include`/`extend`/`prepend`).
 */
export function emitRScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getRParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getRParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getRScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];
  // A file that binds `self` itself (`self <- Foo$new()` at top level) has a variable of that name
  // for its free functions to read, so they do not own `self`.
  const bindsSelf = fileBindsSelf(tree.rootNode);
  const functionOwnsSelf = createSelfOwnerClassifier();
  const typedMethods = new Set<number>();

  for (const m of rawMatches) {
    // The scope query captures every candidate argument of setClass/library/require/
    // source; keep only the one that names the class or import.
    if (isRNonNamingScopeMatch(m.captures)) continue;
    const grouped: Record<string, Capture> = {};
    let hasRealCapture = false;
    let functionNode: SyntaxNode | undefined;
    let methodNode: SyntaxNode | undefined;
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
      hasRealCapture = true;
      if (tag === '@scope.function' && c.node.type === 'function_definition') functionNode = c.node;
      if (tag === '@scope.function' && c.node.type === 'argument') methodNode = c.node;
      if (tag === '@scope.module' && c.node.type === 'program' && !bindsSelf) {
        grouped['@receiver-owner.self'] = syntheticCapture('@receiver-owner.self', c.node, 'self');
      }
    }
    if (!hasRealCapture) continue;
    // The function's own scope names what its formals and loop variables bind, so that a call
    // through one of them stops the lexical walk there instead of reaching a top-level function
    // of the same name.
    if (functionNode !== undefined) {
      const names = rFunctionLexicalNames(functionNode);
      if (names.length > 0) {
        grouped['@scope.lexical-names'] = syntheticCapture(
          '@scope.lexical-names',
          functionNode,
          JSON.stringify(names),
        );
      }
      if (!bindsSelf && functionOwnsSelf(functionNode)) {
        grouped['@receiver-owner.self'] = syntheticCapture(
          '@receiver-owner.self',
          functionNode,
          'self',
        );
      }
    }
    out.push(grouped);
    // An R6 method types `self` as its class. The binding is anchored on the method's name, so it
    // lands in the method's own scope (an anchor that spans the whole scope would hoist it to the
    // class scope, which every method of the class shares).
    if (methodNode !== undefined && !typedMethods.has(methodNode.id)) {
      typedMethods.add(methodNode.id);
      const className = rR6MethodClassName(methodNode);
      const methodName = methodNode.childForFieldName('name');
      if (className !== null && methodName !== null) {
        out.push({
          '@type-binding.self': syntheticCapture('@type-binding.self', methodName, 'self'),
          '@type-binding.name': syntheticCapture('@type-binding.name', methodName, 'self'),
          '@type-binding.type': syntheticCapture('@type-binding.type', methodName, className),
        });
      }
    }
  }

  return out;
}

/**
 * The names a `function_definition` binds in its own frame without a definition node: all its
 * named formals (`...` is not a name; a default proves nothing about the argument, which may be a
 * function, so a formal with a constant default is a lexical name too) and the variable of every
 * `for` loop in its body, outside any function nested in it (that one binds its own). A name is
 * kept as written, backticks included, which is how a call site spells it. Read from the tree once
 * per function, so the work over a file is linear in its size; the walk is iterative because a
 * body can nest deeply.
 */
export function rFunctionLexicalNames(fn: SyntaxNode): string[] {
  const names = new Set<string>();
  const parameters = fn.childForFieldName('parameters');
  if (parameters !== null) {
    for (let i = 0; i < parameters.namedChildCount; i++) {
      const parameter = parameters.namedChild(i);
      if (parameter?.type !== 'parameter') continue;
      const name = parameter.childForFieldName('name');
      if (name?.type !== 'identifier' || name.text.length === 0) continue;
      names.add(name.text);
    }
  }
  const stack: SyntaxNode[] = [];
  const body = fn.childForFieldName('body');
  if (body !== null) stack.push(body);
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'function_definition') continue;
    if (node.type === 'for_statement') {
      const variable = node.childForFieldName('variable');
      if (variable?.type === 'identifier' && variable.text.length > 0) names.add(variable.text);
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child);
    }
  }
  return [...names];
}

/**
 * `LanguageProvider.scopeOwnsReceivers` for R: the module scope and each function frame that is
 * not an R6 method (and not nested in a function) bind `self` themselves, with no type, which
 * makes a `self$m()` call there a definitive negative. The tag is written by
 * `emitRScopeCaptures`, where the tree is at hand.
 */
const R_SELF_OWNER: ReadonlySet<string> = Object.freeze(new Set(['self']));

export function rScopeOwnsReceivers(match: CaptureMatch): ReadonlySet<string> | undefined {
  return match['@receiver-owner.self'] !== undefined ? R_SELF_OWNER : undefined;
}

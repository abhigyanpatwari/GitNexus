/**
 * Angular @NgModule metadata extractor.
 *
 * Issue #32: Angular AppModule has no outgoing relationships in the graph.
 * The `@NgModule({ declarations: [...], imports: [...], providers: [...], bootstrap: [...] })`
 * decorator's metadata isn't extracted as graph edges. This module walks every
 * class declaration in a TypeScript/JavaScript file, looks for the `NgModule`
 * decorator, and emits graph edges so AppModule → AppComponent / DI-token
 * relationships are visible in the graph.
 *
 * Edge types (new, distinct from `IMPORTS` which is reserved for TS import
 * statement semantics):
 *   - DECLARES       AppModule → AppComponent, HeaderComponent, ...
 *   - IMPORTS_MODULE AppModule → BrowserModule, RouterModule, ...
 *   - PROVIDES       AppModule → UserService, ...
 *   - BOOTSTRAPS     AppModule → AppComponent, ...
 *
 * Output shape is the same `ParsedRelationship`-style object used by
 * parse-worker / heritage-processor so it can be wired in without touching
 * the worker serialization contract beyond adding one new field.
 *
 * Scope: this file owns NgModule-metadata edges only (#32). The CALLS
 * extractor for `@NgModule` providers and `@Component` template bindings
 * lives in `angular-calls.ts` (#31).
 */

import type Parser from 'tree-sitter';

/** Edge type strings — kept as a const tuple so types.ts can derive the union. */
export const ANGULAR_EDGE_TYPES = [
  'DECLARES',
  'IMPORTS_MODULE',
  'PROVIDES',
  'BOOTSTRAPS',
] as const;
export type AngularEdgeType = typeof ANGULAR_EDGE_TYPES[number];

/**
 * Extracted Angular @NgModule metadata edge. The pipeline resolves
 * `moduleClassName` / `targetName` against the symbol table to get real
 * node ids at graph-write time (mirrors the heritage-processor pattern).
 */
export interface ExtractedAngularEdge {
  filePath: string;
  /** The decorated class (e.g. `AppModule`). */
  moduleClassName: string;
  /** The referenced identifier inside the decorator (e.g. `AppComponent`). */
  targetName: string;
  /** Which NgModule metadata array the reference came from. */
  edgeType: AngularEdgeType;
  /** 0-based line number for diagnostics. */
  lineNumber: number;
}

/** The four NgModule metadata keys we care about, mapped to their edge type. */
const METADATA_KEY_TO_EDGE_TYPE: Record<string, AngularEdgeType> = {
  declarations: 'DECLARES',
  imports: 'IMPORTS_MODULE',
  providers: 'PROVIDES',
  bootstrap: 'BOOTSTRAPS',
};

/**
 * Return the identifier-name AST children of an NgModule metadata array
 * (e.g. `[AppComponent, HeaderComponent]` → `['AppComponent', 'HeaderComponent']`).
 *
 * Handles plain identifier references and member references like
 * `app.AppComponent` (takes the last dotted segment — same convention the
 * heritage processor uses for class/interface parents).
 */
function collectArrayElementNames(arrayNode: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of arrayNode.namedChildren ?? []) {
    // `[A, B, C]` — direct identifiers
    if (child.type === 'identifier') {
      names.push(child.text);
      continue;
    }
    // `[mod.A]` — scoped member reference → take the last segment
    if (child.type === 'member_expression' || child.type === 'scoped_identifier') {
      const text = child.text;
      if (text.includes('.')) {
        names.push(text.split('.').pop()!);
      } else {
        names.push(text);
      }
      continue;
    }
  }
  return names;
}

/**
 * Find the object literal that is the argument of the `@NgModule(...)` call.
 * NgModule is always invoked with a single object-literal argument that
 * holds `declarations` / `imports` / `providers` / `bootstrap` arrays.
 */
function findNgModuleObjectLiteral(decoratorNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // The decorator's direct child is a call_expression (`NgModule({...})`).
  // Some grammars model `@NgModule` with no parens as a marker — those
  // can't have metadata, return null.
  const callExpr = decoratorNode.namedChildren.find(c => c.type === 'call_expression');
  if (!callExpr) return null;

  // arguments: (arguments (object) ...)
  const argsNode = callExpr.childForFieldName?.('arguments')
    ?? callExpr.namedChildren.find(c => c.type === 'arguments');
  if (!argsNode) return null;

  // First named argument should be the object literal.
  for (const arg of argsNode.namedChildren) {
    if (arg.type === 'object') return arg;
  }
  return null;
}

/**
 * For a single `@NgModule` decorator node on a class, emit zero or more
 * ExtractedAngularEdge records.
 */
function edgesForNgModuleDecorator(
  decoratorNode: Parser.SyntaxNode,
  moduleClassName: string,
  filePath: string,
): ExtractedAngularEdge[] {
  const objectLiteral = findNgModuleObjectLiteral(decoratorNode);
  if (!objectLiteral) return [];

  const edges: ExtractedAngularEdge[] = [];

  for (const prop of objectLiteral.namedChildren) {
    if (prop.type !== 'pair' && prop.type !== 'shorthand_property_identifier_pattern') continue;

    // `key: value` lives at prop.children. In tree-sitter-typescript this is
    // (property_identifier) (':') (_value_) — fall back to scanning for the
    // key text and the value node.
    const keyText = prop.childForFieldName?.('name')?.text
      ?? prop.childForFieldName?.('key')?.text
      ?? (prop.namedChildren[0]?.text ?? '');

    const valueNode = prop.childForFieldName?.('value')
      ?? (prop.namedChildren[prop.namedChildren.length - 1] ?? null);
    if (!valueNode) continue;

    const edgeType = METADATA_KEY_TO_EDGE_TYPE[keyText];
    if (!edgeType) continue;

    // Value should be an array literal. Skip scalars defensively.
    if (valueNode.type !== 'array') continue;

    for (const target of collectArrayElementNames(valueNode)) {
      edges.push({
        filePath,
        moduleClassName,
        targetName: target,
        edgeType,
        lineNumber: decoratorNode.startPosition.row,
      });
    }
  }

  return edges;
}

/**
 * Walk a tree-sitter file, find every `class_declaration` whose enclosing
 * statement carries an `NgModule` decorator, and emit ExtractedAngularEdge
 * records.
 *
 * Class declarations without `@NgModule` are skipped entirely.
 *
 * Note on AST shape (tree-sitter-typescript):
 *   export_statement
 *     decorator
 *     class_declaration
 *   ────────────
 *   (or unexported)
 *   decorator (as previousNamedSibling of class_declaration)
 *   class_declaration
 *
 * We collect decorators from BOTH positions because grammars vary across
 * versions and `--export` style choices.
 */
export function extractAngularMetadata(
  tree: Parser.Tree,
  filePath: string,
): ExtractedAngularEdge[] {
  const results: ExtractedAngularEdge[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (!node) return;

    if (node.type === 'class_declaration') {
      const className = node.childForFieldName?.('name')?.text
        ?? node.namedChildren.find(c => c.type === 'type_identifier' || c.type === 'identifier')?.text;
      if (!className) {
        for (const child of node.namedChildren ?? []) visit(child);
        return;
      }

      // Collect decorators from BOTH positions:
      //   1) previousNamedSibling decorators (common for un-exported classes)
      //   2) siblings inside the parent (e.g. export_statement carries
      //      `decorator` and `class_declaration` as separate namedChildren)
      // We dedupe by node identity so each decorator is processed exactly once
      // even when the same node is reachable via both paths.
      const decoratorSet = new Set<Parser.SyntaxNode>();
      const decorators: Parser.SyntaxNode[] = [];

      let prev = node.previousNamedSibling;
      while (prev && prev.type === 'decorator') {
        if (!decoratorSet.has(prev)) {
          decoratorSet.add(prev);
          decorators.push(prev);
        }
        prev = prev.previousNamedSibling;
      }
      // Also check the parent statement for decorator children
      // (export_statement wraps both the decorator and the class).
      const parent = node.parent;
      if (parent) {
        for (const child of parent.namedChildren) {
          if (child.type === 'decorator' && !decoratorSet.has(child)) {
            decoratorSet.add(child);
            decorators.push(child);
          }
        }
      }

      for (const deco of decorators) {
        const decoratorName = extractDecoratorName(deco);
        if (decoratorName === 'NgModule') {
          results.push(...edgesForNgModuleDecorator(deco, className, filePath));
        }
      }
    }

    for (const child of node.namedChildren ?? []) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return results;
}

/**
 * Extract the identifier name from a decorator node.
 *
 * A decorator's AST shape in tree-sitter-typescript is:
 *   decorator
 *     @          (anonymous)
 *     call_expression
 *       identifier     ← the decorator name (e.g. "NgModule")
 *       arguments
 *
 * We unwrap the call_expression to find the identifier.
 */
function extractDecoratorName(decoratorNode: Parser.SyntaxNode): string | null {
  // Fast path: simple identifier child of the decorator (e.g., `@Foo`).
  const direct = decoratorNode.namedChildren.find(c => c.type === 'identifier' || c.type === 'scoped_identifier');
  if (direct) return direct.text;

  // Common path: call_expression → identifier.
  const call = decoratorNode.namedChildren.find(c => c.type === 'call_expression');
  if (call) {
    const id = call.childForFieldName?.('function')
      ?? call.namedChildren.find(c => c.type === 'identifier' || c.type === 'scoped_identifier');
    if (id) return id.text;
  }
  return null;
}

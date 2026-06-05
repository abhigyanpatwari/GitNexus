/**
 * Angular CALLS edge extractor (Issue #31).
 *
 * Two specific cases that were previously invisible in the context tool:
 *   1. @NgModule({ providers: [UserService] })  → CALLS AppModule → UserService
 *      (DI token → service class)
 *   2. @Component({ template: '<button (click)="onClick()">' })
 *      → CALLS AppComponent → onClick
 *      (template binding → method on the component)
 *
 * We emit AngularCallRecord objects with the same shape as ExtractedCall so
 * they can be appended to `result.calls` in the parse worker and flow through
 * processCallsFromExtracted. The sourceId is a Class node id, the resolver
 * matches the called name against any indexed symbol in the same file (or the
 * imported file for providers).
 *
 * Scope: this file owns provider + template-binding CALLS edges only (#31).
 * The NgModule-metadata edges (DECLARES / IMPORTS_MODULE / PROVIDES /
 * BOOTSTRAPS) live in `angular-metadata.ts` (#32).
 */

import type Parser from 'tree-sitter';
import { generateId } from '../../../lib/utils.js';

/**
 * Shape we emit. Mirrors ExtractedCall from the worker module so the worker
 * can copy fields into `result.calls` without re-shaping.
 */
export interface AngularCallRecord {
  filePath: string;
  /** `Class:${filePath}:${enclosingClassName}` — the source node id. */
  sourceId: string;
  calledName: string;
  callForm: 'free' | 'member';
  /** For template bindings: the receiver type (component class) so the
   *  resolver can match against the method's enclosing class. */
  receiverTypeName?: string;
  /** For template bindings: the receiver (always `this` for component methods). */
  receiverName?: string;
  /** 0-based line number for diagnostics. */
  lineNumber: number;
}

/** Decorator names that carry Angular metadata we want to inspect. */
const ANGULAR_CALL_DECORATOR_NAMES = new Set(['NgModule', 'Component']);

/** Match `(event)="methodName($event)"` — captures the method name. */
const TEMPLATE_BINDING_REGEX = /\(\s*\w+\s*\)\s*=\s*"([A-Za-z_$][\w$]*)\s*\([^"]*\)"/g;

/**
 * Public entry point. Returns Angular call records to be appended to
 * `result.calls` in the parse worker.
 */
export function extractAngularCalls(
  tree: Parser.Tree,
  filePath: string,
): AngularCallRecord[] {
  const results: AngularCallRecord[] = [];
  if (!tree || !tree.rootNode) return results;

  function visit(node: Parser.SyntaxNode): void {
    if (!node) return;

    if (node.type === 'class_declaration') {
      const className = node.childForFieldName?.('name')?.text
        ?? node.namedChildren.find(c => c.type === 'type_identifier' || c.type === 'identifier')?.text;
      if (!className) {
        for (const child of node.namedChildren ?? []) visit(child);
        return;
      }

      // Find Angular decorators on this class.
      const decorators = collectClassDecorators(node);

      for (const deco of decorators) {
        const decoratorName = extractDecoratorName(deco);
        if (!decoratorName || !ANGULAR_CALL_DECORATOR_NAMES.has(decoratorName)) continue;

        const objectLiteral = findNgModuleObjectLiteral(deco);
        if (!objectLiteral) continue;

        const sourceId = generateId('Class', `${filePath}:${className}`);

        if (decoratorName === 'NgModule') {
          // Providers: each is a DI token (typically a class name) the
          // module makes available for injection. Emit one CALLS edge per
          // identifier.
          const providers = findArrayProperty(objectLiteral, 'providers');
          if (providers) {
            for (const target of collectArrayElementNames(providers)) {
              results.push({
                filePath,
                sourceId,
                calledName: target,
                callForm: 'free',
                lineNumber: deco.startPosition.row,
              });
            }
          }
        } else if (decoratorName === 'Component') {
          // Template string: parse out event bindings.
          const templateNode = findStringProperty(objectLiteral, 'template');
          if (templateNode) {
            const templateText = unquoteString(templateNode);
            if (templateText) {
              for (const methodName of extractTemplateBindingMethods(templateText)) {
                results.push({
                  filePath,
                  sourceId,
                  calledName: methodName,
                  callForm: 'member',
                  receiverName: 'this',
                  receiverTypeName: className,
                  lineNumber: deco.startPosition.row,
                });
              }
            }
          }
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

/** Collect all decorator nodes attached to a class declaration. */
function collectClassDecorators(classNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const decorators: Parser.SyntaxNode[] = [];

  // Decorators may be children of the class_declaration node directly…
  for (const child of classNode.namedChildren) {
    if (child.type === 'decorator') decorators.push(child);
  }
  // …or siblings of the class on its parent statement (export_statement etc.).
  let prev = classNode.previousNamedSibling;
  while (prev && prev.type === 'decorator') {
    decorators.push(prev);
    prev = prev.previousNamedSibling;
  }
  return decorators;
}

/**
 * Find the object literal that is the argument of the `@NgModule(...)` /
 * `@Component(...)` call.
 */
function findNgModuleObjectLiteral(decoratorNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const callExpr = decoratorNode.namedChildren.find(c => c.type === 'call_expression');
  if (!callExpr) return null;
  const argsNode = callExpr.childForFieldName?.('arguments')
    ?? callExpr.namedChildren.find(c => c.type === 'arguments');
  if (!argsNode) return null;
  for (const arg of argsNode.namedChildren) {
    if (arg.type === 'object') return arg;
  }
  return null;
}

/**
 * Extract the identifier name from a decorator node.
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

/** Locate a property whose key matches `name` and whose value is an array literal. */
function findArrayProperty(objectLit: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const prop of objectLit.namedChildren) {
    if (prop.type !== 'pair' && prop.type !== 'shorthand_property_identifier_pattern') continue;
    const keyText = prop.childForFieldName?.('name')?.text
      ?? prop.childForFieldName?.('key')?.text
      ?? (prop.namedChildren[0]?.text ?? '');
    if (keyText !== name) continue;
    const valueNode = prop.childForFieldName?.('value')
      ?? (prop.namedChildren[prop.namedChildren.length - 1] ?? null);
    if (valueNode && valueNode.type === 'array') return valueNode;
  }
  return null;
}

/** Locate a property whose value is a string literal (or template literal). */
function findStringProperty(objectLit: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const prop of objectLit.namedChildren) {
    if (prop.type !== 'pair' && prop.type !== 'shorthand_property_identifier_pattern') continue;
    const keyText = prop.childForFieldName?.('name')?.text
      ?? prop.childForFieldName?.('key')?.text
      ?? (prop.namedChildren[0]?.text ?? '');
    if (keyText !== name) continue;
    const valueNode = prop.childForFieldName?.('value')
      ?? (prop.namedChildren[prop.namedChildren.length - 1] ?? null);
    // Accept both "string" and "template_string" (backticks) — Angular devs
    // frequently use template literals for multi-line templates.
    if (valueNode && (valueNode.type === 'string' || valueNode.type === 'template_string')) return valueNode;
  }
  return null;
}

/** Return the identifier-name AST children of a metadata array. */
function collectArrayElementNames(arrayNode: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of arrayNode.namedChildren ?? []) {
    if (child.type === 'identifier') {
      names.push(child.text);
      continue;
    }
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

/** Pull the method names referenced by `(event)="method(...)"` bindings. */
export function extractTemplateBindingMethods(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(TEMPLATE_BINDING_REGEX)) {
    const name = m[1];
    if (name) seen.add(name);
  }
  return Array.from(seen);
}

/** Strip surrounding quotes from a string literal node. */
function unquoteString(node: Parser.SyntaxNode): string | null {
  const raw = node.text;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1);
  // Template string with interpolation — fall back to the first string_fragment
  // child for the literal portion. For Angular templates this is sufficient
  // since `(event)="method()"` bindings don't contain `${...}` expressions.
  if (node.type === 'template_string') {
    const frag = node.namedChildren.find(c => c.type === 'string_fragment');
    if (frag) return frag.text;
  }
  return raw;
}

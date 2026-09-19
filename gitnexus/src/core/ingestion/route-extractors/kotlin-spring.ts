/**
 * Kotlin Spring MVC route annotations for the ingestion pipeline (#3130).
 *
 * This module only walks a caller-provided tree. In particular, it does not
 * import or load tree-sitter-kotlin at module initialization, so platforms
 * without the optional grammar can still load the language-provider registry.
 */
import type Parser from 'tree-sitter';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';
import {
  intersectSpringHttpMethods,
  isClassLevelMappingAnnotation,
  springAnnotationHttpMethods,
  unquoteSpringLiteral,
} from './spring-shared.js';
import {
  extractKotlinModuleConstants,
  parseKotlinConstOperands,
  unfoldableDeclarationsOf,
  unquoteKotlinIdentifier,
  type KotlinModuleConstants,
  type Operand,
} from './kotlin-const-resolver.js';

/** Direct declaration annotations in source order. */
function declarationAnnotations(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  return modifiers?.namedChildren.filter((child) => child.type === 'annotation') ?? [];
}

/** `@Foo`, `@Foo(...)`, or `@a.b.Foo(...)` → `Foo`. */
function annotationName(annotation: Parser.SyntaxNode): string | null {
  const constructor = annotation.namedChildren.find(
    (child) => child.type === 'constructor_invocation',
  );
  const userType =
    annotation.namedChildren.find((child) => child.type === 'user_type') ??
    constructor?.namedChildren.find((child) => child.type === 'user_type');
  const identifiers =
    userType?.namedChildren.filter((child) => child.type === 'type_identifier') ?? [];
  const identifier = identifiers.at(-1);
  return identifier ? unquoteKotlinIdentifier(identifier.text) : null;
}

function annotationArguments(annotation: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const constructor = annotation.namedChildren.find(
    (child) => child.type === 'constructor_invocation',
  );
  const values = constructor?.namedChildren.find((child) => child.type === 'value_arguments');
  return values?.namedChildren.filter((child) => child.type === 'value_argument') ?? [];
}

interface AnnotationArgument {
  readonly name?: string;
  readonly expression: Parser.SyntaxNode;
}

/**
 * Kotlin represents positional and named annotation arguments with the same
 * `value_argument` node. A direct `=` token distinguishes the named form.
 */
function readAnnotationArgument(argument: Parser.SyntaxNode): AnnotationArgument | null {
  const named = argument.children.some((child) => child.type === '=');
  if (!named) {
    const expression = argument.namedChild(0);
    return expression ? { expression } : null;
  }
  const key = argument.namedChild(0);
  const expression = argument.namedChild(1);
  if (key?.type !== 'simple_identifier' || !expression) return null;
  return { name: unquoteKotlinIdentifier(key.text), expression };
}

function routeArguments(annotation: Parser.SyntaxNode): AnnotationArgument[] | null {
  const out: AnnotationArgument[] = [];
  for (const argument of annotationArguments(annotation)) {
    const parsed = readAnnotationArgument(argument);
    if (!parsed) return null;
    if (parsed.name === undefined || parsed.name === 'path' || parsed.name === 'value') {
      out.push(parsed);
    }
  }
  return out;
}

/** A fully static Kotlin string literal: no `$name` or `${expr}` children. */
function isPlainStringLiteral(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'string_literal' &&
    node.namedChildren.every((child) => child.type === 'string_content')
  );
}

/**
 * Empty `[]` / `arrayOf()` is Spring "no path", not an unresolvable prefix.
 * tree-sitter-kotlin may put a zero-width recovery child inside `[]`.
 */
function isEmptyKotlinPathCollection(node: Parser.SyntaxNode): boolean {
  if (node.type === 'collection_literal') {
    return node.namedChildren.every((child) => child.text.length === 0);
  }
  if (node.type !== 'call_expression') return false;
  const callee = node.namedChild(0);
  if (callee?.type !== 'simple_identifier' || unquoteKotlinIdentifier(callee.text) !== 'arrayOf') {
    return false;
  }
  const suffix = node.namedChildren.find((child) => child.type === 'call_suffix');
  const args = suffix?.namedChildren.find((child) => child.type === 'value_arguments');
  if (!args) return true;
  return args.namedChildren.every((child) => child.type !== 'value_argument');
}

function isKotlinInterface(node: Parser.SyntaxNode): boolean {
  return node.children.some((child) => child.type === 'interface');
}

function isAbstractOrSealedClass(node: Parser.SyntaxNode): boolean {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  return (
    modifiers?.namedChildren.some((child) => {
      if (child.type !== 'inheritance_modifier' && child.type !== 'class_modifier') {
        return false;
      }
      const text = child.text.trim();
      return text === 'abstract' || text === 'sealed';
    }) === true
  );
}

function directFunctions(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const body = node.namedChildren.find((child) => child.type === 'class_body');
  return body?.namedChildren.filter((child) => child.type === 'function_declaration') ?? [];
}

function functionName(node: Parser.SyntaxNode): string | null {
  const field = node.childForFieldName('name');
  const identifier =
    field?.type === 'simple_identifier'
      ? field
      : node.namedChildren.find((child) => child.type === 'simple_identifier');
  return identifier ? unquoteKotlinIdentifier(identifier.text) : null;
}

function typeName(node: Parser.SyntaxNode): string | null {
  const identifier = node.children.find((child) => child.type === 'type_identifier');
  return identifier ? unquoteKotlinIdentifier(identifier.text) : null;
}

/**
 * Qualified enclosing type paths, innermost first. Kotlin companion members
 * are keyed through their enclosing class, so companion_object itself adds no
 * segment.
 */
function enclosingTypeNames(node: Parser.SyntaxNode): string[] {
  const simpleNames: string[] = [];
  for (let current: Parser.SyntaxNode | null = node.parent; current; current = current.parent) {
    if (current.type !== 'class_declaration' && current.type !== 'object_declaration') continue;
    const name = typeName(current);
    if (name) simpleNames.push(name);
  }
  return simpleNames.map((_, index) => simpleNames.slice(index).reverse().join('.'));
}

function declarationExists(constants: KotlinModuleConstants, name: string): boolean {
  return (
    constants.literals.has(name) ||
    constants.exprs.has(name) ||
    unfoldableDeclarationsOf(constants).has(name)
  );
}

/**
 * The provider fold hook has a language-neutral three-argument signature and
 * cannot receive a Kotlin reference site's enclosing type chain. Qualify only
 * names whose owner is proven by this same tree; unresolved/imported names are
 * left untouched for the repo-wide resolver.
 */
function qualifySameFileOperands(
  operands: readonly Operand[],
  functionNode: Parser.SyntaxNode,
  constants: KotlinModuleConstants,
): Operand[] {
  const enclosingTypes = enclosingTypeNames(functionNode);
  return operands.map((operand) => {
    if (operand.kind === 'literal') return operand;
    for (const owner of enclosingTypes) {
      const qualified = `${owner}.${operand.name}`;
      if (declarationExists(constants, qualified)) {
        return { kind: 'ref', name: qualified };
      }
    }
    return operand;
  });
}

interface ClassMapping {
  readonly prefix: string;
  readonly methods: readonly string[];
}

/**
 * Read the one optional class-level RequestMapping. A present route member must
 * be exactly one plain string literal, an empty `[]`/`arrayOf()` (no prefix),
 * or absent; constants, interpolation, non-empty collections, duplicate
 * mappings, and dynamic expressions fail closed for the whole class.
 */
function classMapping(annotations: readonly Parser.SyntaxNode[]): ClassMapping | null {
  const mappings = annotations.filter((annotation) =>
    isClassLevelMappingAnnotation(annotationName(annotation) ?? ''),
  );
  if (mappings.length === 0) return { prefix: '', methods: ['*'] };
  if (mappings.length !== 1) return null;

  const mapping = mappings[0];
  const paths = routeArguments(mapping);
  if (paths === null || paths.length > 1) return null;

  let prefix = '';
  if (paths.length === 1) {
    const path = paths[0].expression;
    if (isEmptyKotlinPathCollection(path)) {
      prefix = '';
    } else if (isPlainStringLiteral(path)) {
      const literal = unquoteSpringLiteral(path.text);
      if (literal === null) return null;
      prefix = literal;
    } else {
      return null;
    }
  }

  const mappingName = annotationName(mapping);
  if (!mappingName) return null;
  const methods = springAnnotationHttpMethods(mappingName, mapping.text);
  return methods.length === 0 ? null : { prefix, methods };
}

/**
 * Extract direct Spring handler methods from concrete Kotlin RestControllers.
 */
export function extractKotlinSpringRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  const routes: ExtractedDecoratorRoute[] = [];
  let moduleConstants: KotlinModuleConstants | undefined;

  for (const classNode of tree.rootNode.descendantsOfType('class_declaration')) {
    if (isKotlinInterface(classNode) || isAbstractOrSealedClass(classNode)) continue;
    const annotations = declarationAnnotations(classNode);
    const annotationNames = annotations.map(annotationName);
    if (!annotationNames.includes('RestController')) continue;
    if (annotationNames.includes('FeignClient')) continue;

    const ownerMapping = classMapping(annotations);
    if (ownerMapping === null) continue;

    for (const functionNode of directFunctions(classNode)) {
      const handlerName = functionName(functionNode);
      if (!handlerName) continue;

      for (const annotation of declarationAnnotations(functionNode)) {
        const decoratorName = annotationName(annotation);
        if (!decoratorName) continue;

        const methodMethods = springAnnotationHttpMethods(decoratorName, annotation.text);
        const methods = intersectSpringHttpMethods(ownerMapping.methods, methodMethods);
        if (methods.length === 0) continue;

        const paths = routeArguments(annotation);
        if (paths === null || paths.length > 1) continue;

        let routePath = '';
        let routePathExpr: string | undefined;
        let routePathOperands: Operand[] | undefined;
        if (paths.length === 1) {
          const expression = paths[0].expression;
          if (isEmptyKotlinPathCollection(expression)) {
            routePath = '';
          } else if (isPlainStringLiteral(expression)) {
            const literal = unquoteSpringLiteral(expression.text);
            if (literal === null) continue;
            routePath = literal;
          } else {
            const operands = parseKotlinConstOperands(expression);
            if (operands === null) continue;
            moduleConstants ??= extractKotlinModuleConstants(tree);
            routePathExpr = expression.text;
            routePathOperands = qualifySameFileOperands(operands, functionNode, moduleConstants);
          }
        }

        for (const httpMethod of methods) {
          routes.push({
            filePath,
            routePath,
            httpMethod,
            decoratorName,
            lineNumber: annotation.startPosition.row + lineOffset,
            ...(ownerMapping.prefix ? { prefix: ownerMapping.prefix } : {}),
            handlerName,
            ...(routePathExpr === undefined
              ? {}
              : {
                  routePathExpr,
                  routePathOperands,
                }),
          });
        }
      }
    }
  }

  return routes;
}

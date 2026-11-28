/**
 * C++17/20 Class Template Argument Deduction (CTAD) & user-defined deduction
 * guides (`[over.match.class.deduct]`, `[temp.deduct.guide]`, issue #1896).
 *
 * Per-file AST facts are captured once during `emitCppScopeCaptures` into plain
 * JSON-cloneable side-channel records (so worker-pool parsing and warm parse
 * caches replay without re-parsing). Workspace-wide synthesis runs in
 * `populateCppCtadBindings` during `populateNamespaceSiblings`, where headers,
 * class templates, constructors, and user deduction guides across `#include`s
 * are all visible and `Scope.typeBindings` is mutable (Invariant I6).
 */

import type { ParsedFile, Range, Scope, ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { normalizeCppTypeName } from './interpret.js';
import {
  canonicalCppTypeTerm,
  isCppPatternMoreSpecialized,
  parseCppTypeTerm,
  unifyCppTypePattern,
  type CppTypeTerm,
} from './template-specialization.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';

export interface CppCtadArgFact {
  readonly known: boolean;
  /** Type spelling used for deduction (`int`, `double`, `string`, `int*`, `const int*`, `User`). */
  readonly typeSpelling: string;
  readonly isStringLiteral?: boolean;
  readonly identName?: string;
}

export interface CppCtadSiteFact {
  readonly varName: string;
  readonly writtenType: string;
  readonly declRange: Range;
  readonly isBracedInit: boolean;
  readonly args: readonly CppCtadArgFact[];
}

export interface CppCtorPatternFact {
  readonly paramPatterns: readonly string[];
  readonly requiredParamCount: number;
}

export interface CppClassCtadShapeFact {
  readonly className: string;
  readonly enclosingNamespace: string;
  readonly templateParams: readonly string[];
  readonly templateParamDefaults: { readonly [paramName: string]: string };
  readonly constructors: readonly CppCtorPatternFact[];
  readonly aggregateFieldTypes: readonly string[];
}

export interface CppDeductionGuideFact {
  readonly className: string;
  readonly enclosingNamespace: string;
  readonly templateParams: readonly string[];
  readonly paramPatterns: readonly string[];
  readonly requiredParamCount: number;
  readonly targetTemplateArgs: readonly string[];
}

export interface CppCtadSideChannel {
  readonly sites: readonly CppCtadSiteFact[];
  readonly classShapes: readonly CppClassCtadShapeFact[];
  readonly deductionGuides: readonly CppDeductionGuideFact[];
}

const EMPTY_SIDE_CHANNEL: CppCtadSideChannel = {
  sites: [],
  classShapes: [],
  deductionGuides: [],
};

const capturedCtadByFile = new Map<string, CppCtadSideChannel>();

export function clearCppCtadState(): void {
  capturedCtadByFile.clear();
}

export function collectCppCtadSideChannel(filePath: string): CppCtadSideChannel {
  return capturedCtadByFile.get(filePath) ?? EMPTY_SIDE_CHANNEL;
}

export function applyCppCtadSideChannel(filePath: string, data: CppCtadSideChannel): void {
  if (
    data.sites.length === 0 &&
    data.classShapes.length === 0 &&
    data.deductionGuides.length === 0
  ) {
    capturedCtadByFile.delete(filePath);
    return;
  }
  capturedCtadByFile.set(filePath, data);
}

const PRIMITIVE_AND_PLACEHOLDER_TYPES = new Set([
  'auto',
  'decltype(auto)',
  'void',
  'bool',
  'char',
  'wchar_t',
  'char8_t',
  'char16_t',
  'char32_t',
  'short',
  'int',
  'long',
  'signed',
  'unsigned',
  'float',
  'double',
  'size_t',
  'ptrdiff_t',
  'nullptr_t',
]);

const STL_HOMOGENEOUS_CONTAINERS = new Set([
  'vector',
  'deque',
  'list',
  'forward_list',
  'set',
  'multiset',
  'unordered_set',
  'unordered_multiset',
]);

/**
 * Infer homogeneous/positional template arguments for a local declaration AST
 * statement (`std::vector v{1, 2, 3};` or in-file template `Box b{42};`), used
 * when `v` is immediately passed into a function call `g(v)` in the same file.
 */
export function inferLocalCppCtadTemplateArguments(
  declStmt: SyntaxNode,
  getInFileTemplateClassNames: () => ReadonlySet<string>,
  lookupIdentifierSpelling: (identNode: SyntaxNode) => string,
): string[] | undefined {
  const typeNode = declStmt.childForFieldName('type');
  const declarator = declStmt.childForFieldName('declarator');
  if (typeNode === null || declarator === null || declarator.type !== 'init_declarator') {
    return undefined;
  }
  const writtenType = typeNode.text.trim();
  if (writtenType.includes('<') || PRIMITIVE_AND_PLACEHOLDER_TYPES.has(writtenType)) {
    return undefined;
  }
  const parsedInit = extractDeclarationCtadInit(writtenType, declarator);
  if (parsedInit === null || parsedInit.argNodes.length === 0) return undefined;

  const args = parsedInit.argNodes.map((n) => classifyCtadArgNode(n, lookupIdentifierSpelling));
  if (args.some((a) => !a.known)) return undefined;

  const { qualifier, tail } = splitQualifier(writtenType);
  if ((qualifier === 'std' || qualifier === '') && STL_HOMOGENEOUS_CONTAINERS.has(tail)) {
    const first = args[0].typeSpelling;
    return args.every((a) => a.typeSpelling === first) ? [first] : undefined;
  }
  if ((qualifier === 'std' || qualifier === '') && tail === 'optional' && args.length === 1) {
    return [args[0].typeSpelling];
  }
  if ((qualifier === 'std' || qualifier === '') && tail === 'pair' && args.length === 2) {
    return [args[0].typeSpelling, args[1].typeSpelling];
  }
  if ((qualifier === 'std' || qualifier === '') && tail === 'tuple' && args.length >= 1) {
    return args.map((a) => a.typeSpelling);
  }
  if (getInFileTemplateClassNames().has(tail)) {
    // Same-file template class: attach single-arg or homogeneous braced-init / positional args.
    if (args.length === 1) return [args[0].typeSpelling];
    if (parsedInit.isBracedInit && args.every((a) => a.typeSpelling === args[0].typeSpelling)) {
      return [args[0].typeSpelling];
    }
    return args.map((a) => a.typeSpelling);
  }
  return undefined;
}

const CTAD_WALK_CONTAINERS: ReadonlySet<string> = new Set([
  'translation_unit',
  'namespace_definition',
  'declaration_list',
  'linkage_specification',
  'preproc_if',
  'preproc_ifdef',
  'preproc_elif',
  'preproc_elifdef',
  'preproc_else',
  'template_declaration',
  'class_specifier',
  'struct_specifier',
  'field_declaration_list',
  'function_definition',
  'compound_statement',
  'if_statement',
  'for_statement',
  'for_range_loop',
  'while_statement',
  'do_statement',
  'switch_statement',
  'case_statement',
  'try_statement',
  'catch_clause',
  'lambda_expression',
]);

/**
 * Walk `root` once during `emitCppScopeCaptures` to record CTAD sites,
 * primary class template constructor/aggregate shapes, and deduction guides.
 */
export function captureCppCtadFacts(
  root: SyntaxNode,
  filePath: string,
  lookupIdentifierSpelling: (identNode: SyntaxNode) => string,
): void {
  const sites: CppCtadSiteFact[] = [];
  const classShapes: CppClassCtadShapeFact[] = [];
  const deductionGuides: CppDeductionGuideFact[] = [];

  // Pre-order walk over statement/scope containers only (skipping expression
  // subtrees, enums, and anonymous punctuation tokens for O(declarations) cost).
  const stack: Array<{ node: SyntaxNode; ns: string }> = [{ node: root, ns: '' }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    const { node, ns } = frame;

    if (node.type === 'namespace_definition') {
      const nameNode = node.childForFieldName('name');
      const seg = nameNode !== null ? nameNode.text.replace(/::/g, '.').trim() : '';
      const nextNs = seg.length === 0 ? ns : ns.length === 0 ? seg : `${ns}.${seg}`;
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const c = node.namedChild(i);
        if (c !== null && CTAD_WALK_CONTAINERS.has(c.type)) stack.push({ node: c, ns: nextNs });
      }
      continue;
    }

    if (node.type === 'template_declaration') {
      const paramList = firstDirectChild(node, 'template_parameter_list');
      const { params, defaults } = extractTemplateParamsAndDefaults(paramList);

      // 1. Primary class/struct template shape.
      const classSpec =
        firstDirectChild(node, 'class_specifier') ?? firstDirectChild(node, 'struct_specifier');
      if (classSpec !== null) {
        const nameNode = classSpec.childForFieldName('name');
        if (nameNode !== null && nameNode.type === 'type_identifier' && params.length > 0) {
          classShapes.push(extractClassCtadShape(classSpec, nameNode.text, ns, params, defaults));
        }
      }

      // 2. Templated deduction guide (`template<class T> Box(T) -> Box<T>;`).
      const declChild = firstDirectChild(node, 'declaration');
      if (declChild !== null && declChild.childForFieldName('type') === null) {
        const guide = extractDeductionGuideFromNode(declChild, ns, params);
        if (guide !== null) {
          deductionGuides.push(guide);
          continue;
        }
      }
    }

    // 3. Non-templated deduction guide: either `declaration` with no `type` or
    // tree-sitter-cpp's `ERROR` recovery around `ClassName(params) -> ClassName<Args>;`.
    if (
      (node.type === 'declaration' && node.childForFieldName('type') === null) ||
      node.type === 'ERROR'
    ) {
      if (node.parent?.type !== 'template_declaration') {
        const guide = extractDeductionGuideFromNode(node, ns, []);
        if (guide !== null) {
          deductionGuides.push(guide);
          continue;
        }
      }
    }

    // 4. Variable declaration CTAD candidate (`Box b{1}`, `auto b = Box{1}`, `std::vector v{1,2}`).
    if (node.type === 'declaration') {
      collectDeclarationCtadSites(node, lookupIdentifierSpelling, sites);
      continue;
    }

    if (!CTAD_WALK_CONTAINERS.has(node.type)) continue;
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const c = node.namedChild(i);
      if (
        c !== null &&
        (CTAD_WALK_CONTAINERS.has(c.type) || c.type === 'declaration' || c.type === 'ERROR')
      ) {
        stack.push({ node: c, ns });
      }
    }
  }

  applyCppCtadSideChannel(filePath, { sites, classShapes, deductionGuides });
}

function collectDeclarationCtadSites(
  declNode: SyntaxNode,
  lookupIdentifierSpelling: (identNode: SyntaxNode) => string,
  out: CppCtadSiteFact[],
): void {
  const typeNode = declNode.childForFieldName('type');
  if (typeNode === null) return;

  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child === null || child.type !== 'init_declarator') continue;

    const parsed = extractCtadCandidate(typeNode, child);
    if (parsed === null) continue;

    // Resolving prior same-scope CTAD variables (e.g. `Box b1{42}; Box b2{b1};`)
    // happens naturally when `b1` is concrete or handled at workspace pass; here
    // classify each argument AST node conservatively.
    const args = parsed.argNodes.map((argNode) =>
      classifyCtadArgNode(argNode, lookupIdentifierSpelling),
    );
    out.push({
      varName: parsed.varName,
      writtenType: parsed.writtenType,
      declRange: nodeRange(declNode),
      isBracedInit: parsed.isBracedInit,
      args,
    });
  }
}

function extractCtadCandidate(
  typeNode: SyntaxNode,
  initDeclarator: SyntaxNode,
): {
  varName: string;
  writtenType: string;
  argNodes: SyntaxNode[];
  isBracedInit: boolean;
} | null {
  const declField = initDeclarator.childForFieldName('declarator');
  if (declField === null) return null;

  // `auto b = Box{1}` / `auto b = Box(1)` / `auto* p = new Box(1)`
  if (typeNode.type === 'placeholder_type_specifier') {
    const varName = unwrapPlainOrPointerDeclaratorName(declField);
    if (varName === null) return null;
    const valueNode = initDeclarator.childForFieldName('value');
    if (valueNode === null) return null;

    if (valueNode.type === 'compound_literal_expression') {
      const rhsType = valueNode.childForFieldName('type');
      const initList = valueNode.childForFieldName('value');
      if (rhsType === null || initList === null) return null;
      const writtenType = rhsType.text.trim();
      if (!isBareOrQualifiedClassType(rhsType, writtenType)) return null;
      return {
        varName,
        writtenType,
        argNodes: listArgumentNodes(initList),
        isBracedInit: true,
      };
    }

    if (valueNode.type === 'call_expression') {
      const fnNode = valueNode.childForFieldName('function');
      const argList = valueNode.childForFieldName('arguments');
      if (fnNode === null || argList === null) return null;
      if (fnNode.type !== 'identifier' && fnNode.type !== 'qualified_identifier') return null;
      const writtenType = fnNode.text.trim();
      if (writtenType.includes('<') || PRIMITIVE_AND_PLACEHOLDER_TYPES.has(writtenType)) {
        return null;
      }
      return {
        varName,
        writtenType,
        argNodes: listArgumentNodes(argList),
        isBracedInit: false,
      };
    }

    if (valueNode.type === 'new_expression') {
      const newType = valueNode.childForFieldName('type');
      const argList =
        valueNode.childForFieldName('arguments') ?? firstDirectChild(valueNode, 'initializer_list');
      if (newType === null || argList === null) return null;
      const writtenType = newType.text.trim();
      if (!isBareOrQualifiedClassType(newType, writtenType)) return null;
      return {
        varName,
        writtenType,
        argNodes: listArgumentNodes(argList),
        isBracedInit: argList.type === 'initializer_list',
      };
    }

    return null;
  }

  // `Box b{1}` / `Box b(1)` / `Box b = {1}` / `std::vector v{1, 2, 3}` / `ns::Box b{1}`
  if (declField.type !== 'identifier') return null;
  const writtenType = typeNode.text.trim();
  if (!isBareOrQualifiedClassType(typeNode, writtenType)) return null;

  const init = extractDeclarationCtadInit(writtenType, initDeclarator);
  if (init === null) return null;
  return {
    varName: declField.text,
    writtenType,
    argNodes: init.argNodes,
    isBracedInit: init.isBracedInit,
  };
}

function extractDeclarationCtadInit(
  writtenType: string,
  initDeclarator: SyntaxNode,
): { argNodes: SyntaxNode[]; isBracedInit: boolean } | null {
  const valueNode = initDeclarator.childForFieldName('value');
  if (valueNode === null) return null;

  if (valueNode.type === 'initializer_list') {
    return { argNodes: listArgumentNodes(valueNode), isBracedInit: true };
  }
  if (valueNode.type === 'argument_list') {
    return { argNodes: listArgumentNodes(valueNode), isBracedInit: false };
  }
  if (valueNode.type === 'compound_literal_expression') {
    const rhsType = valueNode.childForFieldName('type')?.text.trim();
    const initList = valueNode.childForFieldName('value');
    if (initList === null || (rhsType !== undefined && rhsType !== writtenType)) return null;
    return { argNodes: listArgumentNodes(initList), isBracedInit: true };
  }
  if (valueNode.type === 'call_expression') {
    const callee = valueNode.childForFieldName('function')?.text.trim();
    const argList = valueNode.childForFieldName('arguments');
    if (argList === null || callee !== writtenType) return null;
    return { argNodes: listArgumentNodes(argList), isBracedInit: false };
  }
  return null;
}

function isBareOrQualifiedClassType(typeNode: SyntaxNode, writtenType: string): boolean {
  if (typeNode.type !== 'type_identifier' && typeNode.type !== 'qualified_identifier') {
    return false;
  }
  if (writtenType.includes('<') || PRIMITIVE_AND_PLACEHOLDER_TYPES.has(writtenType)) {
    return false;
  }
  return true;
}

function unwrapPlainOrPointerDeclaratorName(decl: SyntaxNode): string | null {
  let cur: SyntaxNode | null = decl;
  let hops = 4;
  while (cur !== null && hops-- > 0) {
    if (cur.type === 'identifier') return cur.text;
    if (cur.type === 'pointer_declarator' || cur.type === 'reference_declarator') {
      cur = cur.childForFieldName('declarator') ?? cur.namedChild(0);
      continue;
    }
    return null;
  }
  return null;
}

function listArgumentNodes(listNode: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (child === null) continue;
    if (
      child.type === ',' ||
      child.type === '(' ||
      child.type === ')' ||
      child.type === '{' ||
      child.type === '}'
    ) {
      continue;
    }
    out.push(child);
  }
  return out;
}

function classifyCtadArgNode(
  node: SyntaxNode,
  lookupIdentifierSpelling: (identNode: SyntaxNode) => string,
): CppCtadArgFact {
  // Unwrap redundant parens `(42)` -> `42`.
  let cur = node;
  let depth = 4;
  while (cur.type === 'parenthesized_expression' && depth-- > 0) {
    const inner = cur.namedChild(0);
    if (inner === null) break;
    cur = inner;
  }

  switch (cur.type) {
    case 'number_literal': {
      const t = cur.text;
      const isFloat =
        t.includes('.') || t.includes('e') || t.includes('E') || t.endsWith('f') || t.endsWith('F');
      return { known: true, typeSpelling: isFloat ? 'double' : 'int' };
    }
    case 'char_literal':
      return { known: true, typeSpelling: 'char' };
    case 'true':
    case 'false':
      return { known: true, typeSpelling: 'bool' };
    case 'string_literal':
    case 'raw_string_literal':
    case 'concatenated_string':
      return { known: true, typeSpelling: 'string', isStringLiteral: true };
    case 'null':
    case 'nullptr':
      return { known: true, typeSpelling: 'nullptr_t' };
    case 'identifier': {
      const spelling = lookupIdentifierSpelling(cur);
      if (spelling === '' || spelling === 'auto' || spelling === 'unknown') {
        return { known: false, typeSpelling: '', identName: cur.text };
      }
      // Reference expressions denote lvalues of the referenced type (`int& r` -> `int`).
      const strippedRef = spelling.replace(/&+\s*$/, '').trim();
      return strippedRef.length > 0
        ? { known: true, typeSpelling: strippedRef, identName: cur.text }
        : { known: false, typeSpelling: '', identName: cur.text };
    }
    case 'unary_expression': {
      const op = cur.childForFieldName('operator') ?? cur.child(0);
      const operand = cur.childForFieldName('argument') ?? cur.namedChild(cur.namedChildCount - 1);
      if (op?.text === '&' && operand?.type === 'identifier') {
        const base = lookupIdentifierSpelling(operand)
          .replace(/&+\s*$/, '')
          .trim();
        if (base !== '' && base !== 'auto' && base !== 'unknown') {
          return { known: true, typeSpelling: `${base}*` };
        }
      }
      if (
        (op?.text === '-' || op?.text === '+') &&
        operand !== null &&
        operand.type === 'number_literal'
      ) {
        return classifyCtadArgNode(operand, lookupIdentifierSpelling);
      }
      return { known: false, typeSpelling: '' };
    }
    case 'compound_literal_expression': {
      const tNode = cur.childForFieldName('type');
      if (tNode !== null && tNode.text.trim().length > 0) {
        const tText = tNode.text.trim();
        // Nested un-instantiated CTAD temporary (`Outer{Inner{1}}`) has no concrete `<...>`;
        // concrete `Widget{}` or `Box<int>{1}` is only safe when `tNode` has `<...>` or we
        // verify at workspace pass, so accept when it parses as a concrete type term.
        if (parseCppTypeTerm(tText) !== null) {
          return { known: true, typeSpelling: tText };
        }
      }
      return { known: false, typeSpelling: '' };
    }
    default:
      return { known: false, typeSpelling: '' };
  }
}

function extractTemplateParamsAndDefaults(paramList: SyntaxNode | null): {
  params: string[];
  defaults: { [paramName: string]: string };
} {
  const params: string[] = [];
  const defaults: { [paramName: string]: string } = {};
  if (paramList === null) return { params, defaults };

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const p = paramList.namedChild(i);
    if (p === null) continue;
    if (
      p.type === 'type_parameter_declaration' ||
      p.type === 'optional_type_parameter_declaration' ||
      p.type === 'variadic_type_parameter_declaration'
    ) {
      const id = firstDescendant(p, 'type_identifier');
      if (id !== null) {
        params.push(id.text);
        if (p.type === 'optional_type_parameter_declaration') {
          const defVal = p.childForFieldName('default_type');
          if (defVal !== null && defVal.text.trim().length > 0) {
            defaults[id.text] = defVal.text.trim();
          }
        }
      }
    } else if (p.type === 'parameter_declaration' || p.type === 'optional_parameter_declaration') {
      const decl = p.childForFieldName('declarator');
      const id = decl !== null ? firstDescendant(decl, 'identifier') : null;
      if (id !== null) {
        params.push(id.text);
        if (p.type === 'optional_parameter_declaration') {
          const defVal = p.childForFieldName('default_value');
          if (defVal !== null && defVal.text.trim().length > 0) {
            defaults[id.text] = defVal.text.trim();
          }
        }
      }
    }
  }
  return { params, defaults };
}

function extractClassCtadShape(
  classSpec: SyntaxNode,
  className: string,
  enclosingNamespace: string,
  templateParams: readonly string[],
  templateParamDefaults: { readonly [paramName: string]: string },
): CppClassCtadShapeFact {
  const constructors: CppCtorPatternFact[] = [];
  const aggregateFieldTypes: string[] = [];
  const body =
    classSpec.childForFieldName('body') ?? firstDirectChild(classSpec, 'field_declaration_list');

  if (body !== null) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (member === null) continue;

      if (
        member.type === 'function_definition' ||
        member.type === 'declaration' ||
        member.type === 'field_declaration'
      ) {
        const fnDecl = firstDirectChild(member, 'function_declarator');
        if (fnDecl !== null) {
          const declLeaf = fnDecl.childForFieldName('declarator');
          if (declLeaf !== null && declLeaf.text.trim() === className) {
            // Skip deleted constructors (`Box(int) = delete;`).
            if (firstDirectChild(member, 'delete_method_clause') !== null) continue;
            const ctor = extractParamPatternsFromFunctionDeclarator(fnDecl);
            if (ctor !== null && !isCopyOrMoveConstructor(className, ctor.paramPatterns)) {
              constructors.push(ctor);
            }
          }
          continue;
        }
      }

      if (member.type === 'field_declaration') {
        if (hasStaticSpecifier(member)) continue;
        const fieldType = member.childForFieldName('type');
        if (fieldType === null) continue;
        for (let j = 0; j < member.namedChildCount; j++) {
          const sub = member.namedChild(j);
          if (sub === null || sub === fieldType || sub.type === 'type_qualifier') continue;
          if (sub.type === 'field_identifier' || sub.type.endsWith('_declarator')) {
            aggregateFieldTypes.push(formatMemberOrParamSpelling(member, fieldType, sub));
          }
        }
      }
    }
  }

  return {
    className,
    enclosingNamespace,
    templateParams,
    templateParamDefaults,
    constructors,
    aggregateFieldTypes,
  };
}

function isCopyOrMoveConstructor(className: string, paramPatterns: readonly string[]): boolean {
  if (paramPatterns.length !== 1) return false;
  const term = parseCppTypeTerm(paramPatterns[0]);
  if (term === null || (term.kind !== 'lvalue-ref' && term.kind !== 'rvalue-ref')) return false;
  const target = term.target;
  return (target.kind === 'named' || target.kind === 'app') && target.name === className;
}

function extractDeductionGuideFromNode(
  node: SyntaxNode,
  enclosingNamespace: string,
  templateParams: readonly string[],
): CppDeductionGuideFact | null {
  const fnDecl = firstDirectChild(node, 'function_declarator');
  if (fnDecl === null) return null;
  const trailing = firstDirectChild(fnDecl, 'trailing_return_type');
  if (trailing === null) return null;

  const declNameNode = fnDecl.childForFieldName('declarator');
  if (declNameNode === null) return null;
  const guideName = splitQualifier(declNameNode.text.trim()).tail;
  if (!/^[A-Za-z_]\w*$/.test(guideName)) return null;

  const returnTypeDesc = trailing.firstNamedChild;
  if (returnTypeDesc === null) return null;
  const returnTerm = parseCppTypeTerm(returnTypeDesc.text.trim());
  if (returnTerm === null || returnTerm.kind !== 'app' || returnTerm.name !== guideName) {
    return null;
  }

  const ctorParams = extractParamPatternsFromFunctionDeclarator(fnDecl);
  if (ctorParams === null) return null;

  return {
    className: guideName,
    enclosingNamespace,
    templateParams,
    paramPatterns: ctorParams.paramPatterns,
    requiredParamCount: ctorParams.requiredParamCount,
    targetTemplateArgs: returnTerm.args.map(canonicalCppTypeTerm),
  };
}

function extractParamPatternsFromFunctionDeclarator(fnDecl: SyntaxNode): CppCtorPatternFact | null {
  const paramList = fnDecl.childForFieldName('parameters');
  if (paramList === null) return null;

  const paramPatterns: string[] = [];
  let requiredParamCount = 0;

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const p = paramList.namedChild(i);
    if (p === null) continue;
    if (p.type === 'variadic_parameter_declaration') return null;
    if (p.type !== 'parameter_declaration' && p.type !== 'optional_parameter_declaration') {
      continue;
    }
    const typeNode = p.childForFieldName('type');
    if (typeNode === null) return null;
    if (
      paramList.namedChildCount === 1 &&
      p.type === 'parameter_declaration' &&
      typeNode.text.trim() === 'void' &&
      p.childForFieldName('declarator') === null
    ) {
      return { paramPatterns: [], requiredParamCount: 0 };
    }
    const declaratorNode = p.childForFieldName('declarator');
    paramPatterns.push(formatMemberOrParamSpelling(p, typeNode, declaratorNode));
    if (p.type === 'parameter_declaration') requiredParamCount++;
  }

  return { paramPatterns, requiredParamCount };
}

function formatMemberOrParamSpelling(
  containerNode: SyntaxNode,
  typeNode: SyntaxNode,
  declaratorNode: SyntaxNode | null,
): string {
  const quals: string[] = [];
  for (let i = 0; i < containerNode.childCount; i++) {
    const c = containerNode.child(i);
    if (c !== null && c.type === 'type_qualifier') {
      const t = c.text.trim();
      if (t === 'const' || t === 'volatile') quals.push(t);
    }
  }
  const prefix = quals.length > 0 ? `${quals.join(' ')} ` : '';
  const suffix = declaratorNode !== null ? extractDeclaratorTypeSuffix(declaratorNode) : '';
  return `${prefix}${typeNode.text.trim()}${suffix}`.trim();
}

function extractDeclaratorTypeSuffix(decl: SyntaxNode): string {
  // Strip any leaf identifier name from `pointer_declarator` / `reference_declarator` / `array_declarator`
  // while keeping `*`, `const`, `&`, `&&`, and `[N]`.
  let cur: SyntaxNode | null = decl;
  const wrappers: string[] = [];
  let safety = 8;
  while (cur !== null && safety-- > 0) {
    if (
      cur.type === 'identifier' ||
      cur.type === 'field_identifier' ||
      cur.type === 'type_identifier'
    ) {
      break;
    }
    if (cur.type === 'pointer_declarator' || cur.type === 'abstract_pointer_declarator') {
      let ptr = '*';
      for (let i = 0; i < cur.childCount; i++) {
        const c = cur.child(i);
        if (c !== null && c.type === 'type_qualifier') ptr += ` ${c.text.trim()}`;
      }
      wrappers.unshift(ptr);
      cur = cur.childForFieldName('declarator') ?? cur.namedChild(cur.namedChildCount - 1);
      continue;
    }
    if (cur.type === 'reference_declarator' || cur.type === 'abstract_reference_declarator') {
      const refTok = cur.text.trim().startsWith('&&') ? '&&' : '&';
      wrappers.unshift(refTok);
      cur = cur.childForFieldName('declarator') ?? cur.namedChild(0);
      continue;
    }
    if (cur.type === 'array_declarator' || cur.type === 'abstract_array_declarator') {
      const size = cur.childForFieldName('size')?.text.trim() ?? '';
      wrappers.push(`[${size}]`);
      cur = cur.childForFieldName('declarator') ?? cur.namedChild(0);
      continue;
    }
    break;
  }
  return wrappers.join('');
}

function hasStaticSpecifier(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && c.type === 'storage_class_specifier' && c.text === 'static') return true;
  }
  return false;
}

function firstDirectChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && c.type === type) return c;
  }
  return null;
}

function firstDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c === null) continue;
    const hit = firstDescendant(c, type);
    if (hit !== null) return hit;
  }
  return null;
}

function nodeRange(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function splitQualifier(text: string): { qualifier: string; tail: string } {
  const clean = text.startsWith('::') ? text.slice(2).trim() : text.trim();
  const idx = clean.lastIndexOf('::');
  if (idx < 0) return { qualifier: '', tail: clean };
  return {
    qualifier: clean.slice(0, idx).replace(/\s+/g, '').replace(/::/g, '.'),
    tail: clean.slice(idx + 2).trim(),
  };
}

// ─── Workspace CTAD Synthesis Pass ─────────────────────────────────────────

const comparePos = (
  a: Pick<Range, 'startLine' | 'startCol'>,
  b: Pick<Range, 'startLine' | 'startCol'>,
): number => a.startLine - b.startLine || a.startCol - b.startCol;

const rangeContains = (outer: Range, inner: Range): boolean =>
  comparePos(outer, inner) <= 0 &&
  comparePos(
    { startLine: inner.endLine, startCol: inner.endCol },
    { startLine: outer.endLine, startCol: outer.endCol },
  ) <= 0;

/**
 * Synthesize `Type<DeducedArgs...>` onto `Scope.typeBindings` for C++ CTAD
 * declarations across `parsedFiles`.
 */
export function populateCppCtadBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const allShapesByName = new Map<string, CppClassCtadShapeFact[]>();
  const allGuidesByName = new Map<string, CppDeductionGuideFact[]>();

  let anySites = false;
  for (const parsed of parsedFiles) {
    const facts = capturedCtadByFile.get(parsed.filePath);
    if (facts === undefined) continue;
    if (facts.sites.length > 0) anySites = true;
    for (const shape of facts.classShapes) {
      const bucket = allShapesByName.get(shape.className) ?? [];
      bucket.push(shape);
      allShapesByName.set(shape.className, bucket);
    }
    for (const guide of facts.deductionGuides) {
      const bucket = allGuidesByName.get(guide.className) ?? [];
      bucket.push(guide);
      allGuidesByName.set(guide.className, bucket);
    }
  }
  if (!anySites) return;

  for (const parsed of parsedFiles) {
    const facts = capturedCtadByFile.get(parsed.filePath);
    if (facts === undefined || facts.sites.length === 0) continue;

    // Resolve sites in declaration order so a subsequent local CTAD variable
    // (`Box b1{42}; Box b2{b1};`) can read `b1`'s synthesized type from scope.
    const scopeById = new Map<ScopeId, Scope>(parsed.scopes.map((s) => [s.id, s]));
    for (const site of facts.sites) {
      const hostScope = findTargetBindingScope(
        parsed.scopes,
        scopeById,
        site.declRange,
        site.varName,
      );
      if (hostScope === undefined) continue;

      const resolvedArgs = site.args.map((arg) => resolveArgFromScopeIfNeeded(arg, hostScope));
      if (resolvedArgs.some((arg) => !arg.known)) {
        // Negative control (#1896 DoD): any unknown argument suppresses CTAD
        // synthesis so the variable stays bound to the primary template.
        continue;
      }

      const deducedArgs = deduceClassTemplateArguments(
        site,
        resolvedArgs,
        hostScope,
        indexes,
        allShapesByName,
        allGuidesByName,
      );
      if (deducedArgs === undefined || deducedArgs.length === 0) continue;

      const fullSpelling = `${site.writtenType}<${deducedArgs.join(', ')}>`;
      const normalized = normalizeCppTypeName(fullSpelling);
      const bindings = hostScope.typeBindings as Map<string, TypeRef>;
      const existing = bindings.get(site.varName);
      bindings.set(site.varName, {
        rawName: normalized,
        declaredAtScope: existing?.declaredAtScope ?? hostScope.id,
        lookupPosition: existing?.lookupPosition ?? {
          startLine: site.declRange.startLine,
          startCol: site.declRange.startCol,
        },
        lookupPurpose: existing?.lookupPurpose ?? 'value',
        ...(existing?.bindingRange !== undefined ? { bindingRange: existing.bindingRange } : {}),
        source: existing?.source ?? 'constructor-inferred',
      });
    }
  }
}

function resolveArgFromScopeIfNeeded(arg: CppCtadArgFact, scope: Scope): CppCtadArgFact {
  if (arg.identName !== undefined && (!arg.known || !arg.typeSpelling.includes('<'))) {
    const bound = scope.typeBindings.get(arg.identName)?.rawName;
    if (bound !== undefined && bound.includes('<')) {
      return { known: true, typeSpelling: bound, identName: arg.identName };
    }
  }
  return arg;
}

function findTargetBindingScope(
  scopes: readonly Scope[],
  scopeById: ReadonlyMap<ScopeId, Scope>,
  target: Range,
  varName: string,
): Scope | undefined {
  let innermost: Scope | undefined;
  for (const s of scopes) {
    if (s.kind === 'Class') continue;
    if (!rangeContains(s.range, target)) continue;
    if (innermost === undefined || rangeContains(innermost.range, s.range)) {
      innermost = s;
    }
  }
  if (innermost === undefined) return undefined;

  // `cppBindingScopeFor` hoists function-body variable bindings onto the
  // enclosing `Function` scope; update the scope that already owns `varName`
  // (or the enclosing `Function` scope) rather than leaving a stale bare
  // binding above an inner `Block`.
  let cur: Scope | undefined = innermost;
  while (cur !== undefined) {
    if (cur.typeBindings.has(varName)) return cur;
    if (cur.kind === 'Function' || cur.kind === 'Namespace' || cur.kind === 'Module') break;
    cur = cur.parent === null ? undefined : scopeById.get(cur.parent);
  }
  return innermost;
}

function deduceClassTemplateArguments(
  site: CppCtadSiteFact,
  args: readonly CppCtadArgFact[],
  hostScope: Scope,
  indexes: ScopeResolutionIndexes,
  allShapesByName: ReadonlyMap<string, readonly CppClassCtadShapeFact[]>,
  allGuidesByName: ReadonlyMap<string, readonly CppDeductionGuideFact[]>,
): readonly string[] | undefined {
  const { qualifier, tail: className } = splitQualifier(site.writtenType);
  const enclosingNs = enclosingNamespacePath(hostScope.id, indexes);

  // Locate class-like definitions in the workspace matching `(qualifier, className)`.
  const matchingDefs = findCandidateClassDefs(className, qualifier, enclosingNs, indexes);
  const shapes = filterByNamespace(allShapesByName.get(className) ?? [], qualifier, enclosingNs);
  const guides = filterByNamespace(allGuidesByName.get(className) ?? [], qualifier, enclosingNs);

  const isKnownTemplateInWorkspace =
    shapes.length > 0 ||
    guides.length > 0 ||
    matchingDefs.some(
      (d) =>
        (d.typeParameters !== undefined && d.typeParameters.length > 0) ||
        (d.templateArguments !== undefined && d.templateArguments.length > 0),
    );

  if (!isKnownTemplateInWorkspace) {
    // Non-template workspace class (`User u("alice")`) — never attach template arguments.
    if (matchingDefs.length > 0) return undefined;
    // External / standard-library CTAD (`std::vector v{1, 2, 3}`).
    return deduceExternalStlCtad(qualifier, className, args);
  }

  // 1. Copy-deduction candidate (`Box<int> b1; Box b2{b1};` -> `Box<int>`).
  if (args.length === 1) {
    const argTerm = parseCppTypeTerm(args[0].typeSpelling);
    if (argTerm !== null && argTerm.kind === 'app' && argTerm.name === className) {
      return argTerm.args.map(canonicalCppTypeTerm);
    }
  }

  // 2. Explicit user-defined deduction guides (`ClassName(params) -> ClassName<Args>`).
  if (guides.length > 0) {
    const fromGuides = deduceFromGuides(guides, args);
    if (fromGuides === 'ambiguous') return undefined;
    if (fromGuides !== undefined) return fromGuides;
  }

  if (args.length === 0) {
    // Zero-arg construction with defaults on all template parameters (`Box b{};`).
    const primaryShape = shapes[0];
    if (primaryShape !== undefined && primaryShape.templateParams.length > 0) {
      const filled = fillTemplateArgs(
        primaryShape.templateParams,
        new Map(),
        primaryShape.templateParamDefaults,
      );
      return filled;
    }
    return undefined;
  }

  // 3. Primary template constructors & aggregate fields.
  const primaryShape = shapes.length === 1 ? shapes[0] : undefined;
  if (primaryShape !== undefined) {
    if (primaryShape.constructors.length > 0) {
      const fromCtors = deduceFromConstructors(
        primaryShape.templateParams,
        primaryShape.templateParamDefaults,
        primaryShape.constructors,
        args,
      );
      if (fromCtors === 'ambiguous') return undefined;
      if (fromCtors !== undefined) return fromCtors;
    }

    if (
      primaryShape.constructors.length === 0 &&
      primaryShape.aggregateFieldTypes.length >= args.length
    ) {
      const bindings = new Map<string, CppTypeTerm>();
      const paramSet = new Set(primaryShape.templateParams);
      let ok = true;
      for (let i = 0; i < args.length; i++) {
        if (
          !unifyCppTypePattern(
            primaryShape.aggregateFieldTypes[i],
            args[i].typeSpelling,
            paramSet,
            bindings,
            { adjustCallParam: true },
          )
        ) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const filled = fillTemplateArgs(
          primaryShape.templateParams,
          bindings,
          primaryShape.templateParamDefaults,
        );
        if (filled !== undefined) return filled;
      }
    }

    // Minimal template struct stub (no explicit ctors and no fields declared in body):
    // synthesize positional args when arity matches `templateParams.length`, or homogeneous
    // element type for single-param braced-init (`Vec v{1, 2, 3}`).
    if (primaryShape.constructors.length === 0 && primaryShape.aggregateFieldTypes.length === 0) {
      return deducePositionalFallback(primaryShape.templateParams.length, site.isBracedInit, args);
    }
    return undefined;
  }

  // Primary def from `indexes` when `shapes` had none (e.g. forward-declared primary + specializations).
  const primaryDef = matchingDefs.find(
    (d) =>
      d.typeParameters !== undefined &&
      d.typeParameters.length > 0 &&
      (d.templateArguments === undefined || d.templateArguments.length === 0),
  );
  if (primaryDef?.typeParameters !== undefined) {
    return deducePositionalFallback(primaryDef.typeParameters.length, site.isBracedInit, args);
  }
  return undefined;
}

function deducePositionalFallback(
  templateArity: number,
  isBracedInit: boolean,
  args: readonly CppCtadArgFact[],
): readonly string[] | undefined {
  if (templateArity <= 0) return undefined;
  if (args.length === templateArity) {
    return args.map((a) => a.typeSpelling);
  }
  if (
    templateArity === 1 &&
    isBracedInit &&
    args.length > 1 &&
    args.every((a) => a.typeSpelling === args[0].typeSpelling)
  ) {
    return [args[0].typeSpelling];
  }
  return undefined;
}

function deduceExternalStlCtad(
  qualifier: string,
  className: string,
  args: readonly CppCtadArgFact[],
): readonly string[] | undefined {
  if (args.length === 0) return undefined;
  if (qualifier !== 'std' && qualifier !== '') return undefined;

  if (STL_HOMOGENEOUS_CONTAINERS.has(className)) {
    const first = args[0].typeSpelling;
    return args.every((a) => a.typeSpelling === first) ? [first] : undefined;
  }
  if (className === 'optional' && args.length === 1) {
    return [args[0].typeSpelling];
  }
  if (className === 'pair' && args.length === 2) {
    return [args[0].typeSpelling, args[1].typeSpelling];
  }
  if (className === 'tuple') {
    return args.map((a) => a.typeSpelling);
  }
  if (className === 'array') {
    const first = args[0].typeSpelling;
    return args.every((a) => a.typeSpelling === first) ? [first, String(args.length)] : undefined;
  }
  return undefined;
}

function deduceFromGuides(
  guides: readonly CppDeductionGuideFact[],
  args: readonly CppCtadArgFact[],
): readonly string[] | 'ambiguous' | undefined {
  const nonTemplateResults: Array<readonly string[]> = [];
  const templateResults: Array<{
    guide: CppDeductionGuideFact;
    targetArgs: readonly string[];
  }> = [];

  for (const guide of guides) {
    if (args.length < guide.requiredParamCount || args.length > guide.paramPatterns.length) {
      continue;
    }

    if (guide.templateParams.length === 0) {
      if (nonTemplateGuideMatches(guide.paramPatterns, args)) {
        nonTemplateResults.push(guide.targetTemplateArgs);
      }
      continue;
    }

    const paramSet = new Set(guide.templateParams);
    const bindings = new Map<string, CppTypeTerm>();
    let ok = true;
    for (let i = 0; i < args.length; i++) {
      if (!matchParamAgainstCtadArg(guide.paramPatterns[i], args[i], paramSet, bindings)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const substituted: string[] = [];
    for (const targetArg of guide.targetTemplateArgs) {
      const sub = substituteBindingsInRawType(targetArg, paramSet, bindings);
      if (sub === null) {
        ok = false;
        break;
      }
      substituted.push(sub);
    }
    if (ok) templateResults.push({ guide, targetArgs: substituted });
  }

  // Non-template deduction guides outrank template deduction guides (`[over.match.best]/2`).
  if (nonTemplateResults.length === 1) return nonTemplateResults[0];
  if (nonTemplateResults.length > 1) {
    return allTargetVectorsEqual(nonTemplateResults) ? nonTemplateResults[0] : 'ambiguous';
  }

  if (templateResults.length === 0) return undefined;
  if (templateResults.length === 1) return templateResults[0].targetArgs;

  const undominated = templateResults.filter(
    (cand) =>
      !templateResults.some(
        (other) =>
          other !== cand &&
          isCppPatternMoreSpecialized(
            other.guide.paramPatterns.slice(0, args.length),
            new Set(other.guide.templateParams),
            cand.guide.paramPatterns.slice(0, args.length),
            new Set(cand.guide.templateParams),
            { adjustCallParam: true },
          ),
      ),
  );
  if (undominated.length === 1) return undominated[0].targetArgs;
  return allTargetVectorsEqual(undominated.map((u) => u.targetArgs))
    ? undominated[0].targetArgs
    : 'ambiguous';
}

function deduceFromConstructors(
  templateParams: readonly string[],
  defaults: { readonly [paramName: string]: string },
  constructors: readonly CppCtorPatternFact[],
  args: readonly CppCtadArgFact[],
): readonly string[] | 'ambiguous' | undefined {
  const paramSet = new Set(templateParams);
  const viable: Array<{ ctor: CppCtorPatternFact; deduced: readonly string[] }> = [];

  for (const ctor of constructors) {
    if (args.length < ctor.requiredParamCount || args.length > ctor.paramPatterns.length) {
      continue;
    }
    const bindings = new Map<string, CppTypeTerm>();
    let ok = true;
    for (let i = 0; i < args.length; i++) {
      if (!matchParamAgainstCtadArg(ctor.paramPatterns[i], args[i], paramSet, bindings)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const filled = fillTemplateArgs(templateParams, bindings, defaults);
    if (filled !== undefined) viable.push({ ctor, deduced: filled });
  }

  if (viable.length === 0) return undefined;
  if (viable.length === 1) return viable[0].deduced;

  const undominated = viable.filter(
    (cand) =>
      !viable.some(
        (other) =>
          other !== cand &&
          isCppPatternMoreSpecialized(
            other.ctor.paramPatterns.slice(0, args.length),
            paramSet,
            cand.ctor.paramPatterns.slice(0, args.length),
            paramSet,
            { adjustCallParam: true },
          ),
      ),
  );
  if (undominated.length === 1) return undominated[0].deduced;
  return allTargetVectorsEqual(undominated.map((u) => u.deduced))
    ? undominated[0].deduced
    : 'ambiguous';
}

function matchParamAgainstCtadArg(
  paramPattern: string,
  arg: CppCtadArgFact,
  paramSet: ReadonlySet<string>,
  bindings: Map<string, CppTypeTerm>,
): boolean {
  if (
    unifyCppTypePattern(paramPattern, arg.typeSpelling, paramSet, bindings, {
      adjustCallParam: true,
    })
  ) {
    return true;
  }
  // String literal `"abc"` decays to `const char*` in C++ (`Box(const T*)` -> `T = char`,
  // `Box(T)` -> `const char*` when primary requires pointer, or `const char*` concrete param).
  if (arg.isStringLiteral === true) {
    return unifyCppTypePattern(paramPattern, 'const char*', paramSet, bindings, {
      adjustCallParam: true,
    });
  }
  return false;
}

function nonTemplateGuideMatches(
  paramPatterns: readonly string[],
  args: readonly CppCtadArgFact[],
): boolean {
  const emptySet = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const bindings = new Map<string, CppTypeTerm>();
    if (matchParamAgainstCtadArg(paramPatterns[i], args[i], emptySet, bindings)) continue;
    return false;
  }
  return true;
}

function fillTemplateArgs(
  templateParams: readonly string[],
  bindings: ReadonlyMap<string, CppTypeTerm>,
  defaults: { readonly [paramName: string]: string },
): readonly string[] | undefined {
  const out: string[] = [];
  for (const name of templateParams) {
    const bound = bindings.get(name);
    if (bound !== undefined) {
      out.push(canonicalCppTypeTerm(bound));
      continue;
    }
    const defVal = defaults[name];
    if (defVal !== undefined) {
      out.push(defVal);
      continue;
    }
    return undefined;
  }
  return out;
}

function substituteBindingsInRawType(
  rawType: string,
  paramSet: ReadonlySet<string>,
  bindings: ReadonlyMap<string, CppTypeTerm>,
): string | null {
  const term = parseCppTypeTerm(rawType);
  if (term === null) return null;
  const sub = substituteTermBindings(term, paramSet, bindings);
  return sub === null ? null : canonicalCppTypeTerm(sub);
}

function substituteTermBindings(
  term: CppTypeTerm,
  paramSet: ReadonlySet<string>,
  bindings: ReadonlyMap<string, CppTypeTerm>,
): CppTypeTerm | null {
  switch (term.kind) {
    case 'named': {
      if (term.qualifier === '' && paramSet.has(term.name)) {
        const bound = bindings.get(term.name);
        if (bound === undefined) return null;
        if (term.cv.size === 0) return bound;
        if (bound.kind === 'named' || bound.kind === 'app' || bound.kind === 'pointer') {
          const merged = new Set(bound.cv);
          for (const f of term.cv) merged.add(f);
          return { ...bound, cv: merged };
        }
        return bound;
      }
      return term;
    }
    case 'pointer': {
      const pointee = substituteTermBindings(term.pointee, paramSet, bindings);
      return pointee === null ? null : { kind: 'pointer', pointee, cv: term.cv };
    }
    case 'lvalue-ref': {
      const target = substituteTermBindings(term.target, paramSet, bindings);
      return target === null ? null : { kind: 'lvalue-ref', target };
    }
    case 'rvalue-ref': {
      const target = substituteTermBindings(term.target, paramSet, bindings);
      return target === null ? null : { kind: 'rvalue-ref', target };
    }
    case 'array': {
      const element = substituteTermBindings(term.element, paramSet, bindings);
      if (element === null) return null;
      let bound = term.bound;
      if (bound !== null && paramSet.has(bound)) {
        const bTerm = bindings.get(bound);
        if (bTerm === undefined || bTerm.kind !== 'named') return null;
        bound = bTerm.name;
      }
      return { kind: 'array', element, bound };
    }
    case 'app': {
      const args: CppTypeTerm[] = [];
      for (const a of term.args) {
        const sa = substituteTermBindings(a, paramSet, bindings);
        if (sa === null) return null;
        args.push(sa);
      }
      return { kind: 'app', name: term.name, qualifier: term.qualifier, cv: term.cv, args };
    }
  }
}

function allTargetVectorsEqual(vectors: ReadonlyArray<readonly string[]>): boolean {
  if (vectors.length <= 1) return true;
  const first = vectors[0];
  return vectors.every(
    (v) => v.length === first.length && v.every((item, idx) => item === first[idx]),
  );
}

function enclosingNamespacePath(scopeId: ScopeId, indexes: ScopeResolutionIndexes): string {
  const parts: string[] = [];
  let cur = indexes.scopeTree.getScope(scopeId);
  const visited = new Set<ScopeId>();
  while (cur !== undefined && !visited.has(cur.id)) {
    visited.add(cur.id);
    if (cur.kind === 'Namespace') {
      const nsDef = cur.ownedDefs.find((d) => d.type === 'Namespace');
      const q = nsDef?.qualifiedName;
      if (q !== undefined) parts.unshift(q.slice(q.lastIndexOf('.') + 1));
    }
    cur = cur.parent === null ? undefined : indexes.scopeTree.getScope(cur.parent);
  }
  return parts.join('.');
}

function filterByNamespace<T extends { readonly enclosingNamespace: string }>(
  items: readonly T[],
  writtenQualifier: string,
  enclosingNs: string,
): readonly T[] {
  if (items.length === 0) return items;
  if (writtenQualifier.length > 0) {
    const exact = items.filter((it) => it.enclosingNamespace === writtenQualifier);
    if (exact.length > 0) return exact;
    if (enclosingNs.length > 0) {
      const rel = items.filter(
        (it) => it.enclosingNamespace === `${enclosingNs}.${writtenQualifier}`,
      );
      if (rel.length > 0) return rel;
    }
    return [];
  }
  if (enclosingNs.length > 0) {
    const sameNs = items.filter((it) => it.enclosingNamespace === enclosingNs);
    if (sameNs.length > 0) return sameNs;
  }
  return items.filter((it) => it.enclosingNamespace === '');
}

function findCandidateClassDefs(
  className: string,
  writtenQualifier: string,
  enclosingNs: string,
  indexes: ScopeResolutionIndexes,
): SymbolDefinition[] {
  const keys =
    writtenQualifier.length > 0
      ? enclosingNs.length > 0
        ? [`${enclosingNs}.${writtenQualifier}.${className}`, `${writtenQualifier}.${className}`]
        : [`${writtenQualifier}.${className}`]
      : enclosingNs.length > 0
        ? [`${enclosingNs}.${className}`, className]
        : [className];

  const out: SymbolDefinition[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const id of indexes.qualifiedNames.get(key)) {
      if (seen.has(id)) continue;
      const def = indexes.defs.get(id);
      if (def !== undefined && isClassLike(def.type)) {
        seen.add(id);
        out.push(def);
      }
    }
    if (out.length > 0) break;
  }
  return out;
}

/**
 * Shared emission of synthetic JVM accessor Method nodes + scope captures.
 * Language providers plan accessors; this module does not name languages.
 */
import type Parser from 'tree-sitter';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { toZeroBasedLine } from '../../utils/line-base.js';

export type SyntheticVisibility = 'public' | 'protected' | 'private' | 'package';

export interface SyntheticAccessorSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: 'Method';
  ownerId: string;
  qualifiedName: string;
  parameterCount: number;
  requiredParameterCount: number;
  parameterTypes: string[];
  returnType: string;
  visibility: SyntheticVisibility;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
}

export interface SyntheticAccessorNode {
  id: string;
  label: 'Method';
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    isExported: boolean;
    synthetic: string;
    visibility: SyntheticVisibility;
    isStatic: boolean;
    returnType: string;
    parameterTypes: string[];
    parameterCount: number;
    qualifiedName: string;
  };
}

export interface SyntheticAccessorRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'HAS_METHOD';
  confidence: number;
  reason: string;
}

export interface SyntheticAccessorResult {
  symbols: SyntheticAccessorSymbol[];
  nodes: SyntheticAccessorNode[];
  relationships: SyntheticAccessorRelationship[];
}

export interface PlannedJvmAccessor {
  kind: 'getter' | 'setter';
  name: string;
  returnType: string;
  parameterTypes: string[];
  visibility: SyntheticVisibility;
  startLine: number;
  endLine: number;
  classNode: Parser.SyntaxNode;
  declaratorNode: Parser.SyntaxNode;
}

export function emptySyntheticAccessorResult(): SyntheticAccessorResult {
  return { symbols: [], nodes: [], relationships: [] };
}

export function ownerIdNamePrefix(ownerId: string, filePath: string, fallback: string): string {
  const needle = `Class:${filePath}:`;
  if (ownerId.startsWith(needle)) return ownerId.slice(needle.length);
  const enumNeedle = `Enum:${filePath}:`;
  if (ownerId.startsWith(enumNeedle)) return ownerId.slice(enumNeedle.length);
  const ifaceNeedle = `Interface:${filePath}:`;
  if (ownerId.startsWith(ifaceNeedle)) return ownerId.slice(ifaceNeedle.length);
  return fallback;
}

export function jvmTypeSimpleName(node: Parser.SyntaxNode): string | undefined {
  const named = node.childForFieldName('name')?.text;
  if (named) return named;
  for (const child of node.namedChildren) {
    if (child.type === 'type_identifier' || child.type === 'simple_identifier') return child.text;
  }
  return undefined;
}

export function ownerQualifiedSimpleName(
  classNode: Parser.SyntaxNode,
  typeDeclTypes: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  let current: Parser.SyntaxNode | null = classNode;
  while (current) {
    if (typeDeclTypes.has(current.type)) {
      const name = jvmTypeSimpleName(current);
      if (name) parts.unshift(name);
    }
    current = current.parent;
  }
  return parts.join('.') || 'Unknown';
}

export function emitPlannedAccessors(args: {
  planned: readonly PlannedJvmAccessor[];
  filePath: string;
  ownerId: string;
  idPrefix: string;
  language: string;
  synthetic: string;
  result: SyntheticAccessorResult;
}): void {
  const emittedIds = new Set<string>();
  for (const acc of args.planned) {
    const arity = acc.parameterTypes.length;
    const qualifiedName = `${args.idPrefix}.${acc.name}`;
    const nodeId = `Method:${args.filePath}:${qualifiedName}#${arity}`;
    if (emittedIds.has(nodeId)) continue;
    emittedIds.add(nodeId);
    args.result.nodes.push({
      id: nodeId,
      label: 'Method',
      properties: {
        name: acc.name,
        filePath: args.filePath,
        startLine: toZeroBasedLine(acc.startLine),
        endLine: toZeroBasedLine(acc.endLine),
        language: args.language,
        isExported: false,
        synthetic: args.synthetic,
        visibility: acc.visibility,
        isStatic: false,
        returnType: acc.returnType,
        parameterTypes: acc.parameterTypes,
        parameterCount: arity,
        qualifiedName,
      },
    });
    args.result.symbols.push({
      filePath: args.filePath,
      name: acc.name,
      nodeId,
      type: 'Method',
      ownerId: args.ownerId,
      qualifiedName,
      parameterCount: arity,
      requiredParameterCount: arity,
      parameterTypes: acc.parameterTypes,
      returnType: acc.returnType,
      visibility: acc.visibility,
      isStatic: false,
      isAbstract: false,
      isFinal: false,
    });
    args.result.relationships.push({
      id: `HAS_METHOD:${args.ownerId}->${nodeId}`,
      sourceId: args.ownerId,
      targetId: nodeId,
      type: 'HAS_METHOD',
      confidence: 1.0,
      reason: acc.kind === 'getter' ? `${args.synthetic}-getter` : `${args.synthetic}-setter`,
    });
  }
}

/**
 * Unique capture range per planned accessor. `makeScopeId` is
 * file+range+kind only, so two Function scopes that share a range collapse.
 */
export function accessorCapture(name: string, acc: PlannedJvmAccessor, text: string): Capture {
  const node = acc.declaratorNode;
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  const endLine = node.endPosition.row + 1;
  const endCol = acc.kind === 'getter' ? node.endPosition.column : startCol;
  return { name, range: { startLine, startCol, endLine, endCol }, text };
}

export function capturesForPlannedAccessors(
  planned: readonly PlannedJvmAccessor[],
  typeDeclTypes: ReadonlySet<string>,
): CaptureMatch[] {
  const captures: CaptureMatch[] = [];
  for (const acc of planned) {
    const arity = String(acc.parameterTypes.length);
    const enclosing = ownerQualifiedSimpleName(acc.classNode, typeDeclTypes);
    const qualifiedName = `${enclosing}.${acc.name}`;
    captures.push({
      '@scope.function': accessorCapture('@scope.function', acc, acc.name),
    });
    captures.push({
      '@declaration.method': accessorCapture('@declaration.method', acc, acc.name),
      '@declaration.name': accessorCapture('@declaration.name', acc, acc.name),
      '@declaration.qualified_name': accessorCapture(
        '@declaration.qualified_name',
        acc,
        qualifiedName,
      ),
      '@declaration.parameter-count': accessorCapture('@declaration.parameter-count', acc, arity),
      '@declaration.required-parameter-count': accessorCapture(
        '@declaration.required-parameter-count',
        acc,
        arity,
      ),
      '@declaration.return-type': accessorCapture('@declaration.return-type', acc, acc.returnType),
      '@declaration.is-synthetic': accessorCapture('@declaration.is-synthetic', acc, 'true'),
    });
  }
  return captures;
}

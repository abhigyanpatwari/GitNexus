import type { CaptureMatch, ParsedFile } from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { splitImportStatement } from './import-decomposer.js';
import {
  applyPythonSubtypeDispatchSideChannel,
  collectPythonSubtypeDispatchSideChannel,
  type PythonSubtypeDispatchSideChannel,
} from './subtype-dispatch.js';

interface CallablePosition {
  readonly definitionLine: number;
  readonly definitionColumn: number;
}

/** Syntax proof only: the returned import must still resolve to a namespace. */
export type PythonModuleAccessorFact = CallablePosition &
  (
    | {
        readonly status: 'accepted';
        readonly returnedName: string;
        readonly returnLine: number;
        readonly returnColumn: number;
      }
    | { readonly status: 'declined' }
  );

export interface PythonCallResultAssignmentFact {
  readonly callLine: number;
  readonly callColumn: number;
  readonly straightLine: boolean;
}

/** One plain-data snapshot preserves both Python capture consumers. */
export interface PythonCaptureSideChannel {
  readonly kind: 'python-capture';
  readonly subtypeDispatch?: PythonSubtypeDispatchSideChannel;
  readonly moduleAccessors: readonly PythonModuleAccessorFact[];
  readonly callResultAssignments: readonly PythonCallResultAssignmentFact[];
}

const accessorsByFile = new Map<string, Map<string, PythonModuleAccessorFact>>();
const assignmentsByFile = new Map<string, Map<string, PythonCallResultAssignmentFact>>();
/** Shared by capture and replay so both sides key positions identically. */
export const positionKey = (line: number, column: number): string => `${line}:${column}`;

export function beginPythonModuleAccessorCapture(filePath: string): void {
  accessorsByFile.delete(filePath);
  assignmentsByFile.delete(filePath);
}

/** Read an exact callable, never a workspace-wide same-name candidate. */
export function pythonModuleAccessorFact(
  filePath: string,
  position: { readonly line: number; readonly column: number },
): PythonModuleAccessorFact | undefined {
  return accessorsByFile.get(filePath)?.get(positionKey(position.line, position.column));
}

/** Missing or malformed replay facts cannot establish a positive assignment proof. */
export function pythonCallResultAssignmentIsStraightLine(
  filePath: string,
  position: { readonly startLine: number; readonly startCol: number },
): boolean {
  return (
    assignmentsByFile.get(filePath)?.get(positionKey(position.startLine, position.startCol))
      ?.straightLine === true
  );
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter(
    (child): child is SyntaxNode => child !== null && child.type !== 'comment',
  );
}

function isDocstring(statement: SyntaxNode): boolean {
  if (statement.type !== 'expression_statement') return false;
  const children = namedChildren(statement);
  return (
    children.length === 1 &&
    children[0]!.type === 'string' &&
    /^[rRuU]*(?:"|')/.test(children[0]!.text)
  );
}

/**
 * Accept only imports followed by one returned imported identifier. Inspecting
 * direct body statements makes nested returns/yields belong to their own
 * callable; any outer body containing a nested definition simply declines.
 */
function returnedImport(fnNode: SyntaxNode): SyntaxNode | undefined {
  if (
    fnNode.hasError ||
    fnNode.parent?.type === 'decorated_definition' ||
    fnNode.children.some((child) => child.type === 'async')
  )
    return undefined;
  const parameters = fnNode.childForFieldName('parameters');
  const body = fnNode.childForFieldName('body');
  if (parameters === null || namedChildren(parameters).length > 0 || body === null)
    return undefined;

  const statements = namedChildren(body);
  if (statements[0] !== undefined && isDocstring(statements[0])) statements.shift();
  const returned = statements.pop();
  if (returned?.type !== 'return_statement' || statements.length === 0) return undefined;
  const values = namedChildren(returned);
  const value = values[0];
  if (values.length !== 1 || value?.type !== 'identifier') return undefined;

  const importedNames = new Set<string>();
  for (const statement of statements) {
    if (statement.type !== 'import_statement' && statement.type !== 'import_from_statement') {
      return undefined;
    }
    const imports = splitImportStatement(statement);
    if (imports.length === 0) return undefined;
    for (const imported of imports) {
      const name = (imported['@import.alias'] ?? imported['@import.name'])?.text;
      if (name === undefined || name === '*' || importedNames.has(name)) return undefined;
      importedNames.add(name);
    }
  }
  return importedNames.has(value.text) ? value : undefined;
}

export function recordPythonModuleAccessor(
  filePath: string,
  fnNode: SyntaxNode,
  mapLine?: (line: number) => number,
): void {
  const definitionLine = mapLine?.(fnNode.startPosition.row + 1) ?? fnNode.startPosition.row + 1;
  const definitionColumn = fnNode.startPosition.column;
  const returned = returnedImport(fnNode);
  const fact: PythonModuleAccessorFact =
    returned === undefined
      ? { definitionLine, definitionColumn, status: 'declined' }
      : {
          definitionLine,
          definitionColumn,
          status: 'accepted',
          returnedName: returned.text,
          returnLine: mapLine?.(returned.startPosition.row + 1) ?? returned.startPosition.row + 1,
          returnColumn: returned.startPosition.column,
        };
  let facts = accessorsByFile.get(filePath);
  if (facts === undefined) {
    facts = new Map();
    accessorsByFile.set(filePath, facts);
  }
  facts.set(positionKey(definitionLine, definitionColumn), fact);
}

const conditionalAssignmentAncestors = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'try_statement',
  'match_statement',
  'with_statement',
]);

function isStraightLineAssignment(node: SyntaxNode): boolean {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (
      ancestor.type === 'function_definition' ||
      ancestor.type === 'lambda' ||
      ancestor.type === 'module'
    )
      break;
    if (conditionalAssignmentAncestors.has(ancestor.type)) return false;
  }
  return true;
}

/** Preserve generic provenance even when control flow prevents a namespace proof. */
export function synthesizePythonCallResultAssignment(
  node: SyntaxNode,
  filePath: string,
  mapLine?: (line: number) => number,
): CaptureMatch | undefined {
  if (node.type !== 'assignment' || node.hasError) return undefined;
  const lhs = node.childForFieldName('left');
  const call = node.childForFieldName('right');
  if (lhs?.type !== 'identifier' || call?.type !== 'call') return undefined;
  const callee = call.childForFieldName('function');
  const argumentsNode = call.childForFieldName('arguments');
  if (
    callee?.type !== 'identifier' ||
    argumentsNode === null ||
    namedChildren(argumentsNode).length !== 0
  ) {
    return undefined;
  }
  const callLine = mapLine?.(call.startPosition.row + 1) ?? call.startPosition.row + 1;
  const callColumn = call.startPosition.column;
  let facts = assignmentsByFile.get(filePath);
  if (facts === undefined) {
    facts = new Map();
    assignmentsByFile.set(filePath, facts);
  }
  facts.set(positionKey(callLine, callColumn), {
    callLine,
    callColumn,
    straightLine: isStraightLineAssignment(node),
  });
  return {
    '@call-result-assignment.call': nodeToCapture('@call-result-assignment.call', call),
    '@call-result-assignment.lhs': nodeToCapture('@call-result-assignment.lhs', lhs),
  };
}

export function collectPythonCaptureSideChannel(
  filePath: string,
): PythonCaptureSideChannel | undefined {
  const subtypeDispatch = collectPythonSubtypeDispatchSideChannel(filePath);
  const moduleAccessors = [...(accessorsByFile.get(filePath)?.values() ?? [])];
  const callResultAssignments = [...(assignmentsByFile.get(filePath)?.values() ?? [])];
  if (
    subtypeDispatch === undefined &&
    moduleAccessors.length === 0 &&
    callResultAssignments.length === 0
  )
    return undefined;
  return {
    kind: 'python-capture',
    ...(subtypeDispatch === undefined ? {} : { subtypeDispatch }),
    moduleAccessors,
    callResultAssignments,
  };
}

function validPosition(line: unknown, column: unknown): boolean {
  return (
    typeof line === 'number' &&
    Number.isInteger(line) &&
    line > 0 &&
    typeof column === 'number' &&
    Number.isInteger(column) &&
    column >= 0
  );
}

function isAccessorFact(value: unknown): value is PythonModuleAccessorFact {
  if (value === null || typeof value !== 'object') return false;
  const fact = value as Partial<PythonModuleAccessorFact>;
  if (!validPosition(fact.definitionLine, fact.definitionColumn)) return false;
  if (fact.status === 'declined') return true;
  return (
    fact.status === 'accepted' &&
    typeof fact.returnedName === 'string' &&
    fact.returnedName.length > 0 &&
    validPosition(fact.returnLine, fact.returnColumn)
  );
}

/** Worker/cache restore resets both stores, including when either is absent. */
export function applyPythonCaptureSideChannel(parsed: ParsedFile): void {
  beginPythonModuleAccessorCapture(parsed.filePath);
  const data = parsed.captureSideChannel as Partial<PythonCaptureSideChannel> | undefined;
  if (data === null || typeof data !== 'object' || data.kind !== 'python-capture') {
    // The subtype helper also accepts its original standalone payload.
    applyPythonSubtypeDispatchSideChannel(parsed);
    return;
  }
  applyPythonSubtypeDispatchSideChannel({ ...parsed, captureSideChannel: data.subtypeDispatch });

  const facts = new Map<string, PythonModuleAccessorFact>();
  for (const fact of Array.isArray(data.moduleAccessors) ? data.moduleAccessors : []) {
    if (isAccessorFact(fact)) {
      facts.set(positionKey(fact.definitionLine, fact.definitionColumn), fact);
    }
  }
  if (facts.size > 0) accessorsByFile.set(parsed.filePath, facts);
  const assignments = new Map<string, PythonCallResultAssignmentFact>();
  for (const fact of Array.isArray(data.callResultAssignments) ? data.callResultAssignments : []) {
    if (
      fact !== null &&
      typeof fact === 'object' &&
      validPosition(fact.callLine, fact.callColumn) &&
      typeof fact.straightLine === 'boolean'
    ) {
      assignments.set(positionKey(fact.callLine, fact.callColumn), fact);
    }
  }
  if (assignments.size > 0) assignmentsByFile.set(parsed.filePath, assignments);
}

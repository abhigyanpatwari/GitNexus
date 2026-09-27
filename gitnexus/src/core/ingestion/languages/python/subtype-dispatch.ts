import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { definitionIdPosition } from '../../scope-resolution/utils/definition-id.js';
import { classifyPythonBoundReceiver } from './receiver-binding.js';

type PositionTuple = readonly [line: number, column: number];
type CallShapeTuple = readonly [line: number, column: number, positionalCount: number];
type CapacityTuple = readonly [line: number, column: number, capacity: number];
type LineMapper = (line: number) => number;

/**
 * Python-private capture facts for conservative missing-member subtype dispatch.
 * They stay opaque on `ParsedFile.captureSideChannel`; the public reference and
 * definition schemas intentionally do not gain Python argument-binding fields.
 */
export interface PythonSubtypeDispatchSideChannel {
  readonly kind: 'python-subtype-dispatch';
  readonly simplePositionalCalls: readonly CallShapeTuple[];
  readonly positionalCapacities: readonly CapacityTuple[];
}

const simplePositionalCallsByFile = new Map<string, Map<string, number>>();
const positionalCapacitiesByFile = new Map<string, Map<string, number>>();

const positionKey = (line: number, column: number): string => `${line}:${column}`;

const nodePosition = (node: SyntaxNode, mapLine?: LineMapper): PositionTuple => {
  const line = node.startPosition.row + 1;
  return [mapLine?.(line) ?? line, node.startPosition.column];
};

/** Reset one file before a fresh capture or a worker snapshot restore. */
export function beginPythonSubtypeDispatchCapture(filePath: string): void {
  simplePositionalCallsByFile.delete(filePath);
  positionalCapacitiesByFile.delete(filePath);
}

/** Record calls whose arguments are all ordinary positional expressions. */
export function recordPythonSimplePositionalCall(
  filePath: string,
  callNode: SyntaxNode,
  positionalCount: number,
  mapLine?: LineMapper,
): void {
  const [line, column] = nodePosition(callNode, mapLine);
  let sites = simplePositionalCallsByFile.get(filePath);
  if (sites === undefined) {
    sites = new Map<string, number>();
    simplePositionalCallsByFile.set(filePath, sites);
  }
  sites.set(positionKey(line, column), positionalCount);
}

function parameterBindingNode(parameter: SyntaxNode): SyntaxNode {
  if (
    parameter.type === 'typed_parameter' ||
    parameter.type === 'default_parameter' ||
    parameter.type === 'typed_default_parameter'
  ) {
    return parameter.childForFieldName('name') ?? parameter.firstNamedChild ?? parameter;
  }
  return parameter;
}

function sameNodePosition(left: SyntaxNode, right: SyntaxNode): boolean {
  return (
    left.startPosition.row === right.startPosition.row &&
    left.startPosition.column === right.startPosition.column &&
    left.endPosition.row === right.endPosition.row &&
    left.endPosition.column === right.endPosition.column
  );
}

/**
 * Count parameters that can receive ordinary positional arguments after
 * Python's descriptor-bound receiver is removed. `*args` and any required
 * keyword-only parameter are deliberately unknown: this successor proves
 * fixed positional calls only.
 */
function positionalCapacity(fnNode: SyntaxNode): number | undefined {
  const parameters = fnNode.childForFieldName('parameters');
  if (parameters === null) return undefined;
  const receiver = classifyPythonBoundReceiver(fnNode)?.parameter;
  let capacity = 0;
  let keywordOnly = false;

  for (const parameter of parameters.namedChildren) {
    if (parameter === null || parameter.type === 'comment') continue;
    if (receiver !== undefined && sameNodePosition(parameter, receiver)) continue;

    const binding = parameterBindingNode(parameter);
    if (binding.type === 'positional_separator') continue;
    if (binding.type === 'keyword_separator') {
      keywordOnly = true;
      continue;
    }
    if (binding.type === 'dictionary_splat_pattern') break;
    if (binding.type === 'list_splat_pattern') return undefined;
    if (
      binding.type !== 'identifier' &&
      parameter.type !== 'default_parameter' &&
      parameter.type !== 'typed_parameter' &&
      parameter.type !== 'typed_default_parameter'
    ) {
      return undefined;
    }
    if (keywordOnly) {
      if (parameter.type !== 'default_parameter' && parameter.type !== 'typed_default_parameter') {
        return undefined;
      }
      continue;
    }
    capacity++;
  }
  return capacity;
}

/** Record a method's exact fixed positional capacity when the AST proves it. */
export function recordPythonSubtypeMethodShape(
  filePath: string,
  fnNode: SyntaxNode,
  mapLine?: LineMapper,
): void {
  const capacity = positionalCapacity(fnNode);
  if (capacity === undefined) return;
  const [line, column] = nodePosition(fnNode, mapLine);
  let capacities = positionalCapacitiesByFile.get(filePath);
  if (capacities === undefined) {
    capacities = new Map<string, number>();
    positionalCapacitiesByFile.set(filePath, capacities);
  }
  capacities.set(positionKey(line, column), capacity);
}

function parsePositionKey(key: string): PositionTuple | undefined {
  const match = /^(\d+):(\d+)$/.exec(key);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/** Snapshot one worker file into structured-clone-safe plain data. */
export function collectPythonSubtypeDispatchSideChannel(
  filePath: string,
): PythonSubtypeDispatchSideChannel | undefined {
  const callSites: CallShapeTuple[] = [];
  for (const [key, positionalCount] of simplePositionalCallsByFile.get(filePath) ?? []) {
    const position = parsePositionKey(key);
    if (position !== undefined) callSites.push([position[0], position[1], positionalCount]);
  }
  const capacities: CapacityTuple[] = [];
  for (const [key, capacity] of positionalCapacitiesByFile.get(filePath) ?? []) {
    const position = parsePositionKey(key);
    if (position !== undefined) capacities.push([position[0], position[1], capacity]);
  }
  if (callSites.length === 0 && capacities.length === 0) return undefined;
  return {
    kind: 'python-subtype-dispatch',
    simplePositionalCalls: callSites,
    positionalCapacities: capacities,
  };
}

/** Restore worker/cache facts without reparsing source on the main thread. */
export function applyPythonSubtypeDispatchSideChannel(parsed: ParsedFile): void {
  beginPythonSubtypeDispatchCapture(parsed.filePath);
  const data = parsed.captureSideChannel as PythonSubtypeDispatchSideChannel | undefined;
  if (
    data === undefined ||
    data === null ||
    typeof data !== 'object' ||
    data.kind !== 'python-subtype-dispatch' ||
    !Array.isArray(data.simplePositionalCalls) ||
    !Array.isArray(data.positionalCapacities)
  ) {
    return;
  }

  for (const position of data.simplePositionalCalls) {
    if (!validCallShape(position)) continue;
    let sites = simplePositionalCallsByFile.get(parsed.filePath);
    if (sites === undefined) {
      sites = new Map<string, number>();
      simplePositionalCallsByFile.set(parsed.filePath, sites);
    }
    sites.set(positionKey(position[0], position[1]), position[2]);
  }
  for (const entry of data.positionalCapacities) {
    if (!validCapacity(entry)) continue;
    let capacities = positionalCapacitiesByFile.get(parsed.filePath);
    if (capacities === undefined) {
      capacities = new Map<string, number>();
      positionalCapacitiesByFile.set(parsed.filePath, capacities);
    }
    capacities.set(positionKey(entry[0], entry[1]), entry[2]);
  }
}

function validPosition(value: readonly number[]): value is PositionTuple {
  return (
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    value[0]! > 0 &&
    Number.isInteger(value[1]) &&
    value[1]! >= 0
  );
}

function validCallShape(value: readonly number[]): value is CallShapeTuple {
  return validPosition(value.slice(0, 2)) && Number.isInteger(value[2]) && value[2]! >= 0;
}

function validCapacity(value: readonly number[]): value is CapacityTuple {
  return validPosition(value.slice(0, 2)) && Number.isInteger(value[2]) && value[2]! >= 0;
}

export function pythonSubtypeCallPositionalCount(
  filePath: string,
  range: { readonly startLine: number; readonly startCol: number },
): number | undefined {
  return simplePositionalCallsByFile
    .get(filePath)
    ?.get(positionKey(range.startLine, range.startCol));
}

export function pythonSubtypePositionalCapacity(candidate: SymbolDefinition): number | undefined {
  const position = definitionIdPosition(candidate.nodeId, candidate.filePath);
  if (position === undefined) return undefined;
  return positionalCapacitiesByFile
    .get(candidate.filePath)
    ?.get(positionKey(position.line, position.column));
}

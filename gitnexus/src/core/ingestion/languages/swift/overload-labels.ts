import type { ParsedFile, Range, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalName } from './identifiers.js';

interface SwiftOverloadLabels {
  readonly argumentsByPosition: Record<string, readonly string[]>;
  readonly parametersByPosition: Record<string, readonly string[]>;
}

// The scope extractor and its side-channel collector run synchronously for
// one file. Keep only that capture until the collector attaches it to ParsedFile.
let currentCapture: { filePath: string; labels: SwiftOverloadLabels } | undefined;

export function beginSwiftOverloadLabelCapture(filePath: string): SwiftOverloadLabels {
  const labels = { argumentsByPosition: {}, parametersByPosition: {} };
  currentCapture = { filePath, labels };
  return labels;
}

export function collectSwiftOverloadLabels(filePath: string): SwiftOverloadLabels | undefined {
  const captured = currentCapture;
  currentCapture = undefined;
  if (captured?.filePath !== filePath) return undefined;
  const { labels } = captured;
  if (
    Object.keys(labels.argumentsByPosition).length > 0 ||
    Object.keys(labels.parametersByPosition).length > 0
  )
    return labels;
  return undefined;
}

export function captureSwiftParameterLabels(
  labels: SwiftOverloadLabels,
  declaration: SyntaxNode,
  range: Range,
): void {
  const parameters: string[] = [];
  for (const node of declaration.namedChildren) {
    if (node.type !== 'parameter') continue;
    const name = node.childForFieldName('external_name') ?? node.childForFieldName('name');
    if (name?.type !== 'simple_identifier' || name.isMissing) return;
    const label = canonicalName(name.text);
    parameters.push(label === '_' ? '' : label);
  }
  if (parameters.length > 0) labels.parametersByPosition[positionKey(range)] = parameters;
}

export function captureSwiftArgumentLabels(
  labels: SwiftOverloadLabels,
  call: SyntaxNode,
  range: Range,
): void {
  const suffix = call.namedChildren.find((child) => child.type === 'call_suffix');
  if (suffix === undefined || suffix.hasError) return;
  const parts = suffix.namedChildren.filter((child) => !child.isExtra);
  const args = parts[0];
  // Trailing closures can omit a label and do not have a positional match.
  if (parts.length !== 1 || args?.type !== 'value_arguments') return;
  const written = args.namedChildren
    .filter((child) => child.type === 'value_argument')
    .map((arg) => canonicalName(arg.childForFieldName('name')?.text ?? ''));
  if (written.length > 0) labels.argumentsByPosition[positionKey(range)] = written;
}

// The capture-side channel is also present on worker and parse-cache replay.
// Associate it with the live index so same-path files in other runs stay separate.
const labelsByIndex = new WeakMap<ScopeResolutionIndexes, Map<string, SwiftOverloadLabels>>();

export function indexSwiftOverloadLabels(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const labelsByFile = new Map<string, SwiftOverloadLabels>();
  for (const file of parsedFiles) {
    const labels = file.captureSideChannel as SwiftOverloadLabels | undefined;
    if (labels !== undefined) labelsByFile.set(file.filePath, labels);
  }
  labelsByIndex.set(indexes, labelsByFile);
}

export function swiftArgumentLabels(
  indexes: ScopeResolutionIndexes,
  filePath: string,
  range: Range,
): readonly string[] | undefined {
  return labelsByIndex.get(indexes)?.get(filePath)?.argumentsByPosition[positionKey(range)];
}

export function swiftLabelsMatch(
  indexes: ScopeResolutionIndexes,
  candidate: SymbolDefinition,
  labels: readonly string[],
): boolean {
  // Omitted defaults and variadic arguments need an alignment we cannot prove
  // from positional labels; let the existing resolver handle those calls.
  const range = candidate.declarationRange;
  if (range === undefined || candidate.parameterCount !== labels.length) return true;
  const parameters = labelsByIndex.get(indexes)?.get(candidate.filePath)?.parametersByPosition[
    positionKey(range)
  ];
  return (
    parameters === undefined ||
    parameters.length !== labels.length ||
    parameters.every((parameter, index) => parameter === labels[index])
  );
}

function positionKey(range: Range): string {
  return `${range.startLine}:${range.startCol}`;
}

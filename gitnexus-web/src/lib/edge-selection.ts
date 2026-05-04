import type { EdgeType } from './constants';

export const edgeSelectionEquals = (
  left: readonly EdgeType[],
  right: readonly EdgeType[],
): boolean => {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  return [...rightSet].every((edgeType) => leftSet.has(edgeType));
};

export const copyEdgeSelection = (edgeTypes: readonly EdgeType[]): EdgeType[] => [...edgeTypes];

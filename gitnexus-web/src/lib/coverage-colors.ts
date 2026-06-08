/**
 * Coverage color utilities for graph visualization.
 *
 * Maps coverage ratios (0.0–1.0) to semantic colors for the graph heatmap:
 *   >80% → green (well-covered)
 *   40-80% → amber (partial coverage)
 *   >0% and <40% → red (poorly covered)
 *   0% or undefined → gray (no data / uncovered)
 */

/** Return a CSS color string for a coverage ratio (0.0–1.0). */
export function coverageColor(ratio: number | undefined): string {
  if (ratio === undefined) return '#484f58'; // no data — gray
  if (ratio >= 0.8) return '#10b981'; // >80% — green
  if (ratio >= 0.4) return '#f59e0b'; // 40-80% — amber
  if (ratio > 0) return '#ef4444'; // >0% and <40% — red
  return '#484f58'; // 0% — gray (present in run but uncovered)
}

/** Return a human-readable label for a coverage ratio range. */
export function coverageLabel(ratio: number | undefined): string {
  if (ratio === undefined) return 'No data';
  if (ratio >= 0.8) return 'Well covered';
  if (ratio >= 0.4) return 'Partial';
  if (ratio > 0) return 'Poor';
  return 'Uncovered';
}

/** Coverage mode edge style — solid if traversed, dashed otherwise. */
export function coverageEdgeStyle(traversed: boolean): 'solid' | 'dashed' {
  return traversed ? 'solid' : 'dashed';
}
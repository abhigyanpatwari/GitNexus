import { transform } from './helpers';

// Control: a "plain helper" pattern that the bug report says hits ~100%
// capture. If THIS edge is missing, the bug is more fundamental than
// HOF-callback attribution.
export const direct = (x: string): string => transform(x);

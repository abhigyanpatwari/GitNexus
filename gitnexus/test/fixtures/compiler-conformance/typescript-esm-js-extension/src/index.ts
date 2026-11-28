
import { estimateTokens } from './utils.js';

export function processText(text: string): number {
  return estimateTokens(text);
}

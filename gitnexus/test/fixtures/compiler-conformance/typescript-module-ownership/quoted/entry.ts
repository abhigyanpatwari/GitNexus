
import * as namespace from './local.js';
import primary, { 'public-name' as direct, '\\u0061' as escape, '\u{0000061}' as padded } from './local.js';
import { 'another name' as forwarded } from './barrel.js';
import { "\uD83D\uDE00" as emoji, escapedLocal } from './local.js';
export function useAstral() { emoji(); }
export function useEscapedLocal() { escapedLocal(); }
export function useDirect() { direct(); }
export function useDefault() { primary(); }
export function useLiteralEscape() { escape(); }
export function usePaddedEscape() { padded(); }
export function useBarrel() { forwarded(); }
export function hiddenName() {
  // The local name was never published.
  namespace.original();
}

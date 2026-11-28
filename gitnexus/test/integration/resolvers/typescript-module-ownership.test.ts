import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './helpers.js';

describe('quoted JavaScript export ownership', () => {
  const extension = 'mjs';
  const suffix = extension;
  const result = useFixture(`quoted-exports-${extension}`, {
    [`local.${extension}`]: String.raw`
function original() {}
function defaultImpl() {}
function literalEscape() {}
function ordinary() {}
function astral() {}
export { astral as "\u{1F600}", \u006friginal as escapedLocal };
export { original as "pub\x6cic-name", defaultImpl as 'default', literalEscape as '\\u0061', ordinary as a };
`,
    [`barrel.${extension}`]: `export { 'public-name' as "another name" } from './local.${suffix}';`,
    [`entry.${extension}`]: String.raw`
import * as namespace from './local.${suffix}';
import primary, { 'public-name' as direct, '\\u0061' as escape, '\u{0000061}' as padded } from './local.${suffix}';
import { 'another name' as forwarded } from './barrel.${suffix}';
import { "\uD83D\uDE00" as emoji, escapedLocal } from './local.${suffix}';
export function useAstral() { emoji(); }
export function useEscapedLocal() { escapedLocal(); }
export function useDirect() { direct(); }
export function useDefault() { primary(); }
export function useLiteralEscape() { escape(); }
export function usePaddedEscape() { padded(); }
export function useBarrel() { forwarded(); }
export function hiddenName() {
  // @ts-expect-error The local name was never published.
  namespace.original();
}
`,
  });

  it.each([
    ['useDirect', 'original'],
    ['useAstral', 'astral'],
    ['useEscapedLocal', 'original'],
    ['useDefault', 'defaultImpl'],
    ['useLiteralEscape', 'literalEscape'],
    ['usePaddedEscape', 'ordinary'],
    ['useBarrel', 'original'],
    ['hiddenName', null],
  ] as const)('emits only the exact targets for %s', (caller, target) => {
    const actual = getRelationships(result(), 'CALLS')
      .filter(({ rel }) => rel.sourceId === `Function:entry.${extension}:${caller}`)
      .map(({ rel }) => rel.targetId);
    expect(actual).toEqual(target === null ? [] : [`Function:local.${extension}:${target}`]);
  });
});

/**
 * Which language emitters synthesize `@reference.receiver-chain`.
 *
 * The helper is self-gating — a non-call match, an absent receiver, or a chain
 * with no nameable base all leave the match untouched — so wiring a language
 * costs nothing where the shape does not occur. That makes the inventory easy to
 * change silently, which is exactly why it is pinned: a new entry means someone
 * wired a language without measuring it, and a removed entry means a refactor
 * quietly dropped coverage.
 *
 * Source-level rather than behavioural, because the thing being pinned IS the
 * wiring: a behavioural check would pass for a language whose fixture happens to
 * contain no chained receiver.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANGUAGES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'core',
  'ingestion',
  'languages',
);

function emittersCallingHelper(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(LANGUAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const captures = path.join(LANGUAGES_DIR, entry.name, 'captures.ts');
    let source: string;
    try {
      source = readFileSync(captures, 'utf8');
    } catch {
      continue; // no captures.ts (cobol/vue emit through another path)
    }
    if (source.includes('synthesizeReceiverChainCapture(')) out.push(entry.name);
  }
  return out.sort();
}

describe('receiver-chain capture wiring inventory', () => {
  it('is wired into exactly the emitters that build a capture node map', () => {
    expect(emittersCallingHelper()).toEqual([
      'c',
      'cpp',
      'csharp',
      'dart',
      'go',
      'java',
      'javascript',
      'kotlin',
      'php',
      'python',
      'ruby',
      'rust',
      'swift',
      'typescript',
    ]);
  });

  it('leaves emitters without a node map unwired', () => {
    // These two do not group captures with their originating syntax nodes, so
    // there is no receiver node to walk. Wiring them would need an emitter
    // change, not a one-line call.
    for (const language of ['cobol', 'vue'] as const) {
      const captures = path.join(LANGUAGES_DIR, language, 'captures.ts');
      let source = '';
      try {
        source = readFileSync(captures, 'utf8');
      } catch {
        continue;
      }
      expect(source, `${language} stays unwired`).not.toContain('synthesizeReceiverChainCapture(');
    }
  });
});

/**
 * Source-code regression: ENOBUFS on large git/rg output.
 *
 * Node's default maxBuffer for execFileSync is 1 MB, which is easily exceeded
 * by `git diff` on repos with large unstaged changes (e.g. unignored build
 * folders) — see the original bug report:
 *
 *   "spawnSync git ENOBUFS in gitnexus_detect_changes(scope=\"unstaged\")
 *    due to missing maxBuffer".
 *
 * Every `execFileSync` call in `local-backend.ts` that captures stdout
 * (i.e. sets `encoding`) MUST pass an explicit `maxBuffer`. This test is a
 * lightweight static guard so the regression cannot silently come back.
 *
 * Kept as a standalone file (no LocalBackend import) so it does not depend
 * on the LadybugDB native binding being available in the test environment.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SOURCE_PATH = path.join(__dirname, '../../src/mcp/local/local-backend.ts');

describe('local-backend: execFileSync maxBuffer regression', () => {
  const source = fs.readFileSync(SOURCE_PATH, 'utf-8');

  it('every stdout-capturing execFileSync call passes maxBuffer', () => {
    // Match each `execFileSync(...)` call. The local-backend.ts call sites use
    // a single trailing options object literal, so a non-greedy match up to the
    // closing `)` of the statement is sufficient.
    const callRe = /execFileSync\s*\(([\s\S]*?)\)\s*;/g;
    const offenders: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(source)) !== null) {
      const args = match[1];
      // Only stdout-capturing calls (encoding set) are at risk of ENOBUFS.
      if (!/encoding\s*:/.test(args)) continue;
      if (!/maxBuffer\s*:/.test(args)) {
        const lineNo = source.slice(0, match.index).split('\n').length;
        offenders.push(`line ${lineNo}: ${args.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    expect(
      offenders,
      `execFileSync calls missing explicit maxBuffer (ENOBUFS risk):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

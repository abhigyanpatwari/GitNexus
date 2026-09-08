/**
 * Canary for the invariant that `callableValueReferenceBoundaries`' dispatch
 * exclusion silently depends on (#3219 review round 3).
 *
 * The exclusion, in `mcp/local/local-backend.ts`: a target with an inbound
 * `property-dispatch` CALLS edge is NOT hedged, because the analyzer followed
 * the registration and nothing was missed. It is symbol-level, not edge-level —
 * the graph does not record which registration produced which synthesized call.
 *
 * That is only sound while no single symbol can carry BOTH kinds of
 * registration, and today none can, for a reason that lives nowhere near the
 * exclusion:
 *
 *   - `emitPropertyDispatchCalls` synthesizes a CALLS edge only for a
 *     registration whose site carries a `propertyKey` (sweep 1 skips the
 *     registration index when it is undefined; sweep 2 reads only that index).
 *   - Every JS/TS `@reference.value-ref` rule also captures
 *     `@reference.property-key` — both are object-literal shapes.
 *   - No Zig `@reference.value-ref` rule captures one: Zig has no
 *     object-literal key to dispatch through.
 *
 * So a dispatchable registration is always a JS/TS one and an undispatchable
 * registration is always a Zig one, and the two cannot meet on one symbol.
 *
 * The day that stops being true — a JS/TS rule for a bare callback argument
 * (`register(handler)`), a Zig rule that grows a key — a symbol CAN have both,
 * and the exclusion starts publishing `exact` over a registration the analyzer
 * provably did not follow. That is the #3399 defect returning through a side
 * door, and it would not fail a single existing test.
 *
 * This test fails instead. If it fails, do not relax it: go and decide what
 * `callableValueReferenceBoundaries` should do about a mixed symbol (the
 * options are recorded at the exclusion site), then update this file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPESCRIPT_SCOPE_QUERY } from '../../../src/core/ingestion/languages/typescript/query.js';
import { JAVASCRIPT_SCOPE_QUERY } from '../../../src/core/ingestion/languages/javascript/query.js';
import { ZIG_SCOPE_QUERY } from '../../../src/core/ingestion/languages/zig/query.js';

const VALUE_REF = '@reference.value-ref';
const PROPERTY_KEY = '@reference.property-key';

/**
 * Split a tree-sitter scope query into its top-level s-expression rules.
 *
 * `;;` comments are dropped first — they discuss the very tags this test
 * matches on (Zig's rules carry a paragraph explaining why they attach no
 * property key), so leaving them in would make every Zig rule look keyed.
 * Double-quoted anonymous nodes (`"const"`, `"("`) are skipped while counting
 * depth: a query that matches a literal paren would otherwise unbalance it.
 */
function topLevelRules(query: string): string[] {
  const src = query
    .split('\n')
    .map((line) => {
      const comment = line.indexOf(';;');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join('\n');

  const rules: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && start !== -1) {
        rules.push(src.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return rules;
}

function valueRefRules(query: string): string[] {
  return topLevelRules(query).filter((rule) => rule.includes(VALUE_REF));
}

describe('value-ref dispatchability partition', () => {
  it('splits a query into rules without being confused by comments or literal parens', () => {
    // Guards the guard: a splitter that silently returned [] would make every
    // assertion below vacuously true.
    const rules = topLevelRules(`
;; a comment mentioning (parens) and ${PROPERTY_KEY}
(call_expression
  function: (_)
  (identifier) @reference.name)

(variable_declaration
  "const" . (identifier) @a .)
`);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toContain('call_expression');
    expect(rules[1]).toContain('variable_declaration');
    expect(rules.join('\n')).not.toContain(PROPERTY_KEY);
  });

  it('every TypeScript value-ref rule is DISPATCHABLE (carries a property key)', () => {
    const rules = valueRefRules(TYPESCRIPT_SCOPE_QUERY);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((r) => !r.includes(PROPERTY_KEY))).toEqual([]);
  });

  it('every JavaScript value-ref rule is DISPATCHABLE (carries a property key)', () => {
    const rules = valueRefRules(JAVASCRIPT_SCOPE_QUERY);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((r) => !r.includes(PROPERTY_KEY))).toEqual([]);
  });

  it('every Zig value-ref rule is UNDISPATCHABLE (carries no property key)', () => {
    const rules = valueRefRules(ZIG_SCOPE_QUERY);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((r) => r.includes(PROPERTY_KEY))).toEqual([]);
  });

  it('no OTHER language emits a value-ref capture', () => {
    // The three above are hand-classified. A fourth language emitting
    // `value-ref` has not been classified by anyone, so the exclusion's premise
    // is unverified for it — classify it here and in the exclusion's comment.
    const languagesDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../src/core/ingestion/languages',
    );
    const emitting = fs
      .readdirSync(languagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => {
        const query = path.join(languagesDir, e.name, 'query.ts');
        return fs.existsSync(query) && fs.readFileSync(query, 'utf8').includes(VALUE_REF);
      })
      .map((e) => e.name)
      .sort();
    expect(emitting).toEqual(['javascript', 'typescript', 'zig']);
  });
});

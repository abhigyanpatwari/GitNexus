import { describe, it, expect, beforeAll } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import {
  GATED_LANGUAGES,
  loadGrammarModel,
  validateNodeType,
  validateField,
  type GrammarModel,
} from '../helpers/grammar-introspection.js';
import {
  collectAllLiterals,
  resolutionLayerProgramOk,
  type CollectedLiterals,
} from '../helpers/literal-collectors.js';

/**
 * Grammar-drift gate (issue #1920): every tree-sitter node-type and field-name
 * literal referenced in the ingestion CODE must be emittable by at least one of
 * the grammar(s) that code path serves. A literal absent from every candidate
 * grammar is a "dead branch keyed on a node type the grammar never emits" —
 * the systemic defect this gate kills.
 *
 * Complements query-compilation.test.ts (which compiles the legacy *_QUERIES
 * banks): this gate covers the NON-compiled literal surface (node.type ===,
 * childForFieldName, Set/array node-type lists) plus the registry scope queries.
 */

// Empty by design: every dead grammar literal this gate surfaces is removed in
// this PR — no allowlisted debt. Mirrors query-compilation.test.ts:40. Keep it
// empty; fix the literal at its source rather than allowlisting it here.
const knownFailures = new Set<string>([]);

interface Failure {
  kind: 'node-type' | 'field' | 'query';
  literal: string;
  file: string;
  line: number;
  languages: string[];
}

const fmt = (f: Failure): string =>
  `${f.kind} "${f.literal}" — ${f.file}:${f.line} — not valid in [${f.languages.join(', ')}]`;

describe('grammar literal validation gate', () => {
  let collected: CollectedLiterals;
  const models = new Map<SupportedLanguages, GrammarModel | null>();

  beforeAll(async () => {
    for (const lang of GATED_LANGUAGES) models.set(lang, loadGrammarModel(lang));
    collected = await collectAllLiterals();
  }, 120_000);

  /**
   * "valid" if ANY candidate grammar accepts it; "dead" if at least one
   * candidate rejects it and none accept; "unavailable" if every candidate
   * grammar is absent (so we skip rather than fail — R9).
   */
  function classify(
    languages: SupportedLanguages[],
    check: (lang: SupportedLanguages) => 'valid' | 'dead' | 'unavailable',
  ): 'valid' | 'dead' | 'unavailable' {
    let sawDead = false;
    for (const lang of languages) {
      const r = check(lang);
      if (r === 'valid') return 'valid';
      if (r === 'dead') sawDead = true;
    }
    return sawDead ? 'dead' : 'unavailable';
  }

  it('every node-type and field literal exists in its grammar; registry queries compile', () => {
    const failures: Failure[] = [];

    for (const n of collected.nodeTypes) {
      if (knownFailures.has(n.literal)) continue;
      const verdict = classify(n.languages, (lang) =>
        validateNodeType(lang, models.get(lang) ?? null, n.literal),
      );
      if (verdict === 'dead') {
        failures.push({
          kind: 'node-type',
          literal: n.literal,
          file: n.file,
          line: n.line,
          languages: n.languages,
        });
      }
    }

    for (const f of collected.fields) {
      if (knownFailures.has(f.field)) continue;
      const verdict = classify(f.languages, (lang) =>
        validateField(models.get(lang) ?? null, f.field, f.receiverNodeType),
      );
      if (verdict === 'dead') {
        failures.push({
          kind: 'field',
          literal: f.field,
          file: f.file,
          line: f.line,
          languages: f.languages,
        });
      }
    }

    for (const q of collected.queryProbes) {
      if (q.error) {
        failures.push({
          kind: 'query',
          literal: `${q.getter} (${q.error})`,
          file: `languages/${q.language}/query.ts`,
          line: 0,
          languages: [q.language],
        });
      }
    }

    // De-dup identical (kind, literal, file) rows for a readable report.
    const seen = new Set<string>();
    const unique = failures.filter((f) => {
      const k = `${f.kind}|${f.literal}|${f.file}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const report =
      unique.length === 0
        ? ''
        : `\n${unique.length} dead grammar literal(s) found:\n` +
          unique
            .slice()
            .sort((a, b) => a.file.localeCompare(b.file))
            .map((f) => `  - ${fmt(f)}`)
            .join('\n') +
          '\n';

    expect(unique, report).toHaveLength(0);
  }, 120_000);

  it('runs non-vacuously: collector populated and the Mode-4 resolution layer built', () => {
    // A vacuous pass — empty collection, or a degraded TS-program build that
    // silently zeroes Mode-4 — must FAIL the gate rather than slip through green.
    // (#1937 tri-review: Mode-4 silent-degrade + gate-vacuity holes.)
    expect(resolutionLayerProgramOk, 'Mode-4 TypeScript program failed to build').toBe(true);
    expect(collected.nodeTypes.length, 'collector returned too few node types').toBeGreaterThan(50);
    expect(collected.fields.length, 'collector returned too few fields').toBeGreaterThan(50);
    expect(knownFailures.size, 'knownFailures must stay empty per policy').toBe(0);
  });

  it('does not flag capture-tag strings', () => {
    expect(collected.nodeTypes.some((n) => n.literal.startsWith('@'))).toBe(false);
  });

  it('validates a real node-scoped field and rejects a bogus one (Python)', () => {
    const model = loadGrammarModel(SupportedLanguages.Python);
    expect(validateField(model, 'name', 'function_definition')).toBe('valid');
    expect(validateField(model, 'definitely_not_a_field', 'function_definition')).toBe('dead');
  });
});

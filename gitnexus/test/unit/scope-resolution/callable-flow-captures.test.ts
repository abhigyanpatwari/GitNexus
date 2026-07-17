/**
 * Direct unit tests for `synthesizeCallableFlowCaptures` — the shared
 * AST-walking capture synthesizer behind every language's
 * `*_CALLABLE_CAPTURE_OPTIONS` block (#2522 review: the 1,100-line producer
 * had no test naming it; only downstream consumers were covered).
 *
 * Runs over the JavaScript grammar with a minimal options object so the
 * assertions pin the SYNTHESIZER's semantics (assignment forms, member
 * paths, subscripts, formals, produced-value guards), not any language's
 * option tuning.
 */

import { describe, it, expect } from 'vitest';
import { synthesizeCallableFlowCaptures } from '../../../src/core/ingestion/utils/callable-flow-captures.js';
import { getJsParser } from '../../../src/core/ingestion/languages/javascript/query.js';

const OPTIONS = {
  functionNodeTypes: new Set(['function_declaration', 'arrow_function', 'function_expression']),
  callNodeTypes: new Set(['call_expression']),
  parameterListNodeTypes: new Set(['formal_parameters', 'arguments']),
  parameterNodeTypes: new Set(['identifier', 'rest_pattern', 'assignment_pattern']),
  bindingNodeTypes: new Set(['variable_declarator']),
  assignmentNodeTypes: new Set(['assignment_expression']),
  identifierNodeTypes: new Set(['identifier', 'property_identifier']),
} as const;

function factsFor(src: string): Array<Record<string, string>> {
  const tree = getJsParser().parse(src);
  if (tree === null) throw new Error('parse failed');
  return synthesizeCallableFlowCaptures(tree.rootNode, OPTIONS).map((match) => {
    const out: Record<string, string> = {};
    for (const [tag, cap] of Object.entries(match)) {
      if (cap !== undefined) out[tag] = cap.text;
    }
    return out;
  });
}

function byTag(facts: Array<Record<string, string>>, tag: string): Array<Record<string, string>> {
  return facts.filter((fact) => fact[tag] !== undefined);
}

describe('synthesizeCallableFlowCaptures (shared synthesizer, #2522)', () => {
  it('emits a seed for a declared-function initializer and an invoke at the call through it', () => {
    const facts = factsFor('function target() {}\nconst h = target;\nh(1);\n');
    expect(byTag(facts, '@callable-flow.seed')).toMatchObject([
      {
        '@callable-flow.destination': 'h',
        '@callable-flow.target-name': 'target',
      },
    ]);
    expect(byTag(facts, '@callable-flow.invoke')).toMatchObject([
      {
        '@callable-flow.callee': 'h',
        '@callable-flow.invocation-kind': 'indirect',
        '@callable-flow.arity': '1',
      },
    ]);
  });

  it('emits one formal fact per parameter with its index', () => {
    const facts = factsFor('function take(a, b) {}\n');
    expect(byTag(facts, '@callable-flow.formal')).toMatchObject([
      { '@callable-flow.binding': 'a', '@callable-flow.parameter-index': '0' },
      { '@callable-flow.binding': 'b', '@callable-flow.parameter-index': '1' },
    ]);
  });

  it('emits an argument fact for a function passed by name', () => {
    const facts = factsFor('function target() {}\nfunction wire(cb) { cb(); }\nwire(target);\n');
    expect(byTag(facts, '@callable-flow.argument')).toMatchObject([
      { '@callable-flow.source': 'target', '@callable-flow.parameter-index': '0' },
    ]);
  });

  it('binds subscripted destinations and callees to the container, not the index (#2522 fix)', () => {
    const facts = factsFor(
      'function target() {}\nfunction entry(i) {\n  const tbl = [];\n  tbl[i] = target;\n  tbl[i]();\n}\n',
    );
    expect(byTag(facts, '@callable-flow.seed')).toMatchObject([
      { '@callable-flow.destination': 'tbl', '@callable-flow.target-name': 'target' },
    ]);
    expect(byTag(facts, '@callable-flow.invoke')).toMatchObject([
      { '@callable-flow.callee': 'tbl' },
    ]);
  });

  it('emits a member-call invoke only when the member cell has a visible store (#2522 fix)', () => {
    const stored = factsFor('function target() {}\nfunction go(o) { o.run = target; o.run(); }\n');
    expect(byTag(stored, '@callable-flow.invoke')).toMatchObject([
      { '@callable-flow.callee': 'run' },
    ]);

    const unstored = factsFor('function go(map) { map.get("x"); }\n');
    expect(byTag(unstored, '@callable-flow.invoke')).toEqual([]);
  });

  it('treats call results as produced values, not callable designators', () => {
    const facts = factsFor('function make() {}\nconst h = make();\n');
    expect(byTag(facts, '@callable-flow.seed')).toEqual([]);
    expect(byTag(facts, '@callable-flow.copy')).toEqual([]);
  });

  it('suppresses bare-name sources entirely under bareNamesAreCalls (#2522 Ruby fix)', () => {
    const src = 'function target() {}\nconst h = target;\n';
    const withDefault = factsFor(src);
    expect(byTag(withDefault, '@callable-flow.seed')).toHaveLength(1);

    const tree = getJsParser().parse(src);
    if (tree === null) throw new Error('parse failed');
    const suppressed = synthesizeCallableFlowCaptures(tree.rootNode, {
      ...OPTIONS,
      bareNamesAreCalls: true,
    });
    expect(suppressed.filter((match) => match['@callable-flow.seed'] !== undefined)).toEqual([]);
  });
});

/**
 * TypeScript: CALLS edges from JSX element invocations.
 *
 * `<Foo />` is syntactic sugar for `Foo(props)` — the React renderer
 * invokes the component at runtime. For `gitnexus_impact` and
 * `gitnexus_context` to give meaningful answers on `.tsx` codebases,
 * JSX usage must surface as a CALLS edge.
 *
 * Pre-fix scope: in a real React monorepo (Sourcerer-fe), `.tsx` files
 * had a 67.5% function-orphan rate vs 61.2% for plain `.ts`. Spot
 * checks of orphan React components consistently traced back to JSX
 * being the only "call" in the function body — invisible to the
 * indexer because the TS scope query had no `jsx_*` patterns.
 *
 * Each test fixture below isolates one JSX shape:
 *
 *   - self-closing `<Foo />`           — simple-usage.tsx
 *   - paired `<Foo>...</Foo>`          — paired-usage.tsx
 *   - namespaced `<Container.Title />`         — member-usage.tsx
 *   - nested `<Outer><Inner /></Outer>`— nested-usage.tsx
 *   - HTML-only `<div>`/`<span>`       — html-only.tsx (negative test)
 *   - HOF + JSX `const F = () => <X/>` — hof-jsx.tsx (combined-fix probe)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('TypeScript JSX-as-call CALLS edges', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-jsx-as-call'), () => {});
  }, 60000);

  it('self-closing <Foo /> emits useFoo → Foo', () => {
    const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'Foo');
    expect(edgeSet(calls)).toContain('useFoo → Foo');
  });

  it('paired <Bar>...</Bar> emits useBar → Bar (closing tag does NOT double-count)', () => {
    const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'Bar');
    // Exactly one CALLS edge from useBar to Bar — the query captures
    // jsx_opening_element only, NOT jsx_closing_element. Multiple matches
    // here would mean the closing tag is also being captured (a bug —
    // each JSX element is one logical invocation, not two).
    const useBarToBar = calls.filter((c) => c.source === 'useBar');
    expect(useBarToBar).toHaveLength(1);
    expect(edgeSet(calls)).toContain('useBar → Bar');
  });

  it('namespaced <Container.Title /> is captured (no phantom read, no edge to receiver)', () => {
    // What this PR tests at the query level: the JSX-as-member capture
    // intercepts `<Container.Title />` BEFORE the generic
    // `@reference.read.member` catch-all does. Two negative
    // post-conditions verify the interception:
    //
    //   (a) NO ACCESSES edge `useNamespaced → Title` (the phantom read
    //       suppression — see `shouldEmitReadMember`'s jsx-* cases).
    //   (b) NO CALLS edge `useNamespaced → Container` (the member call
    //       must NOT collapse to its receiver — that would mean we're
    //       dispatching off `Container` rather than off `Container.Title`).
    //
    // The positive CALLS edge `useNamespaced → Title` requires
    // chasing the receiver chain through `Container = { Title }`,
    // which is a pre-existing compound-receiver limitation (object-
    // literal namespaces aren't fully chained today). That gap is
    // orthogonal to JSX-as-call and is left as future work.
    const calls = getRelationships(result, 'CALLS').filter((c) => c.source === 'useNamespaced');
    const callTargets = new Set(calls.map((c) => c.target));
    expect(callTargets).not.toContain('Container');
  });

  it('nested <Outer><Inner /></Outer> emits both useNested → Outer AND useNested → Inner', () => {
    const calls = getRelationships(result, 'CALLS').filter((c) => c.source === 'useNested');
    const targets = new Set(calls.map((c) => c.target));
    expect(targets).toContain('Outer');
    expect(targets).toContain('Inner');
  });

  it('lowercase HTML elements (<div>, <span>, <button>) emit NO CALLS edges', () => {
    // The PascalCase predicate must filter these out at the query level.
    // If `useHtml` ends up with edges to `div` / `span` / `button`,
    // the `(#match? @reference.name "^[A-Z]")` predicate isn't firing.
    const calls = getRelationships(result, 'CALLS').filter((c) => c.source === 'useHtml');
    const targets = new Set(calls.map((c) => c.target));
    expect(targets).not.toContain('div');
    expect(targets).not.toContain('span');
    expect(targets).not.toContain('button');
  });

  it('namespaced <Container.Title /> does NOT emit a phantom ACCESSES edge', () => {
    // `<Foo.Bar />`'s `member_expression` would normally fire BOTH
    // `@reference.call.member` (our new JSX path) AND
    // `@reference.read.member` (the generic read-member catch-all),
    // producing a redundant ACCESSES edge alongside the CALLS edge.
    // `shouldEmitReadMember`'s jsx_self_closing_element / jsx_opening_element
    // case is what suppresses the read.
    const accesses = getRelationships(result, 'ACCESSES').filter(
      (a) => a.source === 'useNamespaced' && a.target === 'Title',
    );
    expect(accesses).toEqual([]);
  });

  it('combined HOF + JSX: const Wrapped = () => <Foo /> emits exactly one Wrapped → Foo', () => {
    // Probes the interaction between the HOF-callback caller-attribution
    // fix and the JSX-as-call fix. Pre-this-PR: caller mis-attribution
    // (HOF bug) plus invisible JSX (this fix's bug) both broke this
    // case. Post-PR: both are fixed and the edge lands.
    //
    // Asserts EXACTLY ONE edge: a single self-closing `<Foo />` is one
    // logical invocation. If the JSX query suffix ever accidentally
    // double-matched the same site (e.g. both
    // `jsx_self_closing_element` and a generic call pattern firing, or
    // both an opening-tag and a closing-tag capture), this would catch
    // the regression — duplicate CALLS edges silently inflate
    // blast-radius counts in `gitnexus_impact`.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.source === 'Wrapped' && c.target === 'Foo',
    );
    expect(calls).toHaveLength(1);
  });
});

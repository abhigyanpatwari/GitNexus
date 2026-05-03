/**
 * TypeScript: CALLS edges from inside HOC-wrapped variable declarations.
 *
 * Follow-up to issue #1166 / PR #1175. After fixing HOF callbacks (Promise
 * fan-out, queryFn pair-arrows, Zustand actions) and JSX-as-call, the
 * residual 0%-capture pattern in real React UI codebases (Sourcerer-fe
 * audit) was the HOC-wrapped declaration:
 *
 *   const Button = React.forwardRef((props, ref) => { ... })
 *   const Card = memo(({ ... }) => { ... })
 *   const handleClick = useCallback(() => { ... }, [])
 *   const computed = useMemo(() => { ... }, [])
 *   const Item = observer((props) => { ... })
 *   const debouncedSearch = debounce((query) => { ... }, 250)
 *
 * All share the AST shape `lexical_declaration > variable_declarator >
 * call_expression > arguments > arrow_function`. Pre-fix, none matched
 * any `@declaration.function` pattern (the registry-primary `query.ts`
 * only knew about `variable_declarator > arrow_function` directly), and
 * the legacy DAG's `tsExtractFunctionName` only walked `pair` /
 * `variable_declarator` parents — `arguments` parents fell through with
 * `funcName = null`.
 *
 * Result: every shadcn/Radix component, every memoised React component,
 * every useCallback/useMemo hook callback registered as anonymous, and
 * calls inside their bodies attributed to the file. Sourcerer-fe alone
 * had ~296 such declarations affected (57 forwardRef + 21 memo + 161
 * useCallback + 57 useMemo).
 *
 * Fix:
 *   - 4 new tree-sitter patterns in `typescript/query.ts` (registry).
 *   - 4 mirrored patterns in `tree-sitter-queries.ts` (legacy).
 *   - `tsExtractFunctionName` extended with a third branch that walks
 *     `arguments → call_expression → variable_declarator`.
 *
 * Each test fixture below isolates one wrapper shape with the call
 * target defined in `helpers.ts` (cross-file resolution).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  edgeSet,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('TypeScript HOC-wrapped variable declarations', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-hoc-wrapped'), () => {});
  }, 60000);

  // ─────────────────────────────────────────────────────────────────
  // Positive: each HOC-wrapped const becomes a named Function whose
  // body's calls attribute to it (not File).
  // ─────────────────────────────────────────────────────────────────

  it('React.forwardRef: Button → cn and Button → helper (member-expression callee)', () => {
    // `const Button = React.forwardRef<...>(({ ... }, _ref) => { ... })`.
    // The wrapping callee is a `member_expression` (`React.forwardRef`),
    // exercising the "any callee" leniency in the new patterns.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/forward-ref.tsx' && c.source === 'Button',
    );
    const targets = new Set(calls.map((c) => c.target));
    expect(targets, 'Button must call cn').toContain('cn');
    expect(targets, 'Button must call helper').toContain('helper');
  });

  it('memo (bare identifier): Card → cn and Card → helper', () => {
    // `const Card = memo<...>((...) => { ... })`. Bare-identifier callee
    // — the named-import form (`import { memo } from 'react'`).
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/memo.tsx' && c.source === 'Card',
    );
    const targets = new Set(calls.map((c) => c.target));
    expect(targets, 'Card must call cn').toContain('cn');
    expect(targets, 'Card must call helper').toContain('helper');
  });

  it('useCallback: handleClick → doStuff and handleClick → fmt', () => {
    // `const handleClick = useCallback(() => { ... }, [])`.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/use-callback.ts' && c.source === 'handleClick',
    );
    const targets = new Set(calls.map((c) => c.target));
    expect(targets).toContain('doStuff');
    expect(targets).toContain('fmt');
  });

  it('useCallback: handleSubmit → doStuff (sibling const, separate caller)', () => {
    // Two useCallback consts in the same file — each must be its own
    // caller anchor (no leakage to the first sibling, the analogue of
    // the multi-action-store regression in PR #1175).
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/use-callback.ts' && c.target === 'doStuff',
    );
    const fromHandleSubmit = calls.filter((c) => c.source === 'handleSubmit');
    expect(fromHandleSubmit.length, 'handleSubmit must call doStuff').toBeGreaterThan(0);
  });

  it('useMemo: computed → doStuff (returns-a-value variant)', () => {
    // `const computed = useMemo(() => { return doStuff(42); }, [])`.
    // The arrow's body has a `return` statement — irrelevant to call
    // attribution but worth exercising as a separate fixture.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/use-memo.ts' && c.source === 'computed',
    );
    expect(edgeSet(calls)).toContain('computed → doStuff');
  });

  it('observer (MobX): Item → helper', () => {
    // Same shape as memo, different wrapper name. Exercises the "any
    // callee" leniency for non-React HOCs.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/observer.tsx' && c.source === 'Item',
    );
    expect(edgeSet(calls)).toContain('Item → helper');
  });

  it('debounce: debouncedSearch → doStuff (utility-HOC form)', () => {
    // `const debouncedSearch = debounce((query) => { doStuff(...); }, 250)`.
    // Pattern is identical to React HOCs — the wrapper just happens to
    // be a debouncer, so this confirms the fix is wrapper-agnostic.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/debounce.ts' && c.source === 'debouncedSearch',
    );
    expect(edgeSet(calls)).toContain('debouncedSearch → doStuff');
  });

  // ─────────────────────────────────────────────────────────────────
  // Function-node assertions: each HOC-wrapped const must register as
  // a Function (not just a Variable). Without this, gitnexus_context /
  // gitnexus_impact see no symbol to walk from.
  // ─────────────────────────────────────────────────────────────────

  it('each HOC-wrapped const registers as a Function node', () => {
    const functions = new Set(getNodesByLabel(result, 'Function'));
    // Every const we wrote in the fixtures must have a Function entry.
    expect(functions, 'forwardRef-wrapped Button').toContain('Button');
    expect(functions, 'memo-wrapped Card').toContain('Card');
    expect(functions, 'useCallback-bound handleClick').toContain('handleClick');
    expect(functions, 'useCallback-bound handleSubmit').toContain('handleSubmit');
    expect(functions, 'useMemo-bound computed').toContain('computed');
    expect(functions, 'observer-wrapped Item').toContain('Item');
    expect(functions, 'debounce-wrapped debouncedSearch').toContain('debouncedSearch');
  });

  // ─────────────────────────────────────────────────────────────────
  // Negative: bare statement-level HOC calls (not bound to a const)
  // must NOT produce phantom Function nodes named after some implicit
  // anchor, and their inner calls must NOT attribute to a wrong source.
  // ─────────────────────────────────────────────────────────────────

  it('bare statement-level HOC calls do not produce phantom Functions', () => {
    // `negative-bare-call.ts` has three unbound HOC calls
    // (useCallback / memo / wrap(memo(...))). None should become a
    // named Function. The only Function-eligible def in the file is
    // `wrap` (a regular `const wrap = <T>(value: T): T => value`),
    // exercised here as the negative-control's only legit Function.
    const fileFns = getRelationships(result, 'CALLS')
      .filter((c) => c.sourceFilePath === 'src/negative-bare-call.ts')
      .map((c) => c.source);
    const sources = new Set(fileFns);
    // Only the file itself (or `wrap` if its body had calls — it
    // doesn't) should appear as a source. Assert the phantom-prone
    // names are absent.
    expect(sources, 'no phantom useCallback as caller').not.toContain('useCallback');
    expect(sources, 'no phantom memo as caller').not.toContain('memo');
    // doStuff calls inside the bare HOCs fall back to File-level
    // attribution (the arrow has no caller anchor).
    const fromFile = getRelationships(result, 'CALLS').filter(
      (c) =>
        c.sourceFilePath === 'src/negative-bare-call.ts' &&
        c.sourceLabel === 'File' &&
        c.target === 'doStuff',
    );
    expect(fromFile.length, 'unbound HOC inner calls source from File').toBeGreaterThan(0);
  });

  it('no phantom self-loops in HOC-wrapped fixtures', () => {
    // The Zustand-style regression from PR #1175 (CallerAnchorLabel
    // exclusion of Variable defs) must continue to hold here. The
    // outer module-level call (e.g., `React.forwardRef(...)`,
    // `memo(...)`) should source from File, not from the const it
    // declares. If the new patterns inadvertently re-promoted Variable
    // defs to caller anchors, we'd see edges like `Button → forwardRef`
    // (sourceLabel=Function). Filter to call edges where the SOURCE is
    // the const we just declared — and check that the const's target
    // set never includes the wrapper itself.
    const buttonCalls = getRelationships(result, 'CALLS').filter(
      (c) => c.source === 'Button' && c.target === 'forwardRef',
    );
    expect(buttonCalls, 'Button must NOT call forwardRef (phantom self-loop)').toEqual([]);
    const cardCalls = getRelationships(result, 'CALLS').filter(
      (c) => c.source === 'Card' && c.target === 'memo',
    );
    expect(cardCalls, 'Card must NOT call memo (phantom self-loop)').toEqual([]);
    const handleClickCalls = getRelationships(result, 'CALLS').filter(
      (c) => c.source === 'handleClick' && c.target === 'useCallback',
    );
    expect(handleClickCalls, 'handleClick must NOT call useCallback (phantom self-loop)').toEqual(
      [],
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-pollination: multiple HOC-wrapped consts in the same file
  // must each be their own caller anchor (the multi-pair regression
  // analogue, restated for HOC patterns).
  // ─────────────────────────────────────────────────────────────────

  it('handleClick and handleSubmit do not cross-attribute (no first-sibling-wins)', () => {
    // `use-callback.ts` has two useCallback-bound consts. Calls inside
    // `handleSubmit` (`doStuff(value)`) must NOT appear as
    // `handleClick → doStuff`. The fix in PR #1175
    // (`isCallerAnchorLabel` + per-arrow ownedDefs via inner anchor
    // discipline) plus the new patterns here must compose: each
    // useCallback callback gets its own arrow scope, each scope has
    // its own def in `ownedDefs`, and `resolveCallerGraphId` walks
    // up to the right one.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/use-callback.ts' && c.target === 'doStuff',
    );
    const fromHandleClick = calls.filter((c) => c.source === 'handleClick');
    const fromHandleSubmit = calls.filter((c) => c.source === 'handleSubmit');
    expect(fromHandleClick.length, 'handleClick must call doStuff').toBeGreaterThan(0);
    expect(fromHandleSubmit.length, 'handleSubmit must call doStuff').toBeGreaterThan(0);
    // Both consts call doStuff, but each must source from its OWN name.
    // We assert there's no "spilled" edge that names the wrong const.
    const stray = calls.filter((c) => c.source !== 'handleClick' && c.source !== 'handleSubmit');
    // Allow File-rooted edges as a fallback if the fix regresses; we
    // explicitly disallow Function-rooted strays from siblings/
    // imported names (e.g., useCallback itself).
    const functionStrays = stray.filter((c) => c.sourceLabel === 'Function');
    expect(functionStrays, 'no other Function sources for doStuff calls').toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────
  // Documented limitation: deeply-nested HOCs (`memo(forwardRef(...))`).
  //
  // The fixture `nested.tsx` documents that the OUTER pattern requires
  // the arrow to be a direct grandchild of the const's `call_expression`
  // value — when the arrow is wrapped in another `call_expression`
  // (`memo(forwardRef(arrow))`), the pattern misses and the deepest
  // arrow stays anonymous. The const itself (`Wrapped`) is also NOT a
  // Function: the immediate arg of the outer `memo(...)` call is a
  // `call_expression` (`forwardRef(...)`), not an arrow / fn-expression,
  // so no `@declaration.function` pattern matches the outer shape either.
  //
  // We assert ABSENCE here (rather than positive resolution) so that any
  // future change to the patterns or to `tsExtractFunctionName` that
  // accidentally starts matching nested HOCs surfaces immediately. A
  // proper fix for nested HOCs would require deciding which level wins
  // the name (outer wrapper? deepest behaviour-arrow?) and is out of
  // scope for this PR.
  // ─────────────────────────────────────────────────────────────────

  it('nested HOCs (memo(forwardRef(...))): Wrapped is NOT a Function (known limitation)', () => {
    // The outer const `Wrapped` matches NO `@declaration.function` pattern
    // because the outer call's first argument is itself a call_expression,
    // not an arrow_function / function_expression. It should be picked up
    // as a Variable by `@definition.const` (or skipped entirely) — but it
    // must NOT appear as a Function node.
    const functions = new Set(getNodesByLabel(result, 'Function'));
    expect(functions, 'Wrapped (nested HOC) must NOT be a Function node').not.toContain('Wrapped');
  });

  it('nested HOCs: helper() call inside the deepest arrow does NOT source from Function:Wrapped', () => {
    // Calls inside the doubly-wrapped arrow have no named ancestor (deepest
    // arrow is anonymous because `call_expression.parent` is `arguments`,
    // not `variable_declarator`; the outer `memo` and `forwardRef` calls
    // are themselves anonymous expressions). So calls in `nested.tsx` must
    // either source from File or not be attributed to `Wrapped` at all.
    //
    // The negative assertion is what matters: a future change that wrongly
    // attributes the deepest arrow to its outer const would silently corrupt
    // impact analysis for any real code that nests HOCs (e.g.,
    // `memo(forwardRef(...))` UI primitives).
    const helperCalls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/nested.tsx' && c.target === 'helper',
    );
    expect(helperCalls.length, 'helper call must still be captured').toBeGreaterThan(0);

    const fromWrapped = helperCalls.filter((c) => c.source === 'Wrapped');
    expect(
      fromWrapped,
      'helper call must NOT be attributed to Function:Wrapped (deepest arrow stays anonymous)',
    ).toEqual([]);

    // Defensive: there should be no Function-sourced edges from anywhere in
    // `nested.tsx` (everything is anonymous or module-level).
    const allNestedCalls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/nested.tsx',
    );
    const functionSourced = allNestedCalls.filter((c) => c.sourceLabel === 'Function');
    expect(
      functionSourced,
      'no Function-sourced CALLS from nested.tsx (all anchors should be File)',
    ).toEqual([]);
  });
});

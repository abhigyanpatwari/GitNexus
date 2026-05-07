/**
 * Regression coverage for issue #1166: CALLS edge collector misses ~75% of
 * functions in HOF / callback patterns.
 *
 * The bug had two distinct roots, both in the funcName fallback used by
 * `findEnclosingFunctionId` (parse-worker.ts) and `findEnclosingFunction`
 * (call-processor.ts):
 *
 *     const efnResult = provider.methodExtractor?.extractFunctionName?.(current);
 *     const funcName = efnResult?.funcName ?? genericFuncName(current);
 *
 *  A. `genericFuncName` scanned `arrow_function` / `function_expression`
 *     children for the first identifier and returned it. For unparenthesized
 *     arrows like `file => processFile(file)` the first identifier is the
 *     parameter `file`, so calls inside got attributed to a phantom
 *     `Function file` ID. The CALLS edges were emitted with a dangling
 *     sourceId and never showed up in `(:Function)-[:CALLS]->()` queries.
 *
 *  B. `tsExtractFunctionName` only named arrows whose parent was
 *     `variable_declarator`. Object-property arrows like
 *     `addItem: (item) => set(...)` (Zustand / TanStack / config objects)
 *     have a `pair` parent and were treated as anonymous. With no named
 *     ancestor up to the file, every call inside fell back to the File ID.
 *
 * These tests pin attribution behavior for both root causes and the common
 * patterns from the issue (Zustand store, Promise.all+map, TanStack query).
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import { TYPESCRIPT_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { typescriptProvider } from '../../src/core/ingestion/languages/typescript.js';
import {
  FUNCTION_NODE_TYPES,
  genericFuncName,
  inferFunctionLabel,
  type SyntaxNode,
} from '../../src/core/ingestion/utils/ast-helpers.js';

// ─── Test harness ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TS_GRAMMAR = (TS as any).typescript as Parameters<Parser['setLanguage']>[0];

function makeParserAndQuery(): { parser: Parser; query: Parser.Query } {
  const parser = new Parser();
  parser.setLanguage(TS_GRAMMAR);
  const query = new Parser.Query(TS_GRAMMAR, TYPESCRIPT_QUERIES);
  return { parser, query };
}

/**
 * Mirror of the name-resolution slice of `findEnclosingFunctionId`
 * (parse-worker.ts) and `findEnclosingFunction` (call-processor.ts).
 *
 * We deliberately re-implement the parent walk here rather than importing
 * the production function: parse-worker.ts is a Worker entry point that
 * can't be loaded from the main thread, and the function is private to
 * its module. Using the same exported primitives (FUNCTION_NODE_TYPES,
 * genericFuncName, provider.methodExtractor.extractFunctionName) means a
 * real fix flows through here unchanged.
 */
function attributeCall(callNode: SyntaxNode): { name: string | null; nodeType: string | null } {
  let current = callNode.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const efn = typescriptProvider.methodExtractor?.extractFunctionName?.(current);
      const funcName = efn?.funcName ?? genericFuncName(current);
      // Touch inferFunctionLabel so the import isn't dead — it's the same
      // call the real findEnclosingFunctionId makes and we want to keep
      // this harness aligned with production.
      void inferFunctionLabel(current.type);
      if (funcName) return { name: funcName, nodeType: current.type };
    }
    current = current.parent;
  }
  return { name: null, nodeType: null };
}

interface CallSite {
  calledName: string;
  line: number;
  attributedTo: string | null;
}

function collectCallAttributions(code: string): CallSite[] {
  const { parser, query } = makeParserAndQuery();
  const tree = parser.parse(code);
  const results: CallSite[] = [];
  for (const match of query.matches(tree.rootNode)) {
    const captures: Record<string, SyntaxNode> = {};
    for (const c of match.captures) captures[c.name] = c.node;
    if (!captures['call'] || !captures['call.name']) continue;
    const callNode = captures['call'];
    const name = captures['call.name'].text;
    results.push({
      calledName: name,
      line: callNode.startPosition.row + 1,
      attributedTo: attributeCall(callNode).name,
    });
  }
  return results;
}

function findCall(sites: CallSite[], name: string): CallSite | undefined {
  return sites.find((s) => s.calledName === name);
}

// ─── Bug A: genericFuncName must not return parameter identifiers ───────────

describe('issue #1166 — Bug A: anonymous arrows do not borrow parameter names', () => {
  it('returns null for arrow_function (would otherwise leak parameter identifier)', () => {
    const { parser } = makeParserAndQuery();
    // Single-param unparenthesized arrow: `file => processFile(file)`.
    // tree-sitter-typescript wires the parameter as a direct identifier
    // child of the arrow, so genericFuncName's "first identifier child"
    // fallback used to return "file".
    const tree = parser.parse('const x = files.map(file => processFile(file));');
    let arrow: SyntaxNode | null = null;
    const walk = (n: SyntaxNode) => {
      if (n.type === 'arrow_function') {
        arrow = n;
        return;
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        if (arrow) return;
        const child = n.namedChild(i);
        if (child) walk(child);
      }
    };
    walk(tree.rootNode);
    expect(arrow).not.toBeNull();
    expect(genericFuncName(arrow!)).toBeNull();
  });

  it('returns null for function_expression (would otherwise leak named-funexpr identifier)', () => {
    const { parser } = makeParserAndQuery();
    // `function (x) { return x; }` (anonymous function expression). We
    // also accept named expressions like `function inner(x) { ... }`
    // returning null here — naming for those flows through the parent
    // (variable_declarator / pair / call argument), same as arrows.
    const tree = parser.parse('const x = arr.filter(function (x) { return isOk(x); });');
    let fnExpr: SyntaxNode | null = null;
    const walk = (n: SyntaxNode) => {
      if (n.type === 'function_expression') {
        fnExpr = n;
        return;
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        if (fnExpr) return;
        const child = n.namedChild(i);
        if (child) walk(child);
      }
    };
    walk(tree.rootNode);
    expect(fnExpr).not.toBeNull();
    expect(genericFuncName(fnExpr!)).toBeNull();
  });

  it('attributes call inside `.map(file => fn(file))` to the outer named function, not "file"', () => {
    const sites = collectCallAttributions(`
      export const processSelectedFiles = async (files: File[]) => {
        return Promise.all(files.map(file => processFile(file)));
      };
    `);
    const processFileCall = findCall(sites, 'processFile');
    expect(processFileCall, 'processFile call should be captured').toBeDefined();
    expect(processFileCall!.attributedTo).toBe('processSelectedFiles');
    // Defensive: assert we never produce the bogus parameter-as-name
    // attribution for ANY call in this snippet.
    for (const s of sites) {
      expect(s.attributedTo, `call ${s.calledName} at L${s.line}`).not.toBe('file');
    }
  });

  it('attributes call inside parenthesized single-param arrow to the outer function', () => {
    // `(item) => doStuff(item)` — different from unparenthesized `item => ...`
    // because the param sits inside `formal_parameters` and isn't a direct
    // child. Used to work; we pin it to guard against future regressions.
    const sites = collectCallAttributions(`
      export const handler = (items: Item[]) => items.forEach((item) => doStuff(item));
    `);
    const doStuff = findCall(sites, 'doStuff');
    expect(doStuff?.attributedTo).toBe('handler');
  });
});

// ─── Bug B: object-property arrows take their name from pair.key ────────────

describe('issue #1166 — Bug B: object-property arrows are named by pair.key', () => {
  it('attributes call inside `addItem: (item) => fn(item)` to "addItem"', () => {
    const sites = collectCallAttributions(`
      export const store = {
        addItem: (item) => doSomething(item),
        fetchData: async () => {
          const result = await api.fetch();
          return result;
        },
      };
    `);
    const doSomething = findCall(sites, 'doSomething');
    expect(doSomething?.attributedTo).toBe('addItem');
    const fetchCall = findCall(sites, 'fetch');
    // `fetch` is in BUILT_INS in typescript.ts, but the harness here doesn't
    // filter built-ins — what we care about is the *attribution*, which
    // should be 'fetchData', not the file.
    expect(fetchCall?.attributedTo).toBe('fetchData');
  });

  it('handles function_expression pair values (`addItem: function(item) { ... }`)', () => {
    const sites = collectCallAttributions(`
      export const store = {
        addItem: function (item) { doSomething(item); },
      };
    `);
    expect(findCall(sites, 'doSomething')?.attributedTo).toBe('addItem');
  });

  it('handles string-key pairs (`"add-item": (item) => ...`)', () => {
    const sites = collectCallAttributions(`
      export const store = {
        "add-item": (item) => doSomething(item),
      };
    `);
    expect(findCall(sites, 'doSomething')?.attributedTo).toBe('add-item');
  });

  it('handles computed property keys gracefully — falls back to outer scope or file', () => {
    // Computed keys like `[ACTION_KEY]: (item) => fn(item)` cannot be
    // statically named. We don't want to invent a name from inner tokens.
    // Either attribute to the enclosing named scope, or to null (file) —
    // both are acceptable; what matters is no phantom IDs.
    const sites = collectCallAttributions(`
      export const buildStore = () => ({
        [ACTION_KEY]: (item) => doSomething(item),
      });
    `);
    const attr = findCall(sites, 'doSomething')?.attributedTo;
    expect([null, 'buildStore']).toContain(attr);
  });

  it('handles Zustand-style nested HOF — calls inside addItem attribute to "addItem"', () => {
    const sites = collectCallAttributions(`
      export const useStore = create<State>()(
        devtools(persist((set, get) => ({
          addItem: (item) => set((state) => doSomething(state, item)),
          fetchData: async () => {
            const result = await api.fetch();
            return result;
          },
        }), { name: 'store' }))
      );
    `);
    const doSomething = findCall(sites, 'doSomething');
    expect(doSomething, 'doSomething call should be captured').toBeDefined();
    expect(doSomething!.attributedTo).toBe('addItem');
    const fetchCall = findCall(sites, 'fetch');
    expect(fetchCall?.attributedTo).toBe('fetchData');
    // `set` and `state` are local to the callback chain. `set` lives in the
    // body of the addItem arrow → addItem is the right caller.
    const setCall = findCall(sites, 'set');
    expect(setCall?.attributedTo).toBe('addItem');
  });

  it('handles TanStack Query factory — `queryFn: () => api.getUser()` attributes to "queryFn"', () => {
    const sites = collectCallAttributions(`
      export const useUserQuery = () =>
        useQuery({
          queryFn: () => api.getUser(),
          queryKey: ['user'],
        });
    `);
    const getUser = findCall(sites, 'getUser');
    expect(getUser?.attributedTo).toBe('queryFn');
  });
});

// ─── Definition-phase consistency ───────────────────────────────────────────

describe('issue #1166 — definition-phase consistency', () => {
  /** Run TYPESCRIPT_QUERIES and return the names captured under @definition.function. */
  function definedFunctionNames(code: string): string[] {
    const { parser, query } = makeParserAndQuery();
    const tree = parser.parse(code);
    const out: string[] = [];
    for (const match of query.matches(tree.rootNode)) {
      let isFn = false;
      let name: string | undefined;
      for (const c of match.captures) {
        if (c.name === 'definition.function') isFn = true;
        if (c.name === 'name') name = c.node.text;
      }
      if (isFn && name) out.push(name);
    }
    return out;
  }

  it('captures pair-with-arrow as @definition.function so call sourceIds resolve', () => {
    const names = definedFunctionNames(`
      export const store = {
        addItem: (item) => doSomething(item),
        fetchData: async () => api.fetch(),
      };
    `);
    // Both addItem and fetchData should appear so that the Function nodes
    // exist when calls inside them claim sourceId = Function:file:addItem.
    expect(names).toContain('addItem');
    expect(names).toContain('fetchData');
  });

  it('captures pair-with-function-expression as @definition.function', () => {
    const names = definedFunctionNames(`
      export const store = {
        legacy: function (x) { return doStuff(x); },
      };
    `);
    expect(names).toContain('legacy');
  });

  it('captures string-key pairs (`"add-item": () => ...`)', () => {
    const names = definedFunctionNames(`
      export const store = {
        "add-item": (item) => doSomething(item),
      };
    `);
    expect(names).toContain('add-item');
  });

  it('does not invent names for computed-key pairs (`[K]: () => ...`)', () => {
    const names = definedFunctionNames(`
      export const store = {
        [ACTION_KEY]: (item) => doSomething(item),
      };
    `);
    // Whatever else is captured, we must NOT capture a Function named
    // "ACTION_KEY" (it's a value reference, not a property name).
    expect(names).not.toContain('ACTION_KEY');
  });

  it('still captures top-level `const fn = () => ...` (regression)', () => {
    const names = definedFunctionNames(`
      export const helper = (x: number) => x + 1;
    `);
    expect(names).toContain('helper');
  });
});

// ─── Regression guards: existing patterns still work ────────────────────────

describe('issue #1166 — regression guards', () => {
  it('attributes calls in plain helper functions correctly (control)', () => {
    const sites = collectCallAttributions(`
      export const validateFile = (file: File) => {
        return sharedValidateFile(file);
      };

      export const processFile = async (file: File) => {
        const result = validateFile(file);
        return fileToDataUrl(file);
      };
    `);
    expect(findCall(sites, 'sharedValidateFile')?.attributedTo).toBe('validateFile');
    expect(findCall(sites, 'validateFile')?.attributedTo).toBe('processFile');
    expect(findCall(sites, 'fileToDataUrl')?.attributedTo).toBe('processFile');
  });

  it('attributes calls inside Promise constructor callbacks to the enclosing named arrow', () => {
    // `new Promise((resolve, reject) => { ... })` — the callback is anonymous,
    // its parent is `arguments`. Walk continues to the outer
    // `(file) => new Promise(...)` arrow, which IS named via variable_declarator.
    const sites = collectCallAttributions(`
      export const fileToDataUrl = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsDataURL(file);
        });
    `);
    expect(findCall(sites, 'FileReader')?.attributedTo).toBe('fileToDataUrl');
    expect(findCall(sites, 'readAsDataURL')?.attributedTo).toBe('fileToDataUrl');
  });

  it('attributes top-level calls in module-init expressions to the file (no enclosing function)', () => {
    // `const useStore = create(...)(...)` — the calls live in the value
    // expression of useStore itself, NOT inside any function body. The
    // right answer here is "no enclosing function" (file-level). This pins
    // that we don't accidentally start treating Variables as Functions.
    const sites = collectCallAttributions(`
      export const useStore = create<State>()(devtools(persist({}, { name: 'store' })));
    `);
    expect(findCall(sites, 'create')?.attributedTo).toBeNull();
    expect(findCall(sites, 'devtools')?.attributedTo).toBeNull();
    expect(findCall(sites, 'persist')?.attributedTo).toBeNull();
  });
});

// ─── HOC-wrapped variable declarations (issue #1166 follow-up) ──────────────

describe('issue #1166 follow-up — HOC-wrapped variable declarations', () => {
  // The third `tsExtractFunctionName` branch: `arguments → call_expression →
  // variable_declarator`. Covers React.forwardRef / memo / useCallback /
  // useMemo / observer / debounce — every HOC factory whose result is bound
  // to a const. Without this branch, the wrapped arrow had no name and calls
  // inside attributed to the file. See `languages/typescript.ts` for the
  // resolution logic and `tree-sitter-queries.ts` for the @definition.function
  // capture mirror.

  it('attributes call inside `const X = forwardRef((p, r) => fn())` to "X"', () => {
    // Bare-identifier callee form. The arrow's parent is `arguments`; the
    // walker climbs to `call_expression` then to `variable_declarator` and
    // returns the const's name.
    const sites = collectCallAttributions(`
      const Button = forwardRef((props, ref) => {
        return doSomething(props);
      });
    `);
    const call = findCall(sites, 'doSomething');
    expect(call, 'doSomething call should be captured').toBeDefined();
    expect(call!.attributedTo).toBe('Button');
  });

  it('attributes call inside `const X = React.forwardRef((p, r) => fn())` to "X" (member-expression callee)', () => {
    // Member-expression callee form (`React.forwardRef`). The `arguments`-
    // parent walk doesn't constrain the function field, so this resolves
    // identically to the bare-identifier form.
    const sites = collectCallAttributions(`
      const Card = React.forwardRef((props, ref) => {
        return doStuff(props);
      });
    `);
    expect(findCall(sites, 'doStuff')?.attributedTo).toBe('Card');
  });

  it('attributes call inside `const X = useCallback(() => fn(), [])` to "X"', () => {
    // useCallback / useMemo are the most common HOC-wrapped form in real
    // React codebases. The trailing `[deps]` array doesn't affect the walk
    // — the arrow is still the first `arguments` child.
    const sites = collectCallAttributions(`
      const handleClick = useCallback(() => {
        sendEvent('click');
      }, []);
    `);
    expect(findCall(sites, 'sendEvent')?.attributedTo).toBe('handleClick');
  });

  it('attributes call inside `const X = memo((props) => fn())` to "X"', () => {
    const sites = collectCallAttributions(`
      const Item = memo((props) => {
        return render(props);
      });
    `);
    expect(findCall(sites, 'render')?.attributedTo).toBe('Item');
  });

  it('does NOT name the HOC callback after its sibling (no first-sibling-wins regression)', () => {
    // Two HOC-wrapped consts in the same module — each must take its own
    // name, not bleed into the first declared. Mirrors the multi-action
    // Zustand regression from PR #1175 review applied to HOC patterns.
    const sites = collectCallAttributions(`
      const handleClick = useCallback(() => {
        doA();
      }, []);

      const handleSubmit = useCallback((value) => {
        doB(value);
      }, []);
    `);
    expect(findCall(sites, 'doA')?.attributedTo).toBe('handleClick');
    expect(findCall(sites, 'doB')?.attributedTo).toBe('handleSubmit');
  });

  it('does NOT name a bare statement-level HOC call (unbound result)', () => {
    // `useCallback(() => doStuff(), [])` at statement level (result thrown
    // away). The walk climbs `arguments → call_expression → expression_statement`,
    // which is NOT `variable_declarator`, so the branch returns null and the
    // arrow stays anonymous. Calls inside attribute to no enclosing function.
    const sites = collectCallAttributions(`
      useCallback(() => {
        doSomething();
      }, []);
    `);
    // The `useCallback` call itself is module-level → null. The `doSomething`
    // call is inside an unnamed arrow → null. Both must NOT borrow a name.
    expect(findCall(sites, 'doSomething')?.attributedTo).toBeNull();
    expect(findCall(sites, 'useCallback')?.attributedTo).toBeNull();
  });

  // ─── Definition-phase: HOC-wrapped consts must register as @definition.function ───

  function definedFunctionNames(code: string): string[] {
    const { parser, query } = makeParserAndQuery();
    const tree = parser.parse(code);
    const out: string[] = [];
    for (const match of query.matches(tree.rootNode)) {
      let isFn = false;
      let name: string | undefined;
      for (const c of match.captures) {
        if (c.name === 'definition.function') isFn = true;
        if (c.name === 'name') name = c.node.text;
      }
      if (isFn && name) out.push(name);
    }
    return out;
  }

  it('captures `const X = HOC((args) => ...)` as @definition.function in TYPESCRIPT_QUERIES', () => {
    // The query mirror of the resolver fix. Without these patterns,
    // `Function:X` would never enter the registry on the legacy DAG and
    // any CALLS edge claiming `Function:X` as source would dangle.
    const names = definedFunctionNames(`
      const Button = forwardRef((p, r) => render(p));
      const Card = React.memo((p) => layout(p));
      const handleClick = useCallback(() => doStuff(), []);
      const computed = useMemo(() => result(), []);
      const debounced = debounce((q) => search(q), 250);
      export const Exported = forwardRef((p, r) => render(p));
    `);
    expect(names).toContain('Button');
    expect(names).toContain('Card');
    expect(names).toContain('handleClick');
    expect(names).toContain('computed');
    expect(names).toContain('debounced');
    expect(names).toContain('Exported');
  });

  it('captures `const X = HOC(function (args) { ... })` (function-expression form)', () => {
    // Pre-arrow legacy code uses `function () { ... }` instead of `() => ...`.
    // The mirror pattern uses `(function_expression)` and must trigger.
    const names = definedFunctionNames(`
      const Legacy = wrap(function (x) { return doStuff(x); });
    `);
    expect(names).toContain('Legacy');
  });

  // ─── Documented trade-offs: pin behaviour so future readers aren't surprised ───

  it('accepted false-positive: `const x = arr.find((y) => p(y))` attributes p to "x"', () => {
    // The HOC-wrapped pattern (arrow's parent is `arguments`, grandparent is
    // `call_expression`, great-grandparent is `variable_declarator`) is broad
    // enough to also match chained array-method callbacks like Array#find /
    // Array#some / Array#every — where `x` is a *value* (the result of the
    // method), not a function. The arrow inside borrows the const's name and
    // its inner calls attribute to it.
    //
    // This is documented in `languages/typescript/query.ts` as an accepted
    // trade-off because:
    //   1. `x` is never invoked as a function, so no incoming CALLS edge is
    //      ever created — the spurious `Function:x` is graph-isolated on the
    //      incoming side.
    //   2. The outgoing edge `Function:x → predicate` is a minor mis-attribution
    //      (the call IS happening, just not from a "function called x"), and
    //      the alternative — narrowing the pattern to known HOC names — would
    //      require maintaining a wrapper allowlist that breaks for every new
    //      HOC factory.
    //
    // We pin this here so a future change that tightens the pattern is forced
    // to update this test and re-evaluate the trade-off explicitly.
    const sites = collectCallAttributions(`
      const found = items.find((item) => predicate(item));
    `);
    expect(findCall(sites, 'predicate')?.attributedTo).toBe('found');
  });

  it('multi-arrow argument: both arrows resolve to the same const name (legacy DAG path)', () => {
    // `const x = call(() => first(), () => second())` — both arrows share the
    // same `arguments → call_expression → variable_declarator` ancestor chain,
    // so `tsExtractFunctionName`'s third branch returns "x" for each. Calls
    // inside both arrows therefore attribute to "x" on the legacy DAG path.
    //
    // In the registry-primary pipeline the two arrows produce two candidate
    // `Function:x` defs that the qualified-name dedup collapses into one
    // (last-write-wins by symbol range). The end result is the same set of
    // CALLS edges sourced from "x"; only the def's range changes. We pin the
    // legacy attribution here because that's what the unit harness exercises.
    //
    // The pattern is rare in real code (few APIs take two callbacks both
    // worth tracking), but it does exist in some `register(setup, teardown)`
    // / `addEventListener('event', handler, { once })` shaped helpers. If a
    // future change drops one of the calls or attributes it elsewhere, we
    // want to know.
    const sites = collectCallAttributions(`
      const x = call(() => first(), () => second());
    `);
    expect(findCall(sites, 'first')?.attributedTo).toBe('x');
    expect(findCall(sites, 'second')?.attributedTo).toBe('x');
  });
});

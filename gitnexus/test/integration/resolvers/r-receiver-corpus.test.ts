/**
 * R: the receiver corpus. One table of call shapes with an owner, a decoy and the result the
 * provider gives today, written from a measurement of the built code (not from intent).
 *
 * Every row has a caller, the expected CALLS target (an exact node id, or `null` for no edge) and
 * the resolution outcome recorded at the call (`none` when nothing is recorded). The first row of
 * a group that resolves is the positive control of the negatives beside it: absence is only
 * evidence when the same shape resolves nearby. A `null` row asserts that the caller has no edge
 * at all, so it also covers every decoy; the repository-wide checks add that nothing reaches a
 * decoy and that no site appears that the table does not list.
 *
 * Row kinds:
 *   - `resolves`: the exact target, at the receiver-call confidence;
 *   - `unresolved`: no edge on purpose, with the outcome that says why (the `impact` lower bound);
 *   - `deferred`: no edge because the feature is not built (roxygen types, receiver propagation,
 *     chains without a variable base, `super$` / `private$`). A row is `deferred` when the shape
 *     could resolve one day; its absence is pinned so a change shows up here. Where the result is
 *     INVISIBLE (no edge and no recorded outcome), the row says so.
 *
 * Fixtures (docs/languages/r-ingestion-gaps.md links this file):
 *   - `r-receiver-corpus/`: no DESCRIPTION, so the unique-name fallback is live. `R/models.R`
 *     has R6 `User` and `Address` (both with `save`), `Base` / `Child` (an inherited method) and
 *     `Service`; `R/decoys.R` free functions named like the methods; `R/shapes.R` one function
 *     per cell;
 *   - `r-receiver-corpus-qualified/complete`: packages `pkga` (re-exports `other::fmt`) and
 *     `other`, a script that defines its own `fmt`;
 *   - `r-receiver-corpus-qualified/truncated`: package discovery stops at depth 3, so the
 *     locality of `invisiblepkg` is unknown.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

type Kind = 'resolves' | 'unresolved' | 'deferred';

interface Cell {
  /** The shape, as written at the call. */
  readonly shape: string;
  readonly file: string;
  /** The enclosing function or method (unique in the repository). */
  readonly caller: string;
  /** Text of the call site; the first line after the caller's definition that contains it. */
  readonly site: string;
  /** Exact node id of the CALLS target, or `null` for no edge. */
  readonly target: string | null;
  /** Reasons recorded at the call, or `none`. */
  readonly outcome:
    'none' | 'receiver-unresolved' | 'receiver-owned-but-unbound' | 'member-lookup-ambiguous';
  readonly kind: Kind;
  /** The `resolves` row (by caller) that shows the shape works nearby. Required unless it resolves. */
  readonly control?: string;
  readonly note?: string;
}

const USER_SAVE = 'Method:R/models.R:User.save#0';
const ADDRESS_SAVE = 'Method:R/models.R:Address.save#0';

const M = 'R/models.R';
const S = 'R/shapes.R';
const S4 = 'R/s4.R';

const RECEIVER_CELLS: readonly Cell[] = [
  // A plain free-function call: the control of the shapes that are not receiver calls.
  {
    shape: 'free call: plain_helper()',
    file: S,
    caller: 'free_call_control',
    site: 'plain_helper()',
    target: 'Function:R/shapes.R:plain_helper',
    outcome: 'none',
    kind: 'resolves',
  },
  // Typed receivers (the positive controls).
  {
    shape: 'typed local: u <- User$new(); u$save()',
    file: S,
    caller: 'typed_local',
    site: 'u$save()',
    target: USER_SAVE,
    outcome: 'none',
    kind: 'resolves',
  },
  {
    shape: 'same-name decoy: a <- Address$new(); a$save()',
    file: S,
    caller: 'same_name_decoy',
    site: 'a$save()',
    target: ADDRESS_SAVE,
    outcome: 'none',
    kind: 'resolves',
    note: 'User.save and the free save() share the name; the owner decides',
  },
  {
    shape: 'sibling, typed first: svc <- User$new(); svc$save()',
    file: S,
    caller: 'sibling_typed_first',
    site: 'svc$save()',
    target: USER_SAVE,
    outcome: 'none',
    kind: 'resolves',
  },
  {
    shape: 'sibling, typed second: svc <- User$new(); svc$save()',
    file: S,
    caller: 'sibling_typed_second',
    site: 'svc$save()',
    target: USER_SAVE,
    outcome: 'none',
    kind: 'resolves',
  },
  // `self` inside an R6 method.
  {
    shape: 'self$own() in an R6 method',
    file: M,
    caller: 'self_own',
    site: 'self$climb_up()',
    target: 'Method:R/models.R:Child.climb_up#0',
    outcome: 'none',
    kind: 'resolves',
    note: 'a free climb_up() exists',
  },
  {
    shape: 'self$inherited() in an R6 method',
    file: M,
    caller: 'self_inherited',
    site: 'self$greet()',
    target: 'Method:R/models.R:Base.greet#0',
    outcome: 'none',
    kind: 'resolves',
    note: 'a free greet() exists',
  },
  {
    shape: 'self$missing(): neither the class nor a parent defines it',
    file: M,
    caller: 'self_missing',
    site: 'self$nothere()',
    target: null,
    outcome: 'member-lookup-ambiguous',
    kind: 'unresolved',
    control: 'self_own',
    note: 'a free nothere() exists and is not reached; the label is the shared pass closest one',
  },
  {
    shape: 'self$m() in a free function',
    file: S,
    caller: 'self_free',
    site: 'self$climb_up()',
    target: null,
    outcome: 'receiver-owned-but-unbound',
    kind: 'unresolved',
    control: 'self_own',
    note: 'a free climb_up() exists and is not reached',
  },
  // Not typed.
  {
    shape: 'S4 spelling: u <- new("User"); u$save()',
    file: S,
    caller: 's4_new_spelling',
    site: 'u$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'typed_local',
    note: 'new("Cls") binds the type environment only; the scope binding is the R6 spelling',
  },
  {
    shape: 'untyped local: u <- make_user(); u$save()',
    file: S,
    caller: 'untyped_local',
    site: 'u$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'typed_local',
    note: 'INVISIBLE: no edge and no recorded outcome (the receiver is not a typed variable)',
  },
  {
    shape: 'untyped parameter: function(repo) repo$save()',
    file: S,
    caller: 'untyped_param',
    site: 'repo$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'typed_local',
    note: 'INVISIBLE, as the untyped local',
  },
  {
    shape: 'roxygen @param repo User, a class of the same file',
    file: M,
    caller: 'roxygen_param',
    site: 'repo$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'typed_local',
    note: 'type-extractors/r.ts feeds the type environment only; no edge reads it',
  },
  {
    shape: 'sibling, untyped second: function(svc) svc$save() after a typed svc',
    file: S,
    caller: 'sibling_untyped_second',
    site: 'svc$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'sibling_typed_first',
    note: 'the typed sibling must not lend its type',
  },
  {
    shape: 'sibling, untyped first: function(svc) svc$save() before a typed svc',
    file: S,
    caller: 'sibling_untyped_first',
    site: 'svc$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'sibling_typed_second',
    note: 'the typed sibling must not lend its type',
  },
  // super$ and private$.
  {
    shape: 'super$greet()',
    file: M,
    caller: 'super_call',
    site: 'super$greet()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'self_inherited',
    note: 'nothing binds super to the parent class; Base.greet and the free greet() are not reached',
  },
  {
    shape: 'private$secret()',
    file: M,
    caller: 'private_call',
    site: 'private$secret()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'self_own',
    note: 'nothing binds private to the class; Child.secret is not reached',
  },
  {
    shape: 'RefClass: log_bare(x) in a method, a sibling method by bare name',
    file: M,
    caller: 'refclass_bare',
    site: 'log_bare(x)',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'free_call_control',
    note: 'INVISIBLE: bare names inside a RefClass method are not resolved to its methods',
  },
  {
    shape: 'RefClass: .self$log_dot(x)',
    file: M,
    caller: 'refclass_dot_self',
    site: '.self$log_dot(x)',
    target: null,
    outcome: 'receiver-unresolved',
    kind: 'deferred',
    control: 'self_own',
    note: '.self is not bound to the class',
  },
  {
    shape: 'RefClass: log_decoy(x) beside a free function of that name',
    file: M,
    caller: 'refclass_bare_decoy',
    site: 'log_decoy(x)',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'free_call_control',
    note: 'the method and the free function make the name ambiguous: neither is chosen',
  },
  {
    shape: 'S4 generic call: area(p) after setGeneric("area")',
    file: S4,
    caller: 's4_generic_call',
    site: 'area(p)',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'free_call_control',
    note: 'no dispatch edge, no edge to the generic',
  },
  {
    shape: 'S4 generator call: Pt2(x = 1) after Pt2 <- setClass(...)',
    file: S4,
    caller: 's4_generator_call',
    site: 'Pt2(x = 1)',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'free_call_control',
  },
  {
    shape: 'S4 constructor call: new("Pt", x = 1)',
    file: S4,
    caller: 's4_new_call',
    site: 'new("Pt"',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'free_call_control',
  },
  // Chains with a variable at the base.
  {
    shape: 'a$b$save()',
    file: S,
    caller: 'chain_dollar',
    site: 'a$b$save()',
    target: null,
    outcome: 'receiver-unresolved',
    kind: 'unresolved',
    control: 'typed_local',
  },
  {
    shape: 'User$new()$save()',
    file: S,
    caller: 'chain_new',
    site: 'User$new()$save()',
    target: null,
    outcome: 'receiver-unresolved',
    kind: 'deferred',
    control: 'typed_local',
    note: 'result typing is not built; User.save is the right answer and is not claimed',
  },
  {
    shape: 'self$repo$save()',
    file: M,
    caller: 'self_field_chain',
    site: 'self$repo$save()',
    target: null,
    outcome: 'receiver-unresolved',
    kind: 'deferred',
    control: 'self_own',
    note: 'field types are not built',
  },
  // Chains with no variable at the base: no site is minted.
  {
    shape: 'get_user()$save()',
    file: S,
    caller: 'base_call',
    site: 'get_user()$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'typed_local',
    note: 'INVISIBLE: no edge and no outcome',
  },
  {
    shape: 'pkg::User$new()$save()',
    file: S,
    caller: 'base_qualified_new',
    site: 'pkg::User$new()$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'typed_local',
    note: 'INVISIBLE: no edge and no outcome',
  },
  {
    shape: 'x[[1]]$f$save()',
    file: S,
    caller: 'base_subset',
    site: 'x[[1]]$f$save()',
    target: null,
    outcome: 'none',
    kind: 'deferred',
    control: 'typed_local',
    note: 'INVISIBLE: no edge and no outcome',
  },
];

/** Helpers shared by the three repositories. */
const edgesOf = (result: PipelineResult, file: string, caller: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((e) => e.source === caller && e.sourceFilePath === file)
    .map((e) => e.rel.targetId)
    .sort();

const sourceLines = (repo: string, file: string): string[] =>
  fs.readFileSync(path.join(FIXTURES, repo, file), 'utf8').split('\n');

/** 1-based line of the first `site` after the line that defines `caller`. */
const siteLine = (repo: string, file: string, caller: string, site: string): number => {
  const lines = sourceLines(repo, file);
  const definition = lines.findIndex((l) => new RegExp(`^\\s*${caller}\\s*(<-|=)`).test(l));
  if (definition < 0) throw new Error(`${caller} is not defined in ${file}`);
  for (let i = definition; i < lines.length; i++) {
    if (lines[i].includes(site)) return i + 1;
  }
  throw new Error(`${site} not found after ${caller} in ${file}`);
};

/** Every reason recorded for a dropped site that starts on this line (any site kind). */
const reasonsAt = (result: PipelineResult, file: string, line: number): string[] =>
  getResolutionOutcomes(result)
    .flatMap((o) =>
      o.kind === 'suppressed' && o.filePath === file && o.range.startLine === line
        ? [o.reason]
        : [],
    )
    .sort();

describe('R receiver corpus (r-receiver-corpus)', () => {
  const REPO = 'r-receiver-corpus';
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, REPO), () => {});
  }, 120000);

  it('has unique caller names, and every non-resolving row names a resolving control', () => {
    const callers = RECEIVER_CELLS.map((c) => c.caller);
    expect(new Set(callers).size).toBe(callers.length);
    const byCaller = new Map(RECEIVER_CELLS.map((c) => [c.caller, c]));
    for (const cell of RECEIVER_CELLS) {
      if (cell.kind === 'resolves') {
        expect(cell.target, cell.caller).not.toBeNull();
        continue;
      }
      expect(cell.target, cell.caller).toBeNull();
      const control = cell.control ? byCaller.get(cell.control) : undefined;
      expect(control?.kind, `${cell.caller} needs a resolving control`).toBe('resolves');
    }
  });

  it.each(RECEIVER_CELLS.map((cell) => [`${cell.kind}: ${cell.shape}`, cell] as const))(
    '%s',
    (_title, cell) => {
      // The exact target and nothing else: a decoy edge (the free function, a same-named method
      // of another class) is any other element.
      expect(edgesOf(result, cell.file, cell.caller)).toEqual(
        cell.target === null ? [] : [cell.target],
      );
      const line = siteLine(REPO, cell.file, cell.caller, cell.site);
      expect(reasonsAt(result, cell.file, line)).toEqual(
        cell.outcome === 'none' ? [] : [cell.outcome],
      );
    },
  );

  it('no CALLS edge reaches a decoy or starts from one', () => {
    const decoyEdges = getRelationships(result, 'CALLS').filter(
      (e) => e.targetFilePath === 'R/decoys.R' || e.sourceFilePath === 'R/decoys.R',
    );
    expect(decoyEdges.map((e) => `${e.source} -> ${e.rel.targetId}`)).toEqual([]);
  });

  it('the table lists every CALLS edge and every dropped site of the repository', () => {
    const resolving = RECEIVER_CELLS.filter((c) => c.kind === 'resolves');
    expect(
      getRelationships(result, 'CALLS')
        .map((e) => e.source)
        .sort(),
    ).toEqual(resolving.map((c) => c.caller).sort());
    for (const edge of getRelationships(result, 'CALLS')) {
      expect(edge.rel.confidence, edge.source).toBe(0.85);
    }
    const dropped = getResolutionOutcomes(result)
      .filter((o) => o.kind === 'suppressed')
      .map((o) => `${o.filePath}:${o.range.startLine}:${o.reason}`)
      .sort();
    const listed = RECEIVER_CELLS.filter((c) => c.outcome !== 'none')
      .map((c) => `${c.file}:${siteLine(REPO, c.file, c.caller, c.site)}:${c.outcome}`)
      .sort();
    expect(dropped).toEqual(listed);
  });
});

/** One qualified call beside a caller-local `fmt` decoy. */
interface QualifiedCell {
  readonly shape: string;
  readonly file: string;
  readonly caller: string;
  readonly target: string | null;
  readonly kind: Kind;
  readonly control?: string;
  readonly note?: string;
}

const QUALIFIED_REPOS: readonly {
  readonly repo: string;
  readonly title: string;
  readonly decoy: string;
  readonly cells: readonly QualifiedCell[];
}[] = [
  {
    repo: 'r-receiver-corpus-qualified/complete',
    title: 'discovery completes',
    decoy: 'Function:scripts/s.R:fmt',
    cells: [
      {
        shape: 'other::fmt(): the package defines and exports it',
        file: 'scripts/s.R',
        caller: 'q_direct',
        target: 'Function:other/R/o.R:fmt',
        kind: 'resolves',
      },
      {
        shape: 'fmt(): the caller-local function',
        file: 'scripts/s.R',
        caller: 'q_local',
        target: 'Function:scripts/s.R:fmt',
        kind: 'resolves',
      },
      {
        shape: 'pkga::fmt(): pkga re-exports other::fmt',
        file: 'scripts/s.R',
        caller: 'q_reexport',
        target: 'Function:other/R/o.R:fmt',
        kind: 'resolves',
        note: 'one hop through importFrom plus export; never the caller-local fmt',
      },
      {
        shape: 'ext::fmt(): certainly not a package of the repository',
        file: 'scripts/s.R',
        caller: 'q_external',
        target: null,
        kind: 'unresolved',
        control: 'q_direct',
        note: 'dropped before any tier; no outcome is recorded for a dropped qualified site',
      },
    ],
  },
  {
    repo: 'r-receiver-corpus-qualified/truncated',
    title: 'discovery stops at depth 3',
    decoy: 'Function:caller/R/calls.R:fmt',
    cells: [
      {
        shape: 'fmt(): the caller-local function',
        file: 'caller/R/calls.R',
        caller: 'q_local',
        target: 'Function:caller/R/calls.R:fmt',
        kind: 'resolves',
      },
      {
        shape: 'invisiblepkg::fmt(): locality unknown',
        file: 'caller/R/calls.R',
        caller: 'q_unknown',
        target: null,
        kind: 'unresolved',
        control: 'q_local',
        note: 'dropped; the 0.5 guess for an unknown qualifier is gone, and no outcome is recorded',
      },
    ],
  },
];

describe.each(QUALIFIED_REPOS)('R qualified decoys: $title ($repo)', ({ repo, decoy, cells }) => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, repo), () => {});
  }, 120000);

  it.each(cells.map((cell) => [`${cell.kind}: ${cell.shape}`, cell] as const))(
    '%s',
    (_title, cell) => {
      expect(edgesOf(result, cell.file, cell.caller)).toEqual(
        cell.target === null ? [] : [cell.target],
      );
      if (cell.caller !== 'q_local') {
        // A qualified call never reaches the caller-local function of the same name.
        expect(edgesOf(result, cell.file, cell.caller)).not.toContain(decoy);
      }
      if (cell.target === null) {
        const control = cells.find((c) => c.caller === cell.control);
        expect(control?.kind, `${cell.caller} needs a resolving control`).toBe('resolves');
      }
    },
  );

  it('records no outcome for a dropped qualified site and has no other edge', () => {
    expect(getResolutionOutcomes(result).filter((o) => o.kind === 'suppressed')).toEqual([]);
    expect(
      getRelationships(result, 'CALLS')
        .map((e) => e.source)
        .sort(),
    ).toEqual(
      cells
        .filter((c) => c.kind === 'resolves')
        .map((c) => c.caller)
        .sort(),
    );
  });
});

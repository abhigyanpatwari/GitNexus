/**
 * Spike S2 (issue #2080, M0) — THROWAWAY post-dominator feasibility prototype.
 * Not part of the build (scripts/ excluded from tsconfig) or the test suite.
 *
 * Question (per maintainer review): does the post-dominator algorithm Epic B
 * (#2085, CDG) depends on hold up on real TS/JS control-flow shapes — the
 * classic CFG hazards — before Epic B commits to it?
 *
 * Scope boundary: post-dominators operate on a CFG, not on the AST directly.
 * This prototype validates the ALGORITHM (iterative dataflow on the reverse
 * CFG, EXIT-rooted, → immediate-post-dominator tree) against CFGs that model
 * each hazard's real TS control flow (the TS source each CFG represents is
 * shown inline). Building the CFG from a tree-sitter AST is M1's job (#2081);
 * this spike deliberately does not reimplement it.
 *
 * Run:  npx tsx scripts/spikes/s2-postdom-prototype.ts
 */

type CFG = {
  name: string;
  tsSource: string;
  entry: string;
  exit: string;
  // adjacency: block -> successors
  succ: Record<string, string[]>;
  hazard: string;
};

// Iterative post-dominator dataflow on the reverse CFG.
// PostDom(EXIT) = {EXIT}; PostDom(n) = {n} ∪ (⋂ PostDom(s) for s ∈ succ(n)).
// Monotone over a finite lattice (powerset of blocks) ⇒ guaranteed to converge.
function postDominators(cfg: CFG): { pdom: Record<string, Set<string>>; iterations: number } {
  const blocks = Object.keys(cfg.succ);
  const all = new Set(blocks);
  const pdom: Record<string, Set<string>> = {};
  for (const b of blocks) pdom[b] = b === cfg.exit ? new Set([cfg.exit]) : new Set(all);

  let changed = true;
  let iterations = 0;
  while (changed) {
    changed = false;
    iterations++;
    for (const b of blocks) {
      if (b === cfg.exit) continue;
      const succs = cfg.succ[b] ?? [];
      let inter: Set<string> | null = null;
      for (const s of succs) {
        if (inter === null) inter = new Set(pdom[s]);
        else inter = new Set([...inter].filter((x) => pdom[s].has(x)));
      }
      const next = new Set<string>(inter ?? []);
      next.add(b);
      if (next.size !== pdom[b].size || [...next].some((x) => !pdom[b].has(x))) {
        pdom[b] = next;
        changed = true;
      }
    }
    if (iterations > blocks.length + 5)
      throw new Error('post-dom did not converge (suspected bug)');
  }
  return { pdom, iterations };
}

// Immediate post-dominator: the closest strict post-dominator.
function ipdom(cfg: CFG, pdom: Record<string, Set<string>>): Record<string, string | null> {
  const res: Record<string, string | null> = {};
  for (const b of Object.keys(cfg.succ)) {
    if (b === cfg.exit) {
      res[b] = null;
      continue;
    }
    const strict = [...pdom[b]].filter((x) => x !== b);
    // ipdom = the strict post-dom that does not post-dominate any other strict post-dom.
    res[b] =
      strict.find((cand) => strict.every((other) => other === cand || !pdom[other].has(cand))) ??
      null;
  }
  return res;
}

const CFGS: CFG[] = [
  {
    name: 'early-return',
    hazard: 'early return / multiple paths to EXIT',
    tsSource: `function f(x){ if (x) { return 1; } g(); return 2; }`,
    entry: 'ENTRY',
    exit: 'EXIT',
    succ: { ENTRY: ['ret1', 'g'], ret1: ['EXIT'], g: ['ret2'], ret2: ['EXIT'], EXIT: [] },
  },
  {
    name: 'try-throw-finally',
    hazard: 'try/throw/finally with multiple exits through finally',
    tsSource: `function f(){ try { risky(); } catch(e){ handle(e); } finally { cleanup(); } done(); }`,
    entry: 'ENTRY',
    exit: 'EXIT',
    // try → (normal | throw→catch) → finally → done → EXIT; finally also reached on rethrow
    succ: {
      ENTRY: ['try'],
      try: ['finally', 'catch'],
      catch: ['finally'],
      finally: ['done', 'EXIT'],
      done: ['EXIT'],
      EXIT: [],
    },
  },
  {
    name: 'labeled-break',
    hazard: 'labeled break/continue across nested loops',
    tsSource: `outer: for(;;){ for(;;){ if (a) break outer; if (b) continue outer; work(); } }`,
    entry: 'ENTRY',
    exit: 'EXIT',
    succ: {
      ENTRY: ['outerHead'],
      outerHead: ['innerHead', 'EXIT'],
      innerHead: ['breakOuter', 'afterIf1'],
      breakOuter: ['EXIT'],
      afterIf1: ['contOuter', 'work'],
      contOuter: ['outerHead'],
      work: ['innerHead'],
      EXIT: [],
    },
  },
  {
    name: 'if-else-diamond',
    hazard: 'baseline reducible diamond (sanity)',
    tsSource: `function f(x){ if (x) { a(); } else { b(); } c(); }`,
    entry: 'ENTRY',
    exit: 'EXIT',
    succ: { ENTRY: ['a', 'b'], a: ['c'], b: ['c'], c: ['EXIT'], EXIT: [] },
  },
];

function main() {
  let allOk = true;
  for (const cfg of CFGS) {
    try {
      const { pdom, iterations } = postDominators(cfg);
      const idom = ipdom(cfg, pdom);
      // Sanity invariants: EXIT post-dominates every block; ipdom tree reaches EXIT.
      const exitPostDomsAll = Object.keys(cfg.succ).every((b) => pdom[b].has(cfg.exit));
      console.log(`\n[S2] ${cfg.name} — ${cfg.hazard}`);
      console.log(`     TS: ${cfg.tsSource}`);
      console.log(
        `     converged in ${iterations} iters; EXIT post-dominates all blocks: ${exitPostDomsAll}`,
      );
      console.log(
        `     ipdom tree: ${Object.entries(idom)
          .map(([b, p]) => `${b}->${p ?? '∅'}`)
          .join('  ')}`,
      );
      if (!exitPostDomsAll) allOk = false;
    } catch (e) {
      allOk = false;
      console.log(`\n[S2] ${cfg.name} FAILED: ${(e as Error).message}`);
    }
  }
  console.log(
    `\n[S2] VERDICT INPUT: all hazard CFGs converged + EXIT post-dominates all = ${allOk}`,
  );
}

main();

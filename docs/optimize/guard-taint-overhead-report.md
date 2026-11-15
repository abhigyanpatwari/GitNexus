# Guard-aware taint collection optimization

Measured 2026-10-24 for PR #3703. The corrected final implementation meets the planned **<=5% guard-free CFG collection-time overhead** target on all three measured workloads. Against the original PR implementation, the selection workload is **12.55% faster** and the transitive-alias holdout is **18.38% faster**. No proof rule or budget was weakened.

## Confirmed results

Each row compares two revisions in one process with 15 alternating paired samples. Negative overhead means faster collection. Compare timings within a row: this shared host also ran tests, and load changed between comparisons. These are ratios of sample medians, not averages of per-pair ratios. [Raw samples and source hashes](guard-taint-overhead-results.json) accompany this report.

| Reference           | Workload   | Reference median (ms) | Optimized median (ms) |  Change |
| ------------------- | ---------- | --------------------: | --------------------: | ------: |
| Pre-feature f3fa67b | arguments  |                926.98 |                916.33 |  -1.15% |
| Pre-feature f3fa67b | transitive |               1319.92 |               1370.44 |   3.83% |
| Pre-feature f3fa67b | direct     |                548.73 |                540.19 |  -1.56% |
| Original PR 6ee7ce1 | arguments  |                801.44 |                700.84 | -12.55% |
| Original PR 6ee7ce1 | transitive |               1167.84 |                953.23 | -18.38% |

Every consecutive five-pair block also meets the target against the pre-feature reference:

| Workload   | Pairs 1–5 | Pairs 6–10 | Pairs 11–15 |
| ---------- | --------: | ---------: | ----------: |
| arguments  |     1.39% |     -0.07% |      -0.34% |
| transitive |     0.62% |     -2.35% |      -0.95% |
| direct     |     0.17% |      0.74% |      -2.62% |

The integrated savings against the original PR are 100.59 ms on argument forwarding and 214.61 ms on transitive aliases. The final confirmation includes the malformed-AST correction discovered during review. Earlier five-pair selection batches varied enough to cross the target; 15 pairs were specified before final confirmation. All inputs, timing boundaries, correctness gates and thresholds stayed fixed. This establishes the target for the measured workloads and run, not a statistical guarantee for every host or source program.

## What changed

Only the TypeScript/JavaScript fact harvester changes at runtime. It now:

- Reuses known parent and parameter scopes during declaration scanning.
- Records nearest scopes for identifiers, avoiding native ID reads and map entries for structural nodes.
- Reuses adjacent resolution results and captured call-argument bindings while still recording ordinary call-frame occurrences.
- Reads native child counts and source positions once where the AST is immutable.
- Skips well-formed string/regex internals. Malformed literals retain full traversal; template substitutions, qualified identifiers and unsafe-name checks remain covered.
- Constructs each statement fact record once and allocates predicate-site maps only when predicates can be recognized.

There is no new dependency, solver, persistent cache or wire format. Declaration order, shadowing, synthetic binding identity, call frames, shape/proof limits and conservative fallback behavior remain unchanged.

## Reproduce the measurements

The portable harness is [compare-guard-overhead.mjs](../../gitnexus/bench/cfg/compare-guard-overhead.mjs). Both source checkouts need dependencies installed. From the optimized checkout's gitnexus package:

```bash
node --expose-gc --import tsx bench/cfg/compare-guard-overhead.mjs \
  --baseline /path/to/reference/gitnexus \
  --workload arguments --pairs 15 --check --out result.json
```

Repeat with transitive and direct. Use CPU affinity on a suitable quiet core when available. The measured run pinned both versions to CPU 23. Reference revisions:

- Pre-feature target: f3fa67b1445b8e8eeb23ae253fd3110044dc3624.
- Original PR implementation: 6ee7ce1cc463a8ad55cbdf2aea8325e0eb0396e0.
- Integration head: 09d2ebdb1f6d1571fded04ea917fb1935c4787e1. The main merge introduced no CFG/taint changes.
- Final harvester SHA-256: 19b0ca87758a18009b1f740ed4a22c81ccbc12ee756ba53f2d7fc823090e78ff.

Each workload contains 4,000 functions. Parsing occurs once, outside collection timing. Three warmup repetitions precede alternating reference/candidate samples, with explicit GC before each sample. Timed work is collectFunctionCfgs through the production visitor. Serialization and correctness checks occur outside timing; prior CFG outputs are not deliberately retained while timing the next sample. Every final sample exceeded 100 ms.

The harness always requires exact legacy CFG equality, all 4,000 functions, and all 4,000 helper argument effects with the exact prefix/input/suffix composition and ordinary-shell contract. Its --check additionally requires at least five pairs, >=100 ms samples and <=5% median overhead. An empty-output probe of the original harness failed all correctness gates. No CI wiring or existing benchmark allowance changes are part of this optimization.

Function bodies use unique function and consumer names:

```ts
// arguments: selection workload
function f(x: string) {
  const y = 'prefix ' + x;
  return consume(y);
}
// transitive: separate confirmation workload
function f(x: string) {
  const a = 'prefix ' + x;
  const b = a + ' suffix';
  return consume(b);
}
// direct: additional guard-free check
function f(x: string) {
  return consume('prefix ' + x);
}
```

## Correctness and validation

- Ad hoc full-output comparison against the original PR: 633 fixture files plus 30 explicit edge cases, **1,140 CFGs with zero differences**, including refinement data and skip counts. Corpus output SHA-256: 0d663493b85105b8cd3f4eeb15dad0061473aef785a342344c6db1f511385cd0.
- A separate **2,520 malformed-input mutation corpus** produced 1,651 CFGs with zero differences. Forty malformed literal nodes exercised parser recovery.
- Independent adversarial review identified a possible literal-recovery omission. Real parser reproductions made two new tests fail; requiring !node.hasError fixed both. Seven new cases cover recovery, repeated arguments, capture caps and nested declaration scope fallback. All **177 CFG/refinement tests** pass.
- Corrected-source default unit project: **900 files, 20,696 passed, 47 skipped, zero failures**. Corrected-source CFG integration: **13 files, 141 passed**.
- Corrected-source CLI build, source and test typechecks pass. Changed-file ESLint reports zero errors; warning-level diagnostics remain.
- Corrected-source persisted tool accuracy: **32/32 fixed answers pass** with the existing oracle.
- Corrected-source CFG benchmark: **15/15 scenarios pass**, including existing time, serialized-size, retained-heap, fingerprint, reaching-definition and taint budgets.
- Graph analysis: the optimization changes six files and 77 symbols across three observed processes (**MEDIUM** risk). The entire PR against merge base 11a49a15c6befbe4d5de1cebe74b5456aeb44b99 changes 42 files and 399 symbols across 16 observed processes (**CRITICAL**, covered by the prior shared-taint approval). Neither result carries a partial/truncated flag. Process counts are bounded graph observations; this refreshed index does not include the PDG layer.
- Four-shard full suite: **1,338 files, 28,267 passed, 88 skipped, zero failures**.

The full-suite snapshot was frozen before the final malformed-literal correction. It covers all other optimized code at the integration head. The corrected source was separately rebuilt and checked by the unit, CFG integration, differential, scaling and accuracy runs above.

The focused review combined a local correctness read with an independent Claude CLI adversarial read. The peer receipt verifies claude-opus-5-5; requested effort was high and actual effort is unverified. The peer reviewed the runtime optimization before the correction; local follow-up verified the fix, added tests and portable harness. The public harness reproduces timing and synthetic correctness checks; the broader ad hoc corpus comparisons are local validation evidence, not a new CI gate.

## Limits and remaining costs

The <=5% target concerns collection time on these guard-free workloads. It is not an end-to-end latency or peak-memory guarantee. Existing guarded, capped, time, payload and retained-heap scaling budgets remain unchanged. This run makes no peak-heap improvement claim.

Serialized size is identical to the original PR's normalized proof facts. Argument forwarding remains 5,118,249 bytes versus 4,030,249 before the feature (**+27.00%**); transitive aliases remain +37.40%, direct arguments +23.69%. Removing the value facts loses forwarding precision. A compact wire format is a separate tradeoff and was not introduced here.

The initial profile attributed substantial cost to declaration scanning, name resolution and duplicate value traversal. The retained changes target that work. No fresh profile establishes the remaining bottleneck; broader parser rewrites or a new cache framework are not justified by these results.

## Experiment accounting

Twelve bounded experiments ran serially: seven component experiments remain in the final implementation and five were rejected. There were no deferred dependency requests, unselected parallel candidates, censored experiments, runner errors or timeouts. A malformed-input correctness fix followed selection; it was not a new optimization experiment.

The table preserves the original component forecasts and contemporaneous five-pair results. Forecasts estimated savings against the original or preceding candidate; measurements compared the accumulated candidate against the pre-feature revision. **Those references differ, so the results do not validate individual forecasts.** They also show the timing variance that motivated final 15-pair confirmation. Do not add component percentages; only the original-to-final paired comparisons establish the integrated gain.

| Retained component                   | Forecast savings | Accumulated candidate vs pre-feature during selection |
| ------------------------------------ | ---------------: | ----------------------------------------------------: |
| Parameter scope reuse                |           4–8 pp |                           575.61 → 551.19 ms (-4.24%) |
| Identifier-only scope cache          |          5–12 pp |                            487.28 → 520.21 ms (6.76%) |
| Reuse call argument reads            |           3–6 pp |                            544.05 → 569.75 ms (4.72%) |
| Reuse native loop bounds/positions   |           2–6 pp |                            479.96 → 507.24 ms (5.68%) |
| Reuse last resolved name             |           2–5 pp |                            574.21 → 581.69 ms (1.30%) |
| Skip well-formed literal internals   |           2–6 pp |                            516.22 → 533.60 ms (3.37%) |
| Reuse scope parent; build facts once |           3–7 pp |                          554.10 → 496.07 ms (-10.47%) |

Early leaf shortcuts, bulk child enumeration, a per-node resolution map and standalone allocation changes did not show a reliable win. A generic identifier-leaf shortcut was also rejected because qualified identifier nodes have children. The final literal shortcut explicitly preserves parser recovery.

Stopping reason: the corrected final candidate meets the target and all synthetic correctness gates, including the original-to-final holdout. Optimization began at 10:35 UTC and corrected performance confirmation finished at 11:46 UTC (about 71 minutes); validation and publication continued afterward. No paid judge was used for timing. Compute and review spend were not metered, so whole-run cost is unrecorded. The local audit ledger and specification remain under .context/compound-engineering/ce-optimize/guard-taint-overhead/; this tracked report, raw results and portable harness are the shared evidence.

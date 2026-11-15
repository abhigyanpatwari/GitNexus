# Resumable analyze benchmark

Build two checkouts with matching dependencies on the same filesystem, then run
from the candidate's `gitnexus/` directory:

```sh
node bench/analyze-resume/measure.mjs --check \
  --baseline /path/to/base/gitnexus/dist/cli/index.js \
  --output /tmp/analyze-resume-explicit.json
```

Repeat with `--default-resources` and a new output path to compare automatic
resource allocation. The explicit profile uses a 2 GiB heap, two parser workers,
and a 256 MiB native pool on both sides. Do not run indexing or tests alongside
these measurements.

`baseline.json` records the corpus settings, seven measured pairs per scenario,
commit IDs, and original Linux/Node 22 results. Its historical timings are
provenance, not portable wall-clock limits. The runner compares the supplied base
and candidate in alternating order, after a warmup, on the current machine.

The six CI scenarios cover graph-only analysis, warm no-op, an incremental edit,
fresh HTTP embeddings, cached HTTP embeddings, and retry after a deterministic
provider outage. Setup runs are outside the measured interval. Assertions require
equal graph/vector counts and embedding-input fingerprints, recorded runtime
dependencies, completed publication, and no paid requests for a cached run.

`--check` requires all six scenarios, the recorded corpus size, a warmup and at
least seven pairs. It fails when the paired 95% interval lies entirely
above the candidate/base ratio of **1.0**. The interval encloses both the
percentile bootstrap and Student-t interval on paired log ratios, avoiding the
narrow bootstrap-only interval with seven samples. Student-t inference assumes
independent pairs with approximately normal log ratios
([NIST confidence interval definition](https://www.itl.nist.gov/div898/handbook/eda/section3/eda352.htm)). An interval crossing 1 remains
**inconclusive** and is reported as such; a successful CI gate means no slowdown
was statistically detected, not proof of equal performance. The original
graph-only interval in `baseline.json` is inconclusive and has not been discarded.

`.github/workflows/ci-tests.yml` runs both resource profiles against the PR base
(the first parent on non-PR runs). Failures block the existing CI Gate. Each job
uses `--allow-dependency-changes` to measure the complete shipped runtimes, so
dependency updates and release-version changes are benchmarked as well. Reports
record both lockfile/native digests and each pair's resolved dependency receipts
and parity. Manual runs require identical dependencies unless this flag is set.
Each job runs `--validate-gate` decision checks before measuring and
uploads raw samples, summaries, dependency receipts and analyzer logs, including
partial results on failure. The runner never overwrites an existing report.

The explicit-profile CI job also uploads `analyze-resume-cpu-profile-explicit` before the
full comparison. This separate one-pair fresh-HTTP run uses `--cpu-profile` to
capture Node CPU profiles for each process and parser worker. Profiling is
incompatible with `--check`; acceptance timings always run without profiling.

Benchmark execution belongs exclusively to the dedicated CI jobs above. It is
not included in the unit or integration test suites.

`--help` lists additional options, including optional local-model scenarios.
Synthetic fixtures do not establish query ranking, concurrent query latency,
local-model throughput, exact peak RSS or platform correctness. Reports keep
overall acceptance marked incomplete. SIGINT sent to the harness stops between
invocations and lets any active native CLI exit naturally.

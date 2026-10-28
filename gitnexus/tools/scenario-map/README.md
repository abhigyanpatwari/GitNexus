# Scenario-map fixture comparison

The `plan` stage discovers source fixtures read by tests and adds fixture similarity
to candidate retrieval. Run it through the existing CLI:

```sh
cd gitnexus
npm run test:scenario-map -- plan --work /tmp/gitnexus-scenario-map --mutation none
```

This runs coverage for the test inventory. To reuse coverage slices from the same
checkout, add `--coverage /path/to/coverage-slices`.
All slices must use the same capture version; mixing old coverage with newly instrumented
coverage is rejected because instrumentation changes V8 block offsets.

## Evidence

- `fixtures.json`: fixture paths, languages, extraction gaps, counted features,
  associated tests, and similarity matches. Profiles are deduplicated across tests.
- `coverage/candidates.json`: pairs retrieved through the `fixture` source, with the score,
  content/structure match kind, and whether their languages differ.
- `layer2.json`: per-test fixture evidence and input identity used by later stages.
- Fresh coverage records also contain `runtimeFixture` profiles. Raw records retain
  bounded input snapshots, so profiling does not depend on temporary files surviving.

Discovery follows constants, imported test helpers, setup hooks, static string rows,
path joins, and file URLs for ingestion, file-read, and copy calls. It reads source
corpora anywhere under `gitnexus/test/`, including integration-local fixtures.
It never executes a helper to discover its inputs. Diff-scoped runs retain these
tests until their fixture profiles can be compared.

Fresh coverage also captures generated and dynamically selected inputs. A coverage-only
Vite transform snapshots the repository passed to `runPipelineFromRepo` before ingestion,
including runs that dispatch parsing to workers. It preserves relative file layout and
non-source assets. Pass-through wrappers retain the returned contents of synchronous,
promise, and callback `readFile` calls made directly by tests or test helpers, including
file URLs. Production files on disk are not modified by instrumentation.

Snapshots follow coverage windows: the last test attempt and its suite setup feed that
test's profile. Setup hooks carry their suite identity across async calls, so nested
setup does not leak into sibling suites. Changed input contents across attempts,
concurrent tests, and reads outside attributable windows remain explicit gaps. Temporary
directory names do not change input identity. The planner parses each distinct captured
input through the same language providers used for static fixtures, after the test ends.

The profiler reuses GitNexus's language providers for declarations, reference kinds,
call forms, imports, and control-flow graphs. Counts preserve multiplicity. Three
rounds of directed, labeled CFG-neighbor refinement give a topology signature
independent of block IDs and source positions. This is a structural heuristic,
not a graph-isomorphism or program-equivalence proof.

Two tests become fixture candidates only when their assertion-only keys match and
their fixture profiles have weighted multiset Jaccard similarity of at least 0.90.
CFG signatures have weight 4; other features have weight 1. Exact content matches
also retrieve candidates. File profiles and pair scores are cached within a run.

Similarity omits identifier spelling and literal values. **Exact fixture text and
relative file layout are separately included in the input identity**, including
non-source assets. A similar fixture cannot make different inputs a confirmed
duplicate. Cross-language cases often provide intentional provider coverage;
a match is a review lead, not a recommendation to remove either test.

## Consolidation opportunities, including partial matches

The `plan` stage also writes `consolidation.html` and `consolidation.json`. These
compare three independent axes: captured fixture contents, executed JavaScript
blocks, and individual assertions. A fixture match alone does not create a lead.
The HTML report can be filtered by test name or recommendation. It shows both
directions of overlap and the assertions, blocks, and fixture spans that remain
unique. Groups represent repeated evidence without enumerating every test pair.

Fixture text is compared locally with the pinned **jscpd 5.4.2** development
dependency. Exact, consistently renamed, and near-miss fragments contribute to
byte overlap; comments and whitespace are ignored by the clone engine. The
coverage denominator conservatively includes all non-whitespace captured bytes.
Overlapping fragments count once; near-miss scores discount their contribution.
Representative exact/renamed clone links form families, so a missing direct link
does not hide another member. When representative spans overlap with different
boundaries, pairs that pass the assertion and execution gates are compared directly
in a separate two-input scan. This avoids inventing byte mappings or losing a partial
match when the corpus chooses a longer representative. The raw pair reports and
verification count are retained. Near-miss links are never treated as transitive.
No source is uploaded and no embedding model is downloaded.

Source snapshots are content-addressed in `coverage.json` and merged across slices.
The external engine's raw report and exported inputs are under `fixture-clones/`.
The report records captured/scanned file counts and formats: unsupported formats
and fragments below the 12-token threshold can be missed. Source identities still
recognize identical complete inputs independently of tokenization.

Across languages, GitNexus provider features supply a separate, weaker
`share-language-scenario` suggestion. Full matches require 0.90 weighted Jaccard;
partial matches require shared CFG topology and 0.90 feature containment in one
direction. These are structural scenario leads, not cross-language semantic proofs.
Each language remains a test case when consolidating into a shared harness.

Assertions retain exact expected literals, row values, snapshots, negation and
selectors. Single preceding `const` bindings and scoped callback parameters are
traced, so `find(edge => edge.target === 'save')` does not equal a `getName` query.
Unknown expected values or local origins cannot become equal assertion atoms.
Unknown checks remain in overlap denominators. This comparison does not execute
arbitrary expected-value expressions or establish helper semantic equivalence.

Default retrieval requires 0.50 fixture containment and 0.50 executed-block
containment in either direction, plus 0.25 exact-assertion containment. Fully known
assertions with different expected values can instead qualify through 0.80
predicate-shape containment, producing parameterization leads. Thresholds and
missing evidence are included in the JSON. This supports sharing a subset of
checks while retaining the remaining assertions and fixture branches.

Executed blocks exclude uncovered V8 ranges. They describe observed coverage,
not call order or every possible execution. Native work, spawned workers, input
capture gaps, unsupported checks and inventory joins stay visible as limitations.
Even a complete match is a statement about the captured run; consolidation output
does not authorize deleting tests or bypass existing duplicate-confirmation gates.

Run a complete capture and generate a report (or use the existing coverage-slice
workflow to distribute the capture):

```sh
node --import tsx tools/scenario-map/scenario-map.ts coverage \
  --index 0 --of 1 --work /tmp/scenario-coverage --mutation none --concurrency 2
node --import tsx tools/scenario-map/scenario-map.ts plan \
  --coverage /tmp/scenario-coverage --work /tmp/scenario-plan --mutation none
node --import tsx tools/scenario-map/consolidation/verify-controls.ts \
  /tmp/scenario-plan/consolidation.json
```

The acceptance command checks all 28 pairs among eight real pipeline controls:
15 exact/renamed/partial/cross-language opportunities and 13 negative pairs. It
also checks that unique evidence and runtime limitations survive in the report.

## Capture and proof limits

Archived coverage without runtime snapshots still uses static discovery. Unresolved static
paths (including generated inputs) require a fresh coverage run to obtain runtime evidence.
Missing parsers, parse errors, lossy text
decoding, and extraction limits are recorded as unresolved. Partial profiles do
not retrieve structural matches. Identical, completely read text can still retrieve
an exact-content candidate when parsing fails; that failure remains unresolved
for duplicate confirmation. Incomplete reads never establish input identity. Existing
path, context, assertion, runtime-value, and passing-test checks still apply.

Runtime capture retrieves review candidates; it does not establish exhaustive input
coverage. Streams, file-descriptor reads, inputs generated inside child processes, and
repository mutations after the entry snapshot are not fully observed. Runtime evidence
cannot clear static input gaps or confirm duplicates by itself. A complete static profile
corroborated by identical runtime contents retains its existing confirmation checks.
Skipped or failed tests cannot establish duplicate safety.

Structural fingerprints inherit provider behavior, including parser or CFG instability;
exact text and external clone spans are separate evidence. The comparison uses pre-resolution features. It does not prove cross-file binding,
data-flow, operator, or runtime equivalence. Providers without CFG support contribute
their available capture features. Identical counts can produce false-positive
review leads, and different provider representations can miss similar fixtures.

Limits per profile: 200 files, fewer than 200,000 characters per file, 2,000,000
characters total, and 2,000 lines per CFG function. Runtime capture additionally bounds
each test file to 20 MB of unique snapshot text and 2,000 events; repository snapshots
visit at most 1,000 entries and 30 directory levels. Symlinks are reported as incomplete;
`.git`, `.gitnexus`, and `node_modules` directories are omitted. Helper traversal is bounded to
five calls and constant evaluation to eight steps. `.env` files other than
`.env.example` are excluded and reported as incomplete.

Validate with:

```sh
npm test -- test/unit/scenario-map --maxWorkers=2
npm run typecheck:tests
# Fresh real-pipeline controls, including generated repositories deleted in setup:
node --import tsx tools/scenario-map/path-coverage/run-coverage.ts \
  --file test/integration/scenario-map-runtime-inputs.test.ts \
  --out /tmp/scenario-map-runtime-controls --concurrency 1
```

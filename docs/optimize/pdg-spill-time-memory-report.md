# Cold PDG indexing on a 6 GiB budget

The analyzer now selects a single native database writer for PDG builds with an explicit budget of 6 GiB or less and either automatic parser concurrency or one requested worker. The CLI applies the two-arena glibc default only when admission selects one parser worker. [Cold builds with the automatic settings](#cold-builds-with-the-automatic-settings)

Two subsequent Linux cold builds met both targets with a 384 MiB database pool and two glibc allocator arenas. [Measurements and reproduction command](#incremental-pdg-and-the-6-gib-release-workload)

Across two paired cold runs, parsing scope shards before restoring their objects and collecting unused JavaScript heap before full-text indexing reduced median elapsed time from 550.66 s to 461.62 s (16.2%). Median peak RSS fell from 3,768.05 to 3,692.46 MiB (2.0%). Memory rose by 49.82 MiB in one pair and fell by 200.99 MiB in the other. Only elapsed time cleared the 3% improvement threshold. Both medians exceeded the targets of 365 s and 3,316 MiB.

| Candidate | Control (s) | Candidate (s) | Control RSS (MiB) | Candidate RSS (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Native JSON decode | 462.09 | 437.10 (-5.4%) | 3,466.42 | 3,708.74 (+7.0%) |
| Stream PDG blocks | 574.17 | 508.57 (-11.4%) | 3,464.88 | 3,580.32 (+3.3%) |
| Native decode and collection, control first | 592.80 | 463.29 (-21.8%) | 3,714.68 | 3,764.50 (+1.3%) |
| Native decode and collection, candidate first | 508.51 | 459.95 (-9.5%) | 3,821.42 | 3,620.43 (-5.3%) |

The original two clean samples had medians of 423.96 s and 3,606.62 MiB. The control revision was `064b71c17`, the head of PR #4028. Each trial used adjacent controls on the shared host. The first two candidates exceeded the 3% memory regression threshold in their exploratory pair. Timing varied substantially between batches. No independent holdout repository was configured.

## Where the costs appeared

The scope store decoded 5.15 GB from 42,431 shard reads and spent 123–124 s in the JSON reviver in the original baseline. Switching to native JSON parsing followed by object restoration saved 25.0 s end to end in its first pair, below the 65–95 s forecast. Peak RSS rose by 242.32 MiB.

Streaming PDG basic blocks reduced live JavaScript heap after scope resolution from 946 to 565 MiB, compared with a forecast of 100–350 MiB. Peak process RSS still rose by 115.45 MiB. In six archived traces, heap use fell during database publication while process RSS rose. An additional cold trace showed V8 with 1,499 MiB allocated and 629 MiB in use when the native full-text build started. This prompted testing one collection in a full PDG rebuild with an explicit resource budget and substantial spare heap.

The combined candidate was forecast to save 20–65 s and 120–350 MiB. Its paired medians fell by 89 s and 75.58 MiB. The measurements cover the combined change. The independent contribution of garbage collection is unmeasured.

Increasing the cache from 64 to 350 shards in a replay avoided only 3.4% of reads and increased peak serialized data in cache from 16.3 to 64.7 MiB. The replay reproduced all 42,431 misses of the original policy. Callers used 882,666 of the 2,651,779 scopes decoded during cache residency. Decoding individual scopes on demand remains a candidate for a separate investigation. Shared definition identity, live type bindings, scope order, and corrupt-shard errors would need parity checks.

Preparing the File full-text index last increased isolated peak RSS in two trials. On a fresh database copy, a 384 MiB native buffer pool saved 119 MiB versus a 921 MiB control. At 192 MiB, both File and Function indexing failed. The timed cold runs used the existing release resource settings.

## Measurement and checks

The sanitized release repository was pinned to `7b1af8b`. A single parser worker ran with automatic scope storage, PDG enabled, full content retention, a 512 KiB file cap, and a 6,144 MiB resource budget. Each measured process started with an empty graph and parse cache. GNU time measured elapsed time and peak process RSS. After each run the harness verified cache publication and compared all properties and endpoints across 373,373 nodes and 835,148 relationships. The reference manifest SHA-256 was `91b684ce60c1a52122b49609970afabfbf814d053bfc3adf829063fffb63c986`.

The final candidate passed 205 focused tests across all 19 PDG languages, spill and storage recovery, FTS behavior, resource budgets, and the shared-language boundary. Both TypeScript configurations, lint, and formatting passed. For the earlier streaming candidate, a combined fixture matched the resident and streamed databases on 1,308 basic blocks. A supplemental full-suite run on unchanged source was interrupted after 36 minutes to isolate timing. Its final result is unverified.

The experiment phase used 88 active minutes across three variants. The remaining active budget was shorter than another cold run. The three experiments used the local analyzer and existing dependencies. Claude Code reported about $0.92 in total model usage. The run ledger, optional patches, and raw measurements are under `.context/compound-engineering/ce-optimize/pdg-spill-time-memory/` in the benchmark workspace. The release fix is tracked in [PR #4028](https://github.com/abhigyanpatwari/GitNexus/pull/4028).

## Follow-up on the pushed PR head

The follow-up compared two changes with `b8fd1702f` on the same cold release workload. Each row below pairs adjacent runs. The targets remained 365 seconds and 3,316 MiB peak process RSS. A change needed a consistent improvement of at least 3% in one objective across both run orders, with no confirmed regression in the other.

| Change and run order | Control (s) | Candidate (s) | Control RSS (MiB) | Candidate RSS (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Decode scopes on demand, control first | 408.44 | 413.41 | 3,698.20 | 3,252.58 |
| Decode scopes on demand, candidate first | 506.53 | 454.64 | 3,228.91 | 3,339.77 |
| Stream PDG blocks on the budgeted CLI, control first | 441.84 | 518.06 | 3,250.63 | 3,438.03 |

Decoding individual scopes shortened TypeScript emission in both pairs, by 8.31 and 23.96 seconds. Each run still read 42,431 shards, and their serialized contents grew from 5.15 to 5.94 billion characters. Whole-run time and peak RSS each improved in only one pair. The median of 3,296.17 MiB met the memory target, but the reversed pair used 110.86 MiB more than its control. We dropped the change. Its compatibility checks covered shared definitions, live type bindings, lookup order, eviction, older shard files and corrupt records.

Streaming basic blocks reduced live JavaScript heap after the final language from 946 to 565 MiB. End-to-end time rose by 76.22 seconds (17.3%) and peak process RSS rose by 187.41 MiB (5.8%) in the first pair, so we stopped testing that variant. On a combined 19-language fixture we observed the CLI writing streamed blocks and verified that all 1,615 nodes and 2,963 relationships, including 1,308 basic blocks, matched the resident build. Both candidate implementations passed the TypeScript checks, and every measured release build matched the reference graph.

The pushed implementation remains the reference and final implementation for this round. Its three cold controls took 408.44–506.53 seconds and used 3,228.91–3,698.20 MiB peak RSS. The median time of 441.84 seconds missed the target by 76.84 seconds. The median RSS of 3,250.63 MiB met the target by 65.38 MiB, with one control above target.

The traces locate much of the RSS variation before database publication. During JavaScript scope resolution the two lower-memory controls shed 501 and 575 MiB of RSS between successive probes. Live heap fell by only 14 and 58 MiB over those intervals. The high-memory control kept its resident pages through that phase. The allocation responsible is still unknown.

The follow-up completed its two-variant budget in 51 minutes, with no additional API spend. The local receipts are in `.context/compound-engineering/ce-optimize/pdg-spill-time-memory-followup/`.

## Incremental PDG and the 6 GiB release workload

The ordinary cold PDG build met both targets in 2 of 2 local cold runs with a 384 MiB LadybugDB pool and two glibc allocator arenas. The observed pairs were 297.51 s / 2,633.34 MiB and 303.43 s / 2,665.74 MiB. The ordinary one-file incremental update exhausted its V8 heap. All successful candidate comparisons used the same indexed source inputs as their corresponding control.

The targets were 365 seconds elapsed and 3,316 MiB peak process RSS. The local probes used the sanitized release input at `7b1af8b` with the rc.247 runtime and PR #4028 modules built at `4496f481f`. Each cold build started with an empty graph and parser cache. All runs used one worker, a 512 KiB file cap, full content retention and a 6,144 MiB resource budget. GNU time measured the complete CLI command, including subprocesses. For sequential commands the table gives total elapsed time and the larger of the two process peaks. Fingerprinting and search verification ran outside the timed interval.

| Workload | Seconds | Peak RSS (MiB) | Result |
| --- | ---: | ---: | --- |
| Original snapshot, ordinary cold build | 308.91 | 3,673.69 | Over the RSS target |
| One edited file, ordinary incremental analyze | 129.23 | 2,135.12 at failure | Heap exhausted before publication |
| Edited snapshot, cold rebuild | 298.06 | 3,763.38 | Over the RSS target |
| Edited snapshot, forced rebuild with parser cache | 163.31 | 3,738.23 | Over the RSS target |
| Original snapshot, graph and FTS in two commands | 303.84 | 3,386.96 | Over the RSS target |
| Original snapshot, ordinary cold build with a 384 MiB pool | 295.64 | 3,493.53 | Over the RSS target |
| Original snapshot, graph and FTS in two commands, 384 MiB pool | 285.91 | 3,336.84 | Over the RSS target |
| Original snapshot, ordinary cold build, 384 MiB pool and two allocator arenas | 297.51 | 2,633.34 | Both targets met |
| Intervening ordinary cold build, 384 MiB pool and system allocator defaults | 288.07 | 3,459.90 | Over the RSS target |
| Repeated ordinary cold build, 384 MiB pool and two allocator arenas | 303.43 | 2,665.74 | Both targets met |

### What changed on the incremental run

A new negative-duration branch in `formatElapsed` changed exactly one source hash. The default incremental command exhausted its JavaScript heap during TypeScript scope analysis, after scope spilling and before completing local PDG emission. The last V8 collection left roughly 1,677 MiB live. The previously published graph still matched the original fingerprint. A clean rebuild added two basic blocks and six relationships, including changes to control flow, control dependence and reaching definitions.

The forced rebuild reused cached parser output for 2,320 files. The resulting graph matched the clean edited graph, including every node property and relationship endpoint. It saved 134.75 seconds compared with the cold build of that edit. This is one comparison on the release corpus. The ordinary incremental path reruns the semantic pipeline, selectively writes changed-file rows, and refreshes whole-program summaries. Structural graph streaming currently requires a forced rebuild. The release evaluator prepares a fresh index for each unique sanitized input per runtime and shares the prepared result among paired arms. It also repeats preparation between preflight and the measured runner. [Incremental writeback](https://github.com/abhigyanpatwari/GitNexus/blob/4496f481f686e208bc2423a53781b6353c238f22/gitnexus/src/core/run-analyze.ts#L4999-L5022) · [Graph preparation](https://github.com/abhigyanpatwari/GitNexus/blob/4496f481f686e208bc2423a53781b6353c238f22/eval/workflow_bench/sanitized_graph.py#L382-L445) · [Release preflight](https://github.com/abhigyanpatwari/GitNexus/blob/4496f481f686e208bc2423a53781b6353c238f22/eval/workflow_bench/release_preflight.py#L84-L110)

### Output checks

The original release fingerprint was `91b684ce60c1a52122b49609970afabfbf814d053bfc3adf829063fffb63c986` across 373,373 nodes and 835,148 relationships. The edited fingerprint was `5f7c9be85514435454a923fc0651f59c90eab2d9e2f984bc1a18711683aaed2a`. The two-process cold probes built the graph with `--force --pdg --skip-fts`, then ran `--pdg --repair-fts` in a fresh process. The first command published an intermediate graph with FTS disabled. The resulting graph, all ten FTS catalog entries and the ranked results of two search queries matched the original one-command control. The 384 MiB pool used `GITNEXUS_LBUG_BUFFER_POOL_SIZE=402653184`. The allocator probe used `MALLOC_ARENA_MAX=2` on glibc 2.41. Source, runner defaults and the release workflow were unchanged by this investigation.

### Reproducing the cold setting

Use the tested PR build on Linux with glibc and begin with an empty index and parser cache. The benchmark also sets `GITNEXUS_SHARED_STORE=off` to isolate its checkout. These environment variables apply to the analyzer process and its children. The release sandbox builds its own environment, so a hosted run with these settings requires explicit configuration there. This local study did not dispatch a hosted release evaluation. [Sandbox environment](https://github.com/abhigyanpatwari/GitNexus/blob/4496f481f686e208bc2423a53781b6353c238f22/eval/workflow_bench/sanitized_graph.py#L249-L285) · [glibc allocator settings](https://sourceware.org/glibc/manual/latest/html_node/Memory-Allocation-Tunables.html)

```sh
GITNEXUS_LBUG_BUFFER_POOL_SIZE=402653184 MALLOC_ARENA_MAX=2 \
  gitnexus analyze . --force --pdg --index-only --no-stats \
    --workers 1 --resource-budget 6144 --max-file-size 512
```

## Cold builds with the automatic settings

The graph writer uses one native database thread for COPY and full-text indexing under this budget. On Linux with glibc, the CLI also starts its graph writer with two allocator arenas when one parser worker is admitted, unless the operator has set `MALLOC_ARENA_MAX` or `glibc.malloc.arena_max`. The database buffer pool continues to use its normal sizing policy. The writer selection is shared across languages.

These cold runs used the same sanitized source, release runtime and 24-CPU Linux host. Each run started with an empty graph and parser cache, using `--force --pdg --workers 1 --resource-budget 6144` without allocator or pool overrides in the invoking environment. The unchanged PR control was `88488bbd0`. The target was 365 seconds and 3,316 MiB peak process RSS.

| Build | Elapsed (s) | Peak RSS (MiB) |
| --- | ---: | ---: |
| Unchanged PR control | 356.58 | 3,659.36 |
| Single database writer, system allocator defaults | 355.10 | 3,273.99 |
| Repeated single database writer, system allocator defaults | 357.03 | 3,318.06 |
| Single database writer, CLI-selected arenas | 332.96 | 2,803.61 |
| Final build, CLI-selected arenas confined to the graph writer | 330.52 | 2,805.36 |

The final build finished 26.06 seconds sooner and used 854.01 MiB less peak RSS than the control. Both combined runs reproduced the reference graph of 373,373 nodes and 835,148 relationships, all ten full-text indexes, and the ranked results of both search queries. The final build confines the allocator default to the writer child. The separate publication and embedding child inherits the operator's environment.

The combined fixture for all 19 PDG languages produced the same 1,615 nodes and 2,963 relationships, including 1,308 basic blocks. Repeating the one-file incremental edit on the final build still exhausted the JavaScript heap during scope analysis. After the failure the published graph retained its original fingerprint.

### Four-worker parse time

Four cold PDG builds on Node 22.23.3 indexed the same 210 TypeScript ingestion files with four workers, a 6,144 MiB total budget and a 1,200 MiB main heap. From first dispatch to last completed chunk, the host allocator defaults took 14.36 and 17.90 seconds. Two glibc arenas took 19.44 and 20.15 seconds. The runs used defaults, two arenas, two arenas, then defaults on a shared host. All four produced 39,972 nodes and 119,734 edges.

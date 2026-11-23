# HTTP resume and the main pipeline performance checks

Reusing verified dependency hashes reduced HTTP resume time by 13.0% on the explicit-resource CI workload. The comparison alternated unmodified `26536ae8a` with the change in `de81452ccf34`. All six scenarios passed under both explicit and default resources. The private digest cache rebuilds once after upgrade.

## HTTP resume

The failed Publish job measured a 0.93% slowdown from `fe743af46` to `26536ae8a`. Its 95% interval was 0.08% to 1.79% slower. Two independent local repeats of those revisions were inconclusive. The profile identified work both revisions performed when resuming an interrupted embedding run. [Original CI job](https://github.com/abhigyanpatwari/GitNexus/actions/runs/45024292484/job/137218786923)

| Comparison | Control median | Patched median | Median difference | Paired reduction in time, 95% interval |
| --- | ---: | ---: | ---: | ---: |
| Failed main revision, 2,048 MiB and two workers | 2,900 ms | 2,605 ms | −295 ms | 13.0% (8.2% to 17.5%) |
| Failed main revision, default resources | 2,875 ms | 2,563 ms | −312 ms | 11.2% (10.1% to 12.3%) |
| Historical parent, 2,048 MiB and two workers | 2,880 ms | 2,592 ms | −288 ms | 10.0% (8.4% to 11.5%) |

Each comparison used one warmup and seven alternating pairs. The percentages use the benchmark’s geometric mean of paired time ratios. Both sides resumed exactly 688 pending inputs in 43 provider requests and finished with the same 1,024 embeddings and input fingerprint. All 84 measured pairs across the two six-scenario runs completed equivalent work. [Resume benchmark](https://github.com/abhigyanpatwari/GitNexus/blob/26536ae8ad88655e944af13a74870dfb30b08061/gitnexus/bench/analyze-resume/measure.mjs)

In the measured resume process, parser identity resolution spent 347 ms hashing files. The analyzer had already verified 830 dependency files containing 495 MB of the 509 MB the parser read. That placed an upper bound of about 347 ms on the recoverable time in that profile. The patched parser read 14 MB, and the public analyzer dependency digest matched the control. The parser also produced identical identities when it independently hashed the installation and when it reused analyzer hashes. The observed 295 ms median saving fits the profile’s 347 ms estimate. The remaining parser inputs account for 14 MB.

The change stores raw content hashes for regular dependency files in the analyzer’s private cache. The parser checks each file’s current state and readability before reuse, enforces its byte budget, and revalidates its inventory before publication. A regression test changes a cached native file and verifies the parser reads the new bytes.

## Parse cache

| Original failure surface | Pairs | Control median | Patched median | Paired change in time | Corrected interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| Repack 1,024 synthetic files | 21 | 3,455.6 ms | 3,457.9 ms | +0.02% | −1.14% to +1.20% |
| Edit one file in a 1,193-file source tree | 7 | 20,790.4 ms | 20,788.2 ms | −0.27% | −2.36% to +1.87% |

The original CI jobs measured repack 0.57% slower and one-file edits 0.99% slower. Their upper bounds crossed the 5% budget at 5.36% and 6.47%, leaving both comparisons inconclusive. The patch’s upper bounds cleared that same budget. All eight timing, memory and cache-size checks passed on each corpus. The builds produced matching graphs and exact cache reuse across 140 paired phases. The real-source edit reparsed one file. Synthetic repack reused all 1,024 files. The original real-source CI failure compared builds with byte-identical runtime modules. [Cache benchmark](https://github.com/abhigyanpatwari/GitNexus/blob/26536ae8ad88655e944af13a74870dfb30b08061/gitnexus/bench/file-result-reuse/benchmark.js) · [Original synthetic job](https://github.com/abhigyanpatwari/GitNexus/actions/runs/45017085376/job/137192889525) · [Original real-source job](https://github.com/abhigyanpatwari/GitNexus/actions/runs/44893899234/job/136815427634)

## Release graph

Release candidate `754b3e0a4` exhausted the heap on sanitized source `7b1af8b16` under a 6 GiB CLI budget with one worker and PDG enabled. The pinned main revision already contained the scope-spill fix. It completed in 357 seconds. The patched build completed in 352 seconds. Both matched the reference’s 2,513 file hashes, graph manifest (373,373 nodes and 835,148 edges), ten full-text indexes, and ranked search results. The hosted job’s exact memory envelope was unavailable. [Original release job](https://github.com/abhigyanpatwari/GitNexus/actions/runs/44815932529/job/136570359504)

The first successful runs peaked at 2,526 MiB on the control and 2,857 MiB on the patch. Two fresh back-to-back comparisons tested this difference in both orders. The earlier increase did not recur.

| Run order | Control time | Patched time | Control peak process RSS | Patched peak process RSS |
| --- | ---: | ---: | ---: | ---: |
| Control first | 295.50 s | 297.90 s | 2,817 MiB | 2,408 MiB |
| Patch first | 296.33 s | 293.82 s | 2,844 MiB | 2,805 MiB |

All four repetitions matched the reference graph and search output. Two pairs establish the observed range on this host. They provide limited precision for estimating a memory change.

## Validation and scope

The full CLI suite reported one intermittent assertion in repository discovery. Unmodified main reproduced the same assertion on the fourth full-file run. All 324 tests in that file passed on the patch when rerun after suite completion. Tests ran in a private worktree outside `/tmp`, with the editor and registry environment overrides cleared. The four changed files and both compiled modules matched the benchmarked checkout byte for byte. Both the source and test TypeScript checks passed.

```text
Test Files  1 failed | 1771 passed | 15 skipped (1787)
Tests  1 failed | 38886 passed | 162 skipped (39049)
```

The pre-commit change scan reported critical aggregate reach. All 244 execution flows identified the same shared parser resolver. Upstream symbol analysis assigned that resolver low risk with two direct callers. The complete change scan reported no incompatible calls.

One implementation experiment met the HTTP timing target and all three other required objectives in 5 h 40 min. The runs used local Linux compute and a loopback embedding service, with $0 in paid service spend. The local measurement ledger lives at `.context/compound-engineering/ce-optimize/main-pipeline-performance/experiment-log.yaml`. Selection and confirmation used the CI fixtures. Performance on independent repositories and hosted runners remains unmeasured for this patch.

# Cold PDG indexing on a 6 GiB budget

Both candidates indexed the release repository faster than their paired controls, but both used more peak process memory. The run stopped after two consecutive reverts. The final analyzer is identical to `064b71c17`, the head of [PR #4028](https://github.com/abhigyanpatwari/GitNexus/pull/4028).

| Candidate | Control time | Candidate time | Control peak RSS | Candidate peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Decode scope shards after native JSON parsing | 462.09 s | 437.10 s (−5.4%) | 3,466.42 MiB | 3,708.74 MiB (+7.0%) |
| Stream PDG basic blocks during budgeted full rebuilds | 574.17 s | 508.57 s (−11.4%) | 3,464.88 MiB | 3,580.32 MiB (+3.3%) |

The original two-run baseline had medians of 423.96 s and 3,606.62 MiB. The targets were 365 s and 3,316 MiB. Each row above is a single exploratory pair on the same shared host. The first pair ran control first, the second ran candidate first. A regression above 3% ruled a candidate out before confirmation. The initial RSS samples spanned 6.4%, so these rejections do not establish a general memory regression. The retained change in both metrics is zero.

## Where the costs appeared

The original workload read 2,213 scope shards 42,431 times and spent 123–124 s in JSON parsing with a reviver. On 64 release files, parsing first and then restoring Maps, Sets, strings, and shared definitions in JavaScript suggested a 65–95 s saving. On the full repository, TypeScript emission improved by 59.3 s and the whole run by 25.0 s. It cost an additional 242.32 MiB at peak.

The release graph contains 290,282 basic blocks. Streaming them was expected to remove roughly 100–350 MiB from the retained graph. The live JavaScript heap after scope resolution fell from 946 to 565 MiB. Peak process RSS still rose by 115.45 MiB. It occurred later, during publication. In a separate full-text index rebuild, RSS rose from 450 MiB to 1,346 MiB while the JavaScript heap stayed near 58 MiB. Restricting that rebuild to four CPUs did not reduce its peak.

## Measurement and checks

The workload used the sanitized release task at `7b1af8b`, one parser worker, automatic scope storage, full content retention, a 512 KiB file limit, and a 6,144 MiB process-family resource budget. Each run started with an empty index and parse cache. GNU time measured elapsed time and maximum process RSS. Graph fingerprinting ran after the timed command. Timing covered one repository on a shared machine.

Both candidates published the cache and matched the reference across 373,373 nodes and 835,148 relationships, including properties and endpoints. The reference manifest SHA-256 was `91b684ce60c1a52122b49609970afabfbf814d053bfc3adf829063fffb63c986`. Both passed the source and test TypeScript checks and parity tests for all 19 PDG languages. The streaming path also matched the resident database on a combined 19-language fixture with 1,308 basic blocks.

The experiment phase took about 42 minutes. Claude Code reported $0.83 in model usage. Local benchmarking incurred no API charges. The per-run measurements and decision records are under `.context/compound-engineering/ce-optimize/pdg-spill-time-memory/` in the benchmark workspace.

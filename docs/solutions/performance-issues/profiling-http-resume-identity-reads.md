---
title: Finding repeated file reads during HTTP embedding resume
date: "2026-11-23"
module: Analyzer and parser identity
problem_type: performance_issue
component: tooling
severity: medium
symptoms:
  - Resuming an interrupted embedding run spends CPU time hashing installed parser dependencies.
root_cause: redundant_io
resolution_type: code_fix
tags: [http-resume, parse-cache, cpu-profiling]
---

# Finding repeated file reads during HTTP embedding resume

An HTTP resume benchmark starts the CLI twice. The first invocation builds the graph and deliberately interrupts embedding. The benchmark times the second invocation, which finishes the pending inputs. Both write CPU profiles to the same case directory. The explicit CI job also uploads a profile for fresh HTTP embedding, a different workload.

From `gitnexus/`, set `BASE_CLI` to the comparison checkout’s built CLI and `RESULTS_DIR` to a directory for new output. Capture one diagnostic pair on the resume workload.

```sh
node bench/analyze-resume/measure.mjs --cpu-profile --scenarios http-resume \
  --pairs 1 --warmups 0 --baseline "$BASE_CLI" --output "$RESULTS_DIR/profile.json"
```

1. Use each side’s `setup.log` and `measured.log` to locate the second invocation. Match the profile timestamps and PIDs to that interval. A heap-budget relaunch can produce both a launcher profile and a profile for the child that actually analyzes the repository.
2. If hashing dominates the measured child, collect the paths and byte counts from `onHashedInput` on both identity resolvers in the same installation. Join by physical file path and sum the overlapping bytes. The two resolvers use different public identity formats, so matching their final digest strings cannot identify duplicate reads.
3. Check the reuse path against an independent cold parser read. Compare both the base and PDG parser identities, then change one dependency without changing its size and verify the new bytes are read. Confirm the elapsed-time result separately with the unprofiled `--check` run and equal embedding-input fingerprints.

On the measured installation, 830 regular dependency files accounted for 495 MB read by both resolvers. Reusing their raw content hashes left 14 MB for the parser to read. The analyzer still framed each content hash with its artifact metadata when constructing the public dependency digest. [Measurements and confidence intervals](../../optimize/main-pipeline-performance-report.md)

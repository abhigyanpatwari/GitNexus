# Identity-reader memory scaling: evidence and limits

The source-level live-memory bound is linear in graph nodes, stored identity
rows, and identity-string bytes. The measured process-memory results support
that growth rate over the tested range, but exposed a native allocation failure
in the first cooperative-reader probe. **That probe must not be retained.**

A separate direct-query routing probe passed the natural-GC soak and its own
size sweep. It remains an isolated experiment: no production adapter change
has been made, and memory neutrality has not been established.

## Main findings

| Check                                                      | Result                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Cooperative reader using prepared execution, forced GC     | Approximately linear RSS; R² 0.999875; held-out 1M result within 0.56% of prediction |
| Same reader, normal GC, 1,048,576 nodes                    | Native 512 MiB buffer pool exhausted on read 9; reproduced in a fresh process        |
| Unchanged reader, same fixture/pool/heap, normal GC        | All 12 requested reads passed                                                        |
| Cooperative reader using direct-query execution, normal GC | All 40 requested million-node reads passed                                           |
| Direct-query probe, independent natural-GC size sweep      | Approximately linear RSS; R² 0.998393; held-out 1M result 0.18% above prediction     |

The failed reproduction recorded 249 cursor-close calls with no close errors.
Changing execution routing while retaining the SQL and row conversion avoided
the failure. This localizes the problem to the prepared-execution path in these
probes; it does not establish the exact native ownership or allocator bug.

## Normal-GC scaling of the direct-query probe

Each point below is the median of three fresh processes. Each process performs
five complete verifications, with no forced collection between them. The heap
limit is 4 GiB and the database buffer pool is fixed at 512 MiB. Collection runs
before measurement and once at the end to measure retained heap.

|     Nodes | Peak RSS, MiB |      Range, MiB |
| --------: | ------------: | --------------: |
|    16,384 |         300.5 |     299.3–302.2 |
|    65,536 |         410.5 |     410.4–410.7 |
|   131,072 |         556.3 |     556.3–556.5 |
|   262,144 |         806.2 |     805.6–807.7 |
|   524,288 |       1,283.9 | 1,281.6–1,289.8 |
| 1,048,576 |       2,306.2 | 2,305.0–2,307.1 |

Fitting only the points through 524,288 nodes gives:

`peak RSS ≈ 287.4 MiB + 2,014.7 bytes × node count`.

The held-out million-node prediction is 2,302.1 MiB; the observed median is
2,306.2 MiB, a 0.18% difference. Retained JavaScript heap also scales linearly:
about 424.7 bytes/node plus 9.7 MiB, R² 0.999995. The million-node retained heap
is 434.9 MiB, within 0.12% of that model's held-out prediction.

At 65,536 nodes, increasing total identity bytes from 2.94 to 26.94 to 98.94 MiB
increased median peak RSS from 410.5 to 613.1 to 1,069.3 MiB. The three-point
byte-size fit has R² 0.9961. It supports a byte-sensitive bound; it is not a
universal extrapolation to arbitrary string sizes or encodings.

## Repeated reads still have a cost

The direct-query probe's 40-read natural-GC run reached 2,900.2 MiB peak RSS.
Its first 12 reads reached 2,416.7 MiB, versus 2,223.8 MiB for the unchanged
reader's 12-read control: an observed **8.7% increase** in this single matched
comparison. This is not a replicated estimate of a general memory regression.

Median RSS rose from 2,427.0 MiB in reads 11–20 to 2,532.2 MiB in reads 31–40.
Final collection reduced live JavaScript heap to 433.7 MiB, but RSS remained
2,243.3 MiB. These results do not prove a permanent RSS plateau or leak freedom.
They establish that 40 reads completed without the prepared-path pool failure.
All 1,240 observed cursor closes succeeded; all 1,240 diagnostic prepared-object
finalizers had run by completion.

The smaller forced-GC 65K soaks were more stable: median retained RSS changed
by approximately 0.3 MiB for the original reader and 0.4 MiB for the cooperative
prepared reader between the same windows. That result did not predict the
larger normal-GC failure, which is why forced-GC evidence alone is insufficient.

## What the source proves

Let `N_e` be expected graph nodes, `N_d` stored rows scanned, and `S` their
combined identity-string size. These counts differ when the database contains
unexpected rows. The verifier can materialize those rows before rejecting them.

- Expected-node maps hold at most `N_e` entries, referencing existing nodes.
  Normalized IDs add at most linear string storage.
- Each query returns one label's identity fields, with at most five scalar
  fields per row. It does not project source content or relationships.
- The cooperative reader appends each row once to one array. It retains one
  awaited continuation and no collection of previous arrays or promises.
- Validation keeps no additional graph-sized result structure. Maps and row
  arrays belong to one invocation; the adapter closes cursors in `finally`.

Under the usual linear-storage assumption for V8 maps and dense arrays, the
bound on reachable JavaScript entries and payload is **O(N_e + N_d + S)**.
For a matching graph and fixed schema this is **O(N + S)**; fixed-width
identities reduce it to O(N). The existing input graph is additional and can
hold edges, source text, and other properties outside this claim.

The 1,024-row chunk controls yielding. It does **not** bound memory to 1,024
rows: the complete table result is retained. Reachable-object bounds do not
prove when V8 collects garbage, when native allocations are released, or how
much memory the OS reports as resident. The observed failure is a direct reason
not to equate the source-level bound with a total-process safety guarantee.

## Protocol and evidence

All reader probes used the unchanged PR runtime
`6aeeace8e96603fb062dcc709e834042d5a6df74`, Node 22.23.3, and LadybugDB 0.22.0.
Fixtures contain one Function table with unique fixed-width ASCII identities;
this exercises the largest possible table result for a given node count.
They contain no relationships or source content. Every completed verification
checks all identity fields against the in-memory graph, not just counts.

The initial controlled sweep covered zero nodes and seven doubling sizes from
16K through 1M, three processes per reader/size, and three reads per process.
Separate string-width cases and soak tests followed. The direct-query variant
then received its own prospectively recorded six-size/three-repeat natural-GC
protocol, wider-string cases, and five reads per process. Samples from the two
execution routes are kept separate.

The direct-query diagnostic still creates prepared objects for instrumentation
but executes the SQL through `Connection.query` instead of executing those
prepared objects. A production implementation has not been built or measured.
Prepared-object finalizer counts are observations, not proof of native ownership.

An initial 256 MiB-pool bulk load failed before any reader measurement. Setup
was then performed in separate 1 GiB-pool processes; every reported reader
measurement uses the same 512 MiB pool. Setup peaks are excluded. A planned
additional natural-GC sweep of the prepared path was cancelled after its soak
failed; its frozen plan is retained and is not counted as executed work.

The evidence comprises **90 reader processes: 88 completed and two failed on
read 9**, with **448 completed full verifications** across those processes.
These are repeated synthetic checks, not 448 distinct test cases. No native
worker was terminated. No application dependency or production source changed.
Matplotlib 3.11.2 was used in an isolated tool environment to render the figures.

- [Figure](identity-memory-scaling-20261103.png) · [Vector PDF](identity-memory-scaling-20261103.pdf)
- [Raw samples and exact probe sources](identity-memory-scaling-20261103.json)
- [Process-level CSV](identity-memory-scaling-20261103.csv)

The JSON includes source/driver hashes, protocols, all completed and failed
samples, failure messages, and original probe scripts. Each worker accepts a
JSON config containing `runtime`, `storage`, `output`, `count`, `width`, `mode`,
`variant`, `iterations`, and `forceGc`; it runs with
`node --expose-gc --max-old-space-size=4096 worker.mjs config.json`.
Use a disposable fixture directory and the pinned, built runtime. Run `seed`
in a separate process before `measure`; never target a production index.

The conclusion is limited to these fixtures and ranges. It is not a
full-indexing, watch-mode, arbitrary-input, or unlimited-repetition guarantee.
The original cooperative prepared path is rejected. The direct-query route is
a measured next candidate, with an observed memory tradeoff still to resolve
before any retention decision.

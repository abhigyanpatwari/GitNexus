# Resumable analyze measurements

Run the native feasibility check from `gitnexus/`:

```sh
node --expose-gc bench/analyze-resume/native-primitives.mjs --check
```

The probe alternates baseline and candidate order, checks identical content and
vector coverage, verifies primary-key lookup in the native query plan, and opens
the published graph in a separate process while a vector writer remains open.
The write candidate includes active-intent fsync, a transaction per unit, native
checkpointing, and completed-cursor fsync. `--check` rejects a slower candidate
median for either reader or writer.

`native-baseline.json` records the initial Linux/Node 22 samples. The bounded
reader retained at most 1 MiB of content per batch for 10,000 nodes containing
40.96 MB of content. It still holds a small key array to isolate native fetch
cost; production manifest memory must be tested separately. The writer probe
uses 512 vectors with 256 dimensions and 64 vectors per durability unit.

These measurements establish native feasibility. They do not establish
end-to-end analyze throughput, crash recovery, model throughput, or total RSS
bounds. Run the application regression matrix before making those claims.
Windows handle behavior and local-model execution also need their own runs.

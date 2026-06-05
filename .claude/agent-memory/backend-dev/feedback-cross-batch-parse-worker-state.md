---
name: feedback-cross-batch-parse-worker-state
description: Cross-batch coordination on parse-worker.ts — the Angular metadata batch (WI-#32) leaves parse-worker.ts in a half-modified state that requires the Re-export + interface field + dispatch to be present for tsc to pass and integration tests to type-check.
metadata:
  type: feedback
---

When working on Batch E items in the GitNexus repo, the `parse-worker.ts` file is shared across multiple work items (WI-#7/#43 route extractor, WI-#32 metadata edges, etc.). The baseline state — before any batch starts — has the OTHER batch's modifications in the working tree as uncommitted changes (e.g. `M src/core/ingestion/workers/parse-worker.ts` shows in `git status`).

**Why:** Each batch assumes the OTHER batch's parse-worker.ts wiring is in place. If you `git checkout --` parse-worker.ts to "reset", you destroy the OTHER batch's work and break tsc. The OTHER batch's changes (re-export of `ExtractedAngularEdge`, `angularMetadata?` field on `ParseWorkerResult`, dispatch branch, merge logic) are required for the pipeline to be type-clean and the typescript integration test to pass.

**How to apply:** When you stash and pop across batches, preserve parse-worker.ts. If tsc fails with `ExtractedAngularEdge` not exported or `angularMetadata` not in `WorkerExtractedData`, you're missing the OTHER batch's wiring — re-add it rather than removing OTHER batch's pipeline.ts / parsing-processor.ts references. Always run `npx tsc --noEmit` to verify cross-batch type integrity after editing.

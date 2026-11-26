# Taint barrier-guard bench (#3913)

Build-free scaling + cleanliness gate for validating-predicate barrier guards.

```bash
node --import tsx bench/taint-barrier-guards/measure.mjs
node --import tsx bench/taint-barrier-guards/measure.mjs --check
```

- **guarded** corpus: `isValidHostName` early-return and per-key
  `if (!isValidKey(key)) continue` / early-return writers — must stay at
  **0 findings**. (`.filter(protoKey)` is intentionally not a neutralization
  path — rejecting `__proto__` must not kind-blind kill command-injection.)
- **unguarded** corpus: same sinks without barriers — must keep findings.
- `--check` compares fingerprints + analyzed counts to `baseline.json` and
  enforces `scaling ≤ scaling_budget` (default 2.5) for both arms.

# Taint barrier-guard bench (#3913)

Build-free scaling + cleanliness gate for validating-predicate barrier guards.

```bash
node --import tsx bench/taint-barrier-guards/measure.mjs
node --import tsx bench/taint-barrier-guards/measure.mjs --check
```

- **guarded** corpus: `isValidHostName` early-return, `.filter(isValidKey)`, and
  `__proto__`-guard callees — must stay at **0 findings**.
- **unguarded** corpus: same sinks without barriers — must keep findings.
- `--check` compares fingerprints + analyzed counts to `baseline.json` and
  enforces `scaling ≤ scaling_budget` (default 2.5) for both arms.

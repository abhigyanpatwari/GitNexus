# MCP serialization cost

MCP tool results use compact JSON. This removes formatting whitespace while
preserving every result field, source string, diagnostic, and next-step hint.
Plain-text results remain unchanged. Existing explicit output budgets still
apply after formatting; compact output can fit more complete evidence inside
the same budget.

The benchmark sends six fixed synthetic responses through the actual MCP
server and SDK. It asserts exact decoded payload equality and unchanged hints,
then compares the response with the previous pretty JSON representation.
The cases cover query results, source-bearing context, incomplete impact
evidence, an empty result, a structured error, and plain text.

## Reproduce

From `gitnexus/`, with its dependencies installed:

```sh
node --import tsx scripts/bench/mcp-serialization.ts
```

For token counts, from `eval/`:

```sh
uv run --locked python -m workflow_bench.measure_mcp_serialization
```

The measurement uses the existing locked `tiktoken` dependency. A minimal
environment can run the same measurement without installing the full evaluator:

```sh
uv run --no-project --with tiktoken==0.12.0 \
  python -m workflow_bench.measure_mcp_serialization
```

## Local result, 20 October 2026

Base: `01af833875cad5d2374ed988a39b77ff5f9e716e`. The baseline was measured before
the serialization edit. The accompanying `results.json` records the corpus and
candidate server SHA-256 hashes and per-case counts, including unchanged hints.

| Complete response corpus | Pretty JSON | Compact JSON | Reduction |
| ------------------------ | ----------: | -----------: | --------: |
| `o200k_base` tokens      |       5,945 |        3,928 |     33.9% |
| `cl100k_base` tokens     |       5,859 |        3,838 |     34.5% |
| UTF-8 bytes              |      20,229 |       14,218 |     29.7% |

All six payloads round-tripped exactly. Plain text had no savings. This measures
response input tokens, not total agent cost, latency, or task solve rate.
Actual bills depend on model pricing, caching, output tokens, subsequent tool
calls, and the quality of the completed work. No paid model runs were performed.
These numbers do not establish savings against an agent without GitNexus.

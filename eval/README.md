# GitNexus SWE-bench Evaluation Harness

Evaluate whether GitNexus code intelligence improves AI agent performance on real software engineering tasks. Runs SWE-bench instances across multiple models and compares baseline (no graph) vs GitNexus-enhanced configurations.

## What This Tests

**Hypothesis**: Giving AI agents structural code intelligence (call graphs, execution flows, blast radius analysis) improves their ability to resolve real GitHub issues — measured by resolve rate, cost, and efficiency.

**Evaluation modes:**

| Mode | What the agent gets |
|------|-------------------|
| `baseline` | Standard bash tools (grep, find, cat, sed) — control group |
| `native` | Baseline + explicit GitNexus tools via eval-server (~100ms) |
| `native_augment` | Native tools + grep results automatically enriched with graph context (**recommended**) |

> **Recommended**: Use `native_augment` mode. It mirrors the Claude Code model — the agent gets both explicit GitNexus tools (fast bash commands) AND automatic enrichment of grep results with callers, callees, and execution flows. The agent decides when to use explicit tools vs rely on enriched search output.

**Models supported:**

- Claude 3.5 Haiku, Claude Sonnet 4, Claude Opus 4
- MiniMax M1 2.5
- GLM 4.7, GLM 5
- Any model supported by litellm (add a YAML config)

## Prerequisites

- Python 3.11+
- Docker (for SWE-bench containers)
- Node.js 18+ (for GitNexus)
- API keys for your chosen models

## Setup

```bash
cd eval

# Install dependencies
pip install -e .

# Set up API keys — copy the template and fill in your keys
cp .env.example .env
# Then edit .env and paste your key(s)
```

All models are routed through **OpenRouter** by default, so a single `OPENROUTER_API_KEY` is all you need. To use provider APIs directly (Anthropic, ZhipuAI, etc.), edit the model YAML in `configs/models/` and set the corresponding key in `.env`.

```bash
# Pull SWE-bench Docker images (pulled on-demand, but you can pre-pull)
docker pull swebench/sweb.eval.x86_64.django_1776_django-16527:latest
```

## Quick Start

### Debug a single instance

```bash
# Fastest way to verify everything works
python run_eval.py debug -m claude-haiku -i django__django-16527 --subset lite
```

### Run a single configuration

```bash
# 5 instances, Claude Sonnet, native_augment mode (default)
python run_eval.py single -m claude-sonnet --subset lite --slice 0:5

# Baseline comparison (no GitNexus)
python run_eval.py single -m claude-sonnet --mode baseline --subset lite --slice 0:5

# Full Lite benchmark, 4 parallel workers
python run_eval.py single -m claude-sonnet --subset lite -w 4
```

### Run the full matrix

```bash
# All models x all modes
python run_eval.py matrix --subset lite -w 4

# Key comparison: baseline vs native_augment
python run_eval.py matrix -m claude-sonnet -m claude-haiku --modes baseline --modes native_augment --subset lite --slice 0:50
```

### Analyze results

```bash
# Summary table
python -m analysis.analyze_results results/

# Compare modes for a specific model
python -m analysis.analyze_results compare-modes results/ -m claude-sonnet

# GitNexus tool usage analysis
python -m analysis.analyze_results gitnexus-usage results/

# Export as CSV for further analysis
python -m analysis.analyze_results summary results/ --format csv > results.csv

# Run official SWE-bench test evaluation
python -m analysis.analyze_results summary results/ --swebench-eval
```

### List available configurations

```bash
python run_eval.py list-configs
```

## Architecture

```
eval/
  run_eval.py              # Main entry point (single, matrix, debug commands)
  agents/
    gitnexus_agent.py      # GitNexusAgent: extends DefaultAgent with augmentation + metrics
  environments/
    gitnexus_docker.py     # Docker env with GitNexus + eval-server + standalone tool scripts
  bridge/
    gitnexus_tools.sh      # Bash wrappers (legacy — now standalone scripts are installed directly)
    mcp_bridge.py          # Legacy MCP bridge (kept for reference)
  prompts/
    system_baseline.jinja          # System: persona + format rules
    instance_baseline.jinja        # Instance: task + workflow
    system_native.jinja            # System: + GitNexus tool reference
    instance_native.jinja          # Instance: + GitNexus debugging workflow
    system_native_augment.jinja    # System: + GitNexus tools + grep enrichment docs
    instance_native_augment.jinja  # Instance: + GitNexus workflow + risk assessment
  configs/
    models/                # Per-model YAML configs
    modes/                 # Per-mode YAML configs (baseline, native, native_augment)
  analysis/
    analyze_results.py     # Post-run comparative analysis
  results/                 # Output directory (gitignored)
```

## How It Works

### Template structure

mini-swe-agent requires two Jinja templates:
- **system_template** → system message: persona, format rules, tool reference (static)
- **instance_template** → first user message: task, workflow, rules, examples (contains `{{task}}`)

Each mode has a `system_{mode}.jinja` + `instance_{mode}.jinja` pair. The agent loads both automatically based on the configured mode.

### Per-instance flow

1. Docker container starts with SWE-bench instance (repo at specific commit)
2. **GitNexus setup**: Node.js + gitnexus installed, `gitnexus analyze` runs (or restores from cache)
3. **Eval-server starts**: `gitnexus eval-server` daemon (persistent HTTP server, keeps LadybugDB warm)
4. **Standalone tool scripts installed** in `/usr/local/bin/` — works with `subprocess.run` (no `.bashrc` needed)
5. Agent runs with the configured model + system prompt + GitNexus tools
6. Agent's patch is extracted as a git diff
7. Metrics collected: cost, tokens, tool calls, GitNexus usage, augmentation stats

### Tool architecture

```
Agent → bash command → /usr/local/bin/gitnexus-query
  → curl localhost:4848/tool/query     (fast path: eval-server, ~100ms)
  → npx gitnexus query                 (fallback: cold CLI, ~5-10s)
```

Each tool script in `/usr/local/bin/` is standalone — no sourcing, no env inheritance needed. This is critical because mini-swe-agent runs every command via `subprocess.run` in a fresh subshell.

### Eval-server

The eval-server is a lightweight HTTP daemon that:
- Keeps LadybugDB warm in memory (no cold start per tool call)
- Returns LLM-friendly text (not raw JSON — saves tokens)
- Includes next-step hints to guide tool chaining (query → context → impact → fix)
- Auto-shuts down after idle timeout

### Index caching

SWE-bench repos repeat (Django has 200+ instances at different commits). The harness caches GitNexus indexes per `(repo, commit)` hash in `~/.gitnexus-eval-cache/` to avoid redundant re-indexing.

### Grep augmentation (native_augment mode)

When the agent runs `grep` or `rg`, the observation is post-processed: the agent class calls `gitnexus-augment` on the search pattern and appends `[GitNexus]` annotations showing callers, callees, and execution flows for matched symbols. This mirrors the Claude Code / Cursor hook integration.

## Adding Models

Create a YAML file in `configs/models/`:

```yaml
# configs/models/my-model.yaml
model:
  model_name: "openrouter/provider/model-name"
  cost_tracking: "ignore_errors"  # if not in litellm's cost DB
  model_kwargs:
    max_tokens: 8192
    temperature: 0
```

The model name follows [litellm conventions](https://docs.litellm.ai/docs/providers).

## Metrics Collected

| Metric | Description |
|--------|-------------|
| Patch Rate | % of instances where agent produced a patch |
| Resolve Rate | % of instances where patch passes tests (requires --swebench-eval) |
| Total Cost | API cost across all instances |
| Avg Cost/Instance | Cost efficiency |
| API Calls | Number of LLM calls |
| GN Tool Calls | How many GitNexus tools the agent used |
| Augment Hits | How many grep/find results got enriched |
| Augment Hit Rate | % of search commands that got useful enrichment |

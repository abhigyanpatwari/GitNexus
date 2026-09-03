#!/usr/bin/env bash
# Local and CI entrypoint for the propose → benchmark → gate loop.
#
# The GitHub skill-evolution job must call this script. Do not inline
# `python -m workflow_bench.evolve` in the workflow; that argv lives here so a
# laptop run and a self-hosted run cannot drift.
#
# Usage:
#   ./workflow_bench/run-evolution.sh                  # local, no --apply
#   ./workflow_bench/run-evolution.sh --apply          # CI / mutate working tree
#   ./workflow_bench/run-evolution.sh --dry-run        # print argv, no model calls
#   PROVIDER=openai ./workflow_bench/run-evolution.sh
#
# Environment (same names the workflow already sets):
#   MODEL PROPOSER_MODEL EFFORT GENERATIONS RUNS WORKERS PROVIDER
#   INCLUDE_EXPENSIVE SEED_RESULTS CLAUDE_BIN OUT_ROOT
#   GITNEXUS_BENCH_ANTHROPIC_API_KEY (legacy GITNEXUS_BENCH_AUTH_TOKEN)
#   GITNEXUS_BENCH_OPENAI_API_KEY
set -euo pipefail

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval_dir="$(cd "${script_dir}/.." && pwd)"
apply=0
dry_run=0
passthrough=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      apply=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      passthrough+=("$@")
      break
      ;;
    *)
      passthrough+=("$1")
      shift
      ;;
  esac
done

MODEL="${MODEL:-gpt-5.6-sol}"
PROPOSER_MODEL="${PROPOSER_MODEL:-gpt-5.6-sol}"
EFFORT="${EFFORT:-xhigh}"
GENERATIONS="${GENERATIONS:-1}"
RUNS="${RUNS:-3}"
WORKERS="${WORKERS:-1}"
PROVIDER="${PROVIDER:-openai}"
INCLUDE_EXPENSIVE="${INCLUDE_EXPENSIVE:-}"
SEED_RESULTS="${SEED_RESULTS:-}"
anthropic_key="${GITNEXUS_BENCH_ANTHROPIC_API_KEY:-${GITNEXUS_BENCH_AUTH_TOKEN:-}}"
openai_key="${GITNEXUS_BENCH_OPENAI_API_KEY:-}"

route_openai=0
case "${PROVIDER}" in
  openai)
    route_openai=1
    ;;
  anthropic)
    route_openai=0
    ;;
  auto)
    if [[ -z "${anthropic_key}" && -n "${openai_key}" ]]; then
      route_openai=1
    fi
    ;;
  *)
    echo "Unknown PROVIDER '${PROVIDER}' (expected auto, openai, or anthropic)." >&2
    exit 1
    ;;
esac

if ((route_openai)); then
  if [[ "${MODEL}" == claude-* ]]; then
    echo "Routing Claude Code through a loopback OpenAI gateway with model gpt-5.6-sol. Set MODEL to override." >&2
    MODEL=gpt-5.6-sol
  fi
  if [[ "${PROPOSER_MODEL}" == claude-* ]]; then
    PROPOSER_MODEL=gpt-5.6-sol
  fi
fi

if ((dry_run == 0)); then
  if [[ "${PROVIDER}" == openai && -z "${openai_key}" ]]; then
    echo "PROVIDER=openai requires GITNEXUS_BENCH_OPENAI_API_KEY." >&2
    exit 1
  fi
  if [[ "${PROVIDER}" == anthropic && -z "${anthropic_key}" ]]; then
    echo "PROVIDER=anthropic requires GITNEXUS_BENCH_ANTHROPIC_API_KEY (legacy GITNEXUS_BENCH_AUTH_TOKEN is accepted)." >&2
    exit 1
  fi
  if [[ -z "${anthropic_key}" && -z "${openai_key}" ]]; then
    echo "Set GITNEXUS_BENCH_ANTHROPIC_API_KEY and/or GITNEXUS_BENCH_OPENAI_API_KEY before a real run." >&2
    exit 1
  fi
fi

claude_bin="${CLAUDE_BIN:-}"
if [[ -z "${claude_bin}" && -n "${RUNNER_TEMP:-}" ]]; then
  canary="${RUNNER_TEMP}/claude-canary/node_modules/@anthropic-ai/claude-code-linux-x64/claude"
  if [[ -x "${canary}" ]]; then
    claude_bin="${canary}"
  fi
fi
if [[ -z "${claude_bin}" ]] && command -v claude >/dev/null 2>&1; then
  claude_bin="$(command -v claude)"
fi
if [[ -z "${claude_bin}" ]]; then
  claude_bin=claude
fi
if ((dry_run == 0)) && ! command -v "${claude_bin}" >/dev/null 2>&1 && [[ ! -x "${claude_bin}" ]]; then
  echo "Claude Code binary not found (${claude_bin}). Set CLAUDE_BIN or install claude on PATH." >&2
  exit 1
fi

if [[ -n "${OUT_ROOT:-}" ]]; then
  out_root="${OUT_ROOT}"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
  out_root="${RUNNER_TEMP}/wfevolve"
else
  out_root="${eval_dir}/results/wfevolve-$(date -u +%Y%m%dT%H%M%SZ)"
fi

cmd=(
  uv run --locked --extra dev python -m workflow_bench.evolve
  --tasks workflow_bench/tasks.scenarios.yaml
  --model "${MODEL}"
  --proposer-model "${PROPOSER_MODEL}"
  --effort "${EFFORT}"
  --generations "${GENERATIONS}"
  --runs "${RUNS}"
  --workers "${WORKERS}"
  --claude-bin "${claude_bin}"
  --out-root "${out_root}"
)
if ((apply)); then
  cmd+=(--apply)
fi
if [[ -n "${INCLUDE_EXPENSIVE}" && "${INCLUDE_EXPENSIVE}" != "0" && "${INCLUDE_EXPENSIVE}" != "false" ]]; then
  cmd+=(--include-expensive)
fi
if [[ -n "${SEED_RESULTS}" ]]; then
  cmd+=(--seed-results "${SEED_RESULTS}")
fi
if ((${#passthrough[@]})); then
  cmd+=("${passthrough[@]}")
fi

if ((dry_run)); then
  printf '%q ' "${cmd[@]}"
  printf '\n'
  exit 0
fi

export PYTHONUNBUFFERED=1
cd "${eval_dir}"
exec "${cmd[@]}"

#!/usr/bin/env bash
# Paired DeepSWE run: prepare both arms, run pier on each, write the report.
#
#   OPENAI_API_KEY=... eval/deepswe/run.sh --n-tasks 10 --concurrency 4
#
# Needs docker, git, node/npm 22.18+, python3.11+ and pier (`uv tool install
# datacurve-pier==0.3.1`). Everything lands under --work (default ~/deepswe-work).
set -euo pipefail

DEEP_SWE_REPO=https://github.com/datacurve-ai/deep-swe
DEEP_SWE_COMMIT=0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea
PIER_VERSION=0.3.1

AGENT=mini-swe-agent
MODEL=openai/gpt-5.6-sol
EFFORT=low
N_TASKS=10
SEED=0
CONCURRENCY=2
COST_LIMIT=5
WORK="$HOME/deepswe-work"
PACKAGE=""
TASKS=()
ARMS=(baseline gitnexus)

usage() {
  cat <<EOF
Usage: $0 [options]
  --n-tasks N        seeded random subset size (default $N_TASKS; 0 = all 113)
  --seed S           sample seed (default $SEED)
  --task ID          run this task id; repeatable, overrides --n-tasks
  --concurrency C    pier --n-concurrent per arm (default $CONCURRENCY; each trial uses 2 CPUs / 8 GB)
  --agent A          pier agent (default $AGENT)
  --model M          pier model (default $MODEL)
  --effort E         reasoning effort (default $EFFORT)
  --cost-limit USD   per-trial agent cost cap, same for both arms (default $COST_LIMIT; 0 = none)
  --package TGZ      prebuilt \`npm pack\` tarball of gitnexus/ (default: build from this checkout)
  --arms "A B"       arms to run (default: "${ARMS[*]}")
  --work DIR         working directory (default $WORK)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --n-tasks) N_TASKS="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --task) TASKS+=("$2"); shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --cost-limit) COST_LIMIT="$2"; shift 2 ;;
    --package) PACKAGE="$2"; shift 2 ;;
    --arms) read -r -a ARMS <<<"$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

EVAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$EVAL_DIR/.." && pwd)"
needed=(docker git python3 pier)
[[ " ${ARMS[*]} " == *" gitnexus "* ]] && [ -z "$PACKAGE" ] && needed+=(node npm)  # only to build the package
for tool in "${needed[@]}"; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH" >&2; exit 1; }
done
pier_version="$(pier --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ "$pier_version" = "$PIER_VERSION" ] || echo "warning: pier $pier_version, pinned $PIER_VERSION" >&2
case "$MODEL" in
  openai/*) : "${OPENAI_API_KEY:?OPENAI_API_KEY is required for $MODEL}" ;;
  anthropic/*) : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required for $MODEL}" ;;
esac
mkdir -p "$WORK"

if [ ! -d "$WORK/deep-swe/.git" ]; then
  git clone --quiet "$DEEP_SWE_REPO" "$WORK/deep-swe"
fi
git -C "$WORK/deep-swe" fetch --quiet origin "$DEEP_SWE_COMMIT" 2>/dev/null || true
git -C "$WORK/deep-swe" checkout --quiet --detach "$DEEP_SWE_COMMIT"

if [[ " ${ARMS[*]} " == *" gitnexus "* ]] && [ -z "$PACKAGE" ]; then
  echo "building the gitnexus package from $REPO_ROOT"
  # Same steps as the CI package job: prepack compiles the CLI and web UI into the tarball.
  (cd "$REPO_ROOT/gitnexus" && npm ci --ignore-scripts --no-fund --no-audit)
  (cd "$REPO_ROOT/gitnexus-shared" && node ../gitnexus/node_modules/typescript/lib/tsc.js)
  (cd "$REPO_ROOT/gitnexus-web" && npm ci --no-fund --no-audit)
  (cd "$REPO_ROOT/gitnexus" && npm pack --pack-destination "$WORK" >/dev/null)
  PACKAGE="$(ls -t "$WORK"/gitnexus-*.tgz | head -1)"
fi

select_args=()
if [ ${#TASKS[@]} -gt 0 ]; then
  for task in "${TASKS[@]}"; do select_args+=(--task "$task"); done
elif [ "$N_TASKS" != 0 ]; then
  select_args+=(--n-tasks "$N_TASKS" --sample-seed "$SEED")
fi
package_args=()
[ -n "$PACKAGE" ] && package_args+=(--gitnexus-package "$PACKAGE")
(cd "$EVAL_DIR" && python3 -m deepswe.prepare --deep-swe "$WORK/deep-swe" --out "$WORK/tasks" \
  --arms "${ARMS[@]}" "${package_args[@]}" "${select_args[@]}")

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
agent_args=(--agent "$AGENT" --model "$MODEL")
if [ "$AGENT" = mini-swe-agent ]; then
  agent_args+=(--ak "reasoning_effort=$EFFORT" --ak "cost_limit=$COST_LIMIT")
elif [ "$AGENT" = claude-code ]; then
  agent_args+=(--ak "reasoning_effort=$EFFORT")
  [ "$COST_LIMIT" != 0 ] && agent_args+=(--ak "max_budget_usd=$COST_LIMIT")
fi
for arm in "${ARMS[@]}"; do
  echo "== pier: $arm"
  # A failed trial is recorded in the job and reported; keep going to the other arm.
  pier run -p "$WORK/tasks/$arm" --env docker "${agent_args[@]}" \
    --n-concurrent "$CONCURRENCY" --jobs-dir "$WORK/jobs" --job-name "$arm-$stamp" --yes || \
    echo "pier exited nonzero for $arm; see $WORK/jobs/$arm-$stamp" >&2
done

if [ ${#ARMS[@]} -eq 2 ]; then
  (cd "$EVAL_DIR" && python3 -m deepswe.report --baseline "$WORK/jobs/baseline-$stamp" \
    --gitnexus "$WORK/jobs/gitnexus-$stamp" --out "$WORK/report-$stamp")
  echo "report: $WORK/report-$stamp/deepswe-comparison.md"
fi

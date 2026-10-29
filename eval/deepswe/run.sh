#!/usr/bin/env bash
# Paired DeepSWE run: prepare both arms, run pier on each, write the report.
#
#   OPENAI_API_KEY=... eval/deepswe/run.sh --n-tasks 10 --concurrency 4
#
# The default agent is Claude Code. A non-Claude model (default gpt-5.6-sol)
# goes through a local LiteLLM gateway, as in workflow_bench; an `anthropic/`
# or `claude-` model uses ANTHROPIC_API_KEY directly. Needs docker, git,
# python3.11+, pier (`uv tool install datacurve-pier==0.3.1`) and, to build the
# package, node/npm 22.18+. Everything lands under --work (default ~/deepswe-work).
set -euo pipefail

DEEP_SWE_REPO=https://github.com/datacurve-ai/deep-swe
DEEP_SWE_COMMIT=0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea
PIER_VERSION=0.3.1
CLAUDE_CODE_VERSION=2.1.214   # the release evaluation's pinned CLI
LITELLM_VERSION=1.100.4       # eval/uv.lock
MINI_SWE_AGENT_VERSION=2.2.7  # eval/uv.lock
GATEWAY_CONTAINER=deepswe-litellm-gateway
GATEWAY_PORT=80               # pier's egress proxy only allows ports 80 and 443

AGENT=claude-code
MODEL=gpt-5.6-sol
EFFORT=low
N_TASKS=10
SEED=0
CONCURRENCY=2
COST_LIMIT=5
WORK="$HOME/deepswe-work"
PACKAGE=""
GATEWAY_HOST=""
TASKS=()
ARMS=(baseline gitnexus)

usage() {
  cat <<EOF
Usage: $0 [options]
  --n-tasks N         seeded random subset size (default $N_TASKS; 0 = all 113)
  --seed S            sample seed (default $SEED)
  --task ID           run this task id; repeatable, overrides --n-tasks
  --concurrency C     pier --n-concurrent per arm (default $CONCURRENCY; each trial uses 2 CPUs / 8 GB)
  --agent A           claude-code (default) or mini-swe-agent
  --model M           default $MODEL; claude-code: a gateway model name or anthropic/<claude model>;
                      mini-swe-agent: a litellm name such as openai/gpt-5.6-sol
  --effort E          reasoning effort (default $EFFORT)
  --cost-limit USD    per-trial agent cost cap, same for both arms (default $COST_LIMIT; 0 = none)
  --package TGZ       prebuilt \`npm pack\` tarball of gitnexus/ (default: build from this checkout)
  --gateway-host H    hostname the trial egress proxy uses to reach this host's gateway
                      (default: host.docker.internal if it resolves, else the EC2 private DNS name)
  --arms "A B"        arms to run (default: "${ARMS[*]}")
  --work DIR          working directory (default $WORK)
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
    --gateway-host) GATEWAY_HOST="$2"; shift 2 ;;
    --arms) read -r -a ARMS <<<"$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

EVAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$EVAL_DIR/.." && pwd)"
needed=(docker git python3 pier curl)
[[ " ${ARMS[*]} " == *" gitnexus "* ]] && [ -z "$PACKAGE" ] && needed+=(node npm)  # only to build the package
for tool in "${needed[@]}"; do
  command -v "$tool" >/dev/null || { echo "missing $tool on PATH" >&2; exit 1; }
done
pier_version="$(pier --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ "$pier_version" = "$PIER_VERSION" ] || echo "warning: pier $pier_version, pinned $PIER_VERSION" >&2

agent_args=(--agent "$AGENT" --model "$MODEL")
use_gateway=0
case "$AGENT" in
  claude-code)
    agent_args+=(--ak "version=$CLAUDE_CODE_VERSION" --ak "reasoning_effort=$EFFORT")
    [ "$COST_LIMIT" != 0 ] && agent_args+=(--ak "max_budget_usd=$COST_LIMIT")
    case "$MODEL" in
      anthropic/*|claude-*) : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required for $MODEL}" ;;
      */*) echo "claude-code through the gateway takes a bare model name, not $MODEL" >&2; exit 2 ;;
      *) : "${OPENAI_API_KEY:?OPENAI_API_KEY is required for the $MODEL gateway}"; use_gateway=1 ;;
    esac
    ;;
  mini-swe-agent)
    # litellm's Responses path imports `mcp`, which a bare mini-swe-agent install lacks.
    agent_args+=(--ak "version=$MINI_SWE_AGENT_VERSION" --ak "reasoning_effort=$EFFORT"
                 --ak "cost_limit=$COST_LIMIT" --ak 'extra_python_packages=["mcp"]')
    case "$MODEL" in
      openai/*) : "${OPENAI_API_KEY:?OPENAI_API_KEY is required for $MODEL}" ;;
      anthropic/*) : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required for $MODEL}" ;;
    esac
    ;;
  *) echo "unsupported agent: $AGENT" >&2; exit 2 ;;
esac
mkdir -p "$WORK"

start_gateway() {
  if [ -z "$GATEWAY_HOST" ]; then
    if getent hosts host.docker.internal >/dev/null; then
      GATEWAY_HOST=host.docker.internal
    else
      imds_token="$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
        http://169.254.169.254/latest/api/token 2>/dev/null || true)"
      GATEWAY_HOST="$(curl -fsS -H "X-aws-ec2-metadata-token: $imds_token" \
        http://169.254.169.254/latest/meta-data/local-hostname 2>/dev/null || hostname -f)"
    fi
  fi
  local dir="$WORK/gateway"
  mkdir -p "$dir"
  # Same routing as workflow_bench.model_gateway: Claude Code speaks Anthropic
  # Messages; LiteLLM serves them from OpenAI's Responses API.
  cat > "$dir/litellm.yaml" <<EOF
model_list:
  - model_name: $MODEL
    litellm_params:
      model: openai/$MODEL
      api_key: os.environ/OPENAI_API_KEY
      timeout: 900
    model_info:
      mode: responses
litellm_settings:
  request_timeout: 900
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
EOF
  GATEWAY_KEY="sk-deepswe-$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  docker rm -f "$GATEWAY_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$GATEWAY_CONTAINER" -p "$GATEWAY_PORT:4000" \
    -e OPENAI_API_KEY -e LITELLM_MASTER_KEY="$GATEWAY_KEY" -e LITELLM_LOCAL_MODEL_COST_MAP=True \
    -v "$dir:/cfg:ro" python:3.12-slim \
    sh -c "pip install --quiet --no-cache-dir 'litellm[proxy]==$LITELLM_VERSION' && exec litellm --config /cfg/litellm.yaml --host 0.0.0.0 --port 4000" \
    >/dev/null
  trap 'docker rm -f "$GATEWAY_CONTAINER" >/dev/null 2>&1 || true' EXIT
  echo "waiting for the LiteLLM gateway on http://$GATEWAY_HOST:$GATEWAY_PORT"
  for _ in $(seq 1 180); do
    if curl -fsS -o /dev/null -H "Authorization: Bearer $GATEWAY_KEY" \
      "http://$GATEWAY_HOST:$GATEWAY_PORT/health/liveliness" 2>/dev/null; then
      agent_args+=(--ae "ANTHROPIC_BASE_URL=http://$GATEWAY_HOST:$GATEWAY_PORT" --ae "ANTHROPIC_AUTH_TOKEN=$GATEWAY_KEY")
      return 0
    fi
    docker inspect -f '{{.State.Running}}' "$GATEWAY_CONTAINER" 2>/dev/null | grep -q true || break
    sleep 2
  done
  echo "gateway did not become ready; last log lines:" >&2
  docker logs --tail 20 "$GATEWAY_CONTAINER" >&2 || true
  exit 1
}

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

[ "$use_gateway" = 1 ] && start_gateway

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
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

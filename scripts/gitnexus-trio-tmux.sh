#!/usr/bin/env bash
# Create or attach a Codex-first trio tmux workspace for GitNexus.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/gitnexus-trio-tmux.sh [session-name] [--attach] [--replace]

Examples:
  scripts/gitnexus-trio-tmux.sh
  scripts/gitnexus-trio-tmux.sh gitnexus-trio --attach
  scripts/gitnexus-trio-tmux.sh review-trio --replace

Behavior:
  - Creates a tmux session rooted at this repo
  - Refuses to overwrite an existing session unless --replace is passed
  - With --attach, attaches after creation (or after replacing)
  - Default session name: gitnexus-trio
EOF
}

SESSION_NAME="gitnexus-trio"
ATTACH=1
REPLACE=0

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --attach)
      ATTACH=1
      ;;
    --replace)
      REPLACE=1
      ;;
    --detach)
      ATTACH=0
      ;;
    --*)
      echo "Unknown flag: $arg" >&2
      usage >&2
      exit 1
      ;;
    *)
      SESSION_NAME="$arg"
      ;;
  esac
done

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required but not installed." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

HANDOFF="$REPO_ROOT/.agent-sessions/handoff.md"
mkdir -p "$REPO_ROOT/.agent-sessions"
if [[ ! -f "$HANDOFF" ]]; then
  printf '%s\n' '# Cross-tool handoff (append-only)' '' 'Codex-first trio workspace notes for GitNexus.' '' > "$HANDOFF"
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if [[ "$REPLACE" -eq 1 ]]; then
    tmux kill-session -t "$SESSION_NAME"
  else
    echo "Session '$SESSION_NAME' already exists. Pass --replace to recreate it." >&2
    if [[ "$ATTACH" -eq 1 ]]; then
      exec tmux attach-session -t "$SESSION_NAME"
    fi
    exit 1
  fi
fi

send_cmd() {
  local target="$1"
  local command="$2"
  tmux send-keys -t "$target" C-c
  tmux send-keys -t "$target" "$command" C-m
}

start_cli() {
  local target="$1"
  local cli="$2"
  send_cmd "$target" "cd $(printf '%q' "$REPO_ROOT")"
  if command -v "$cli" >/dev/null 2>&1; then
    send_cmd "$target" "$cli"
  else
    send_cmd "$target" "echo '(install $cli — pane ready in $REPO_ROOT)'"
  fi
}

make_watch_loop() {
  local body="$1"
  local sleep_s="$2"
  cat <<EOF
while true; do
  clear
  $body
  sleep $sleep_s
done
EOF
}

tmux new-session -d -s "$SESSION_NAME" -n trio -c "$REPO_ROOT"
tmux split-window -h -t "$SESSION_NAME:trio" -c "$REPO_ROOT"
tmux split-window -h -t "$SESSION_NAME:trio.1" -c "$REPO_ROOT"
tmux select-layout -t "$SESSION_NAME:trio" even-horizontal

tmux select-pane -t "$SESSION_NAME:trio.0" -T "codex"
tmux select-pane -t "$SESSION_NAME:trio.1" -T "gemini"
tmux select-pane -t "$SESSION_NAME:trio.2" -T "claude"

start_cli "$SESSION_NAME:trio.0" codex
start_cli "$SESSION_NAME:trio.1" gemini
start_cli "$SESSION_NAME:trio.2" claude

tmux new-window -d -t "$SESSION_NAME:1" -n verify -c "$REPO_ROOT"
VERIFY_LOOP=$(make_watch_loop "printf 'VERIFY\\n======\\n'; date; printf '\\n'; git status --short --branch; printf '\\nSuggested checks:\\n  cd gitnexus && npm test\\n  cd gitnexus && npx tsc --noEmit\\n  cd gitnexus && npx gitnexus analyze\\n'" 12)
send_cmd "$SESSION_NAME:1" "$VERIFY_LOOP"

tmux new-window -d -t "$SESSION_NAME:2" -n workspace -c "$REPO_ROOT"
send_cmd "$SESSION_NAME:2" "cd $(printf '%q' "$REPO_ROOT") && printf 'Open workspace:\\n  /Users/seanburdges/Dev/workspaces/gitnexus.code-workspace\\n\\nRead first:\\n  AGENTS.md\\n  GUARDRAILS.md\\n  ARCHITECTURE.md\\n'"

tmux new-window -d -t "$SESSION_NAME:3" -n handoff -c "$REPO_ROOT"
send_cmd "$SESSION_NAME:3" "cd $(printf '%q' "$REPO_ROOT") && printf 'Handoff file: %s\\n\\n' $(printf '%q' "$HANDOFF") && tail -n 40 $(printf '%q' "$HANDOFF")"

tmux new-window -d -t "$SESSION_NAME:4" -n shell -c "$REPO_ROOT"
send_cmd "$SESSION_NAME:4" "cd $(printf '%q' "$REPO_ROOT") && printf 'Interactive shell ready in %s\\n' \"$REPO_ROOT\""

tmux select-window -t "$SESSION_NAME:trio"
tmux select-pane -t "$SESSION_NAME:trio.0"

echo "Created tmux session: $SESSION_NAME"
echo "Windows: trio | verify | workspace | handoff | shell"
echo "Repo: $REPO_ROOT"

if [[ "$ATTACH" -eq 1 ]]; then
  exec tmux attach-session -t "$SESSION_NAME"
fi

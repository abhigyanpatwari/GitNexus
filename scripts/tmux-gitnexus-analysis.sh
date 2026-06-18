#!/usr/bin/env bash
# Create or attach a read-only analysis tmux workspace for GitNexus.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/tmux-gitnexus-analysis.sh [session-name] [--attach] [--replace]
EOF
}

SESSION_NAME="gitnexus-analysis"
ATTACH=1
REPLACE=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --attach) ATTACH=1 ;;
    --detach) ATTACH=0 ;;
    --replace) REPLACE=1 ;;
    --*) echo "Unknown flag: $arg" >&2; usage >&2; exit 1 ;;
    *) SESSION_NAME="$arg" ;;
  esac
done
command -v tmux >/dev/null 2>&1 || { echo "tmux is required but not installed." >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HANDOFF="$REPO_ROOT/.agent-sessions/handoff.md"
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if [[ "$REPLACE" -eq 1 ]]; then tmux kill-session -t "$SESSION_NAME"; else
    echo "Session '$SESSION_NAME' already exists. Pass --replace to recreate it." >&2
    if [[ "$ATTACH" -eq 1 ]]; then
  exec tmux attach-session -t "$SESSION_NAME"
fi
    exit 1
  fi
fi
send_cmd() { tmux send-keys -t "$1" C-c; tmux send-keys -t "$1" "$2" C-m; }
make_watch_loop() { local body="$1"; local sleep_s="$2"; cat <<EOF
while true; do
  clear
  $body
  sleep $sleep_s
done
EOF
}

tmux new-session -d -s "$SESSION_NAME" -n overview -c "$REPO_ROOT"
sleep 0.2
OVERVIEW_LOOP=$(make_watch_loop "printf 'GITNEXUS ANALYSIS\\n=================\\n'; date; printf '\\n'; git status --short --branch; printf '\\nSuggested reads:\\n  AGENTS.md\\n  GUARDRAILS.md\\n  ARCHITECTURE.md\\n'" 15)
send_cmd "$SESSION_NAME:overview" "$OVERVIEW_LOOP"

tmux new-window -d -t "$SESSION_NAME:1" -n workspace -c "$REPO_ROOT"
sleep 0.1
send_cmd "$SESSION_NAME:1" "cd $(printf '%q' "$REPO_ROOT") && printf 'Open workspace:\\n  /Users/seanburdges/Dev/workspaces/gitnexus.code-workspace\\n\\nRead first:\\n  AGENTS.md\\n  GUARDRAILS.md\\n  ARCHITECTURE.md\\n'"

tmux new-window -d -t "$SESSION_NAME:2" -n checks -c "$REPO_ROOT"
sleep 0.1
CHECK_LOOP=$(make_watch_loop "printf 'CHECKS TO RUN MANUALLY\\n======================\\n'; printf 'cd gitnexus && npm test\\n'; printf 'cd gitnexus && npx tsc --noEmit\\n'; printf 'cd gitnexus && npx gitnexus analyze\\n'; printf '\\nTop-level dirs:\\n'; find . -maxdepth 2 -type d | head -40" 20)
send_cmd "$SESSION_NAME:2" "$CHECK_LOOP"

tmux new-window -d -t "$SESSION_NAME:3" -n handoff -c "$REPO_ROOT"
sleep 0.1
send_cmd "$SESSION_NAME:3" "cd $(printf '%q' "$REPO_ROOT") && printf 'Handoff file: %s\\n\\n' $(printf '%q' "$HANDOFF") && [ -f $(printf '%q' "$HANDOFF") ] && tail -n 40 $(printf '%q' "$HANDOFF") || echo 'No handoff file yet.'"

tmux new-window -d -t "$SESSION_NAME:4" -n shell -c "$REPO_ROOT"
sleep 0.1
send_cmd "$SESSION_NAME:4" "cd $(printf '%q' "$REPO_ROOT") && printf 'Read-only analysis shell ready in %s\\n' \"$REPO_ROOT\""

tmux select-window -t "$SESSION_NAME:overview"
echo "Created tmux session: $SESSION_NAME"
echo "Windows: overview | workspace | checks | handoff | shell"
echo "Repo: $REPO_ROOT"
if [[ "$ATTACH" -eq 1 ]]; then
  exec tmux attach-session -t "$SESSION_NAME"
fi

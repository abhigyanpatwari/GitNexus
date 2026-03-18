#!/bin/bash
# GitNexus SessionStart hook for Claude Code
# Fires on session startup. Stdout is injected into Claude's context.
# Checks if the current directory has a GitNexus index.

dir="$PWD"
found=false
for i in 1 2 3 4 5; do
  if [ -d "$dir/.gitnexus" ]; then
    found=true
    break
  fi
  parent="$(dirname "$dir")"
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done

if [ "$found" = false ]; then
  exit 0
fi

# Inject GitNexus context — this stdout goes directly into Claude's context
cat << 'EOF'
## GitNexus Code Intelligence

This codebase is indexed by GitNexus, providing a knowledge graph with execution flows, relationships, and semantic search.

**Available MCP Tools:**
- `query` — Process-grouped code intelligence (execution flows related to a concept)
- `context` — 360-degree symbol view (categorized refs, process participation)
- `impact` — Blast radius analysis (what breaks if you change a symbol)
- `detect_changes` — Git-diff impact analysis (what do your changes affect)
- `rename` — Multi-file coordinated rename with confidence tags
- `cypher` — Raw graph queries
- `list_repos` — Discover indexed repos

**Quick Start:** READ `gitnexus://repo/{name}/context` for codebase overview, then use `query` to find execution flows.

**Resources:** `gitnexus://repo/{name}/context` (overview), `/processes` (execution flows), `/schema` (for Cypher)
EOF

exit 0

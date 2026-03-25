---
name: gitnexus-cli
description: GitNexus CLI commands for indexing, status checks, and maintenance. Use when you need to run analyze, check status, clean the index, or generate wiki documentation
---

# GitNexus CLI Reference

Complete reference for GitNexus command-line interface operations.

## Core Commands

### npx gitnexus analyze
Index or re-index the current repository.

**Basic usage:**
```bash
npx gitnexus analyze
```

**With embeddings:**
```bash
npx gitnexus analyze --embeddings
```

**Options:**
- `--embeddings` — Generate semantic embeddings for better search
- `--repo <path>` — Analyze specific repository path

**When to use:**
- After committing code changes (index becomes stale)
- Initial setup of GitNexus
- After major refactoring
- When tools warn "Index is stale"

**Important:** Running `analyze` without `--embeddings` will DELETE any previously generated embeddings. Always check `.gitnexus/meta.json` first:

```bash
cat .gitnexus/meta.json | grep embeddings
```

If `"embeddings": 0`, you can run without flag. If `"embeddings": 511`, use `--embeddings` to preserve them.

### npx gitnexus status
Check index status and staleness.

**Usage:**
```bash
npx gitnexus status
```

**Shows:**
- Last indexed commit
- Current HEAD commit
- Whether index is stale
- Number of commits behind
- Stats (files, symbols, edges, communities, processes)

### npx gitnexus clean
Remove the GitNexus index.

**Usage:**
```bash
npx gitnexus clean
```

**Removes:**
- `.gitnexus/` directory
- All indexed data
- Embeddings

**When to use:**
- Starting fresh
- Troubleshooting index corruption
- Before switching to different branch structure

### npx gitnexus wiki
Generate skill files and documentation (requires API key).

**Usage:**
```bash
npx gitnexus wiki
```

**With API key:**
```bash
OPENAI_API_KEY=your-key npx gitnexus wiki
```

**Generates:**
- `.claude/skills/` directory structure
- Skill files for each community
- Core skill files (exploring, debugging, etc.)
- AGENTS.md updates

**Note:** Bob uses `.bob/skills/` instead of `.claude/skills/`, so this command is less relevant for Bob users. Skills are manually created in this project.

## Checking Index Freshness

### Method 1: Read meta.json
```bash
cat .gitnexus/meta.json
```

Look for:
- `lastCommit`: Last indexed commit hash
- `indexedAt`: Timestamp of last index
- `stats.embeddings`: Number of embeddings (0 = none)

### Method 2: Use status command
```bash
npx gitnexus status
```

### Method 3: Use MCP resource
```
READ gitnexus://repo/{name}/context
```

Look for staleness warning in the response.

## Workflow Examples

### Initial Setup
```bash
# 1. Install GitNexus
npm install -g gitnexus

# 2. Index repository with embeddings
cd /path/to/repo
npx gitnexus analyze --embeddings

# 3. Check status
npx gitnexus status
```

### After Code Changes
```bash
# 1. Commit your changes
git add .
git commit -m "feat: add new feature"

# 2. Re-index (preserve embeddings if they exist)
npx gitnexus analyze --embeddings

# 3. Verify
npx gitnexus status
```

### Troubleshooting
```bash
# 1. Clean old index
npx gitnexus clean

# 2. Re-index fresh
npx gitnexus analyze --embeddings

# 3. Verify
npx gitnexus status
```

### Checking Embeddings
```bash
# Check if embeddings exist
cat .gitnexus/meta.json | grep embeddings

# If "embeddings": 0, you can run without flag
npx gitnexus analyze

# If "embeddings": 511, preserve them
npx gitnexus analyze --embeddings
```

## Index Staleness

The index becomes stale when:
- Code is committed after last analyze
- Files are added/removed
- Branches are switched
- Code is refactored

**Signs of staleness:**
- Tools warn "Index is stale"
- `gitnexus status` shows commits behind
- `READ gitnexus://repo/{name}/context` shows warning
- Query results seem outdated

**Fix:**
```bash
npx gitnexus analyze --embeddings
```

## Embeddings

Embeddings enable semantic search in `gitnexus_query`:
- Better concept matching
- Natural language queries
- Ranked by relevance

**Cost:**
- Requires OpenAI API key
- Costs ~$0.01-0.10 per repo (depending on size)
- Generated once, reused until deleted

**When to use:**
- Large codebases (>100 files)
- Complex queries
- Natural language search
- When keyword search isn't enough

**When to skip:**
- Small repos (<50 files)
- Simple keyword queries
- No API key available
- Cost concerns

## File Locations

### Index Directory
```
.gitnexus/
├── lbug           # LanceDB vector database
└── meta.json      # Index metadata
```

### Metadata File
```json
{
  "repoPath": "/path/to/repo",
  "lastCommit": "abc123...",
  "indexedAt": "2026-03-24T17:30:31.584Z",
  "stats": {
    "files": 27,
    "nodes": 511,
    "edges": 712,
    "communities": 7,
    "processes": 20,
    "embeddings": 0
  }
}
```

## Integration with Bob

Bob automatically loads GitNexus rules from:
- `~/.bob/rules/gitnexus-core.md` (global)
- `~/.bob/rules-advanced/gitnexus-core.md` (advanced mode)
- `.bob/rules/project-context.md` (project-specific)

Bob skills are located in:
- `.bob/skills/gitnexus-*/SKILL.md` (project-specific)
- `~/.bob/skills/gitnexus-*/SKILL.md` (global)

## Common Issues

### "Index is stale"
**Solution:** Run `npx gitnexus analyze --embeddings`

### "No LLM API key found"
**Solution:** Set `OPENAI_API_KEY` or `GITNEXUS_API_KEY` environment variable

### Embeddings deleted accidentally
**Solution:** Re-run `npx gitnexus analyze --embeddings` (will regenerate)

### Query results seem wrong
**Solution:** Check staleness with `npx gitnexus status`, then re-index

### Index corruption
**Solution:** `npx gitnexus clean` then `npx gitnexus analyze --embeddings`
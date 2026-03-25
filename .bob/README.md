# GitNexus + Bob Setup Guide

Set up GitNexus as an MCP server for Bob AI Assistant, with skills and rules for code exploration, debugging, impact analysis, and more.

## Prerequisites

- Node.js 18+
- Bob AI Assistant installed
- Git repository to analyze

## Step 1: Install & Index Your Repository

```bash
cd <your_git_project>
npx gitnexus analyze --embeddings
```

This builds a knowledge graph of your codebase: symbols, relationships, execution flows, and semantic embeddings.

To verify:
```bash
gitnexus --version
ls .gitnexus/   # index directory should exist
```

## Step 2: Configure the MCP Server

Add the GitNexus MCP server to your Bob configuration.

**User-level** (`~/.bob/mcp_config.json`) — available across all projects:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

**Project-level** (`.bob/mcp_config.json`) — same format, scoped to one project.

## Step 3: Install Skills & Rules

Skills teach Bob how to use GitNexus effectively. Rules provide core behavioral guidelines.

### Global Installation (recommended)

Works across all projects:

```bash
# Copy skills
cp -r .bob/skills/* ~/.bob/skills/

# Copy rules
cp .bob/rules/gitnexus-core.md ~/.bob/rules/
```

### Project-Specific

If you're working inside this repo, the skills and rules in `.bob/` are already available — no action needed.

### Available Skills

| Skill | Purpose |
|-------|---------|
| `gitnexus-cli` | Run GitNexus CLI commands (analyze, status, clean, wiki) |
| `gitnexus-debugging` | Trace bugs and errors through the codebase |
| `gitnexus-exploring` | Understand architecture and execution flows |
| `gitnexus-guide` | Learn about GitNexus tools and graph schema |
| `gitnexus-impact-analysis` | Assess blast radius before changing code |
| `gitnexus-pr-review` | Review pull requests with graph-aware context |
| `gitnexus-refactoring` | Rename, extract, split, or move code safely |

## Step 4: Restart Bob

After changing MCP config, skills, or rules, **restart Bob** for the changes to take effect. Bob loads MCP server connections and skill definitions at startup.

## Step 5: Verify

1. **Test MCP server starts:**
   ```bash
   npx gitnexus mcp
   ```
   Expected: `GitNexus MCP Server started` — press `Ctrl+C` to stop.

2. **Test in Bob** (Advanced mode):
   ```
   "List all indexed repositories"
   ```
   Bob should use the `gitnexus_list_repos` tool and show indexed repos.

3. **Test a skill:**
   ```
   "What breaks if I change the download_video function?"
   ```
   Bob should activate `gitnexus-impact-analysis` and report the blast radius.

## Keeping the Index Fresh

```bash
# Re-index after code changes
npx gitnexus analyze --embeddings

# Clean and rebuild from scratch
npx gitnexus clean
npx gitnexus analyze --embeddings

# Check index status
npx gitnexus status
```

## Multiple Repositories

Index each repo separately — Bob can access all of them via the `list_repos` tool:

```bash
cd /path/to/repo1 && npx gitnexus analyze --embeddings
cd /path/to/repo2 && npx gitnexus analyze --embeddings
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `gitnexus: command not found` | `npm install -g gitnexus` or use `npx` |
| MCP server won't start | Upgrade to Node.js 18+ |
| Index is stale | `npx gitnexus analyze --embeddings` |
| Skills don't activate | Ensure Advanced mode is on; verify files with `ls ~/.bob/skills/gitnexus-*` |
| MCP tools not available | Check MCP config and restart Bob |
| Embeddings missing | Re-run with `--embeddings` flag (~$0.01-0.10 via OpenAI API) |

## Resources

- [GitNexus](https://github.com/abhigyanpatwari/GitNexus)
- [Bob Documentation](https://bob.build)
- [MCP Protocol](https://modelcontextprotocol.io)
- [Skills Reference](skills/)
- [Rules Reference](rules/)

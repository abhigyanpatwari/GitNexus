# GitNexus — dp-web4 fork

Local build at `gitnexus/dist/cli/index.js`. Built with `cd gitnexus && npm install && npm run build`.

## Local CLI usage (not npx)

```bash
# Index a repo
cd /path/to/repo
node /mnt/c/exe/projects/ai-agents/GitNexus/gitnexus/dist/cli/index.js analyze

# List indexed repos
node /mnt/c/exe/projects/ai-agents/GitNexus/gitnexus/dist/cli/index.js list

# Start MCP server (registered at user scope in Claude Code)
node /mnt/c/exe/projects/ai-agents/GitNexus/gitnexus/dist/cli/index.js mcp
```

## MCP registration

Already registered at user scope:
```bash
claude mcp add -s user gitnexus -- node /mnt/c/exe/projects/ai-agents/GitNexus/gitnexus/dist/cli/index.js mcp
```

## Notes

- Registry lives at `~/.gitnexus/registry.json` — one MCP server serves all indexed repos
- Per-repo index stored in `.gitnexus/` (gitignored)
- The upstream `analyze` command auto-appends verbose CLAUDE.md blocks to indexed repos — trim those down

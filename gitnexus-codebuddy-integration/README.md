# GitNexus — CodeBuddy integration

Static config that adds GitNexus knowledge-graph augmentation and skill files to CodeBuddy.

## What you get

| Layer      | What it does                                                                                                          | How it's installed                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **MCP**    | `gitnexus` MCP server with 16 tools (`query`, `context`, `impact`, `detect_changes`, `rename`, …)                     | `npx gitnexus setup` writes `~/.codebuddy/.mcp.json` automatically.                |
| **Skills** | `/gitnexus-exploring`, `/gitnexus-debugging`, `/gitnexus-impact-analysis`, `/gitnexus-refactoring`, `/gitnexus-cli`, `/gitnexus-pr-review`, `/gitnexus-guide` markdown skills | `npx gitnexus setup` copies them to `~/.codebuddy/skills/`.                        |
| **Hooks**  | `PreToolUse` / `PostToolUse` hooks that enrich `Grep` / `Glob` / `Bash` tool calls with graph context, and detect stale index after git mutations | `npx gitnexus setup` writes `~/.codebuddy/settings.json` and copies hook scripts.  |

### What's installed by `gitnexus setup`

| Step                              | Automated? |
| --------------------------------- | ---------- |
| `~/.codebuddy/.mcp.json`          | ✅         |
| `~/.codebuddy/skills/gitnexus-*`  | ✅         |
| `~/.codebuddy/settings.json` (hooks) | ✅       |
| `~/.codebuddy/hooks/gitnexus/`    | ✅         |

Both MCP config, skills, and hooks are global — they apply to all projects opened in CodeBuddy.

## Hook contract

CodeBuddy hooks are **fully compatible with the Claude Code hooks spec**. The hook receives a JSON event on stdin:

```json
{
  "hook_event_name": "PreToolUse" | "PostToolUse",
  "tool_name": "Grep" | "Glob" | "Bash",
  "tool_input": { /* tool-specific */ },
  "cwd": "/absolute/path/to/project"
}
```

It writes augmentation context to stdout as:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "additionalContext": "[GitNexus] …" } }
```

Empty stdout means "no augmentation, continue normally" — the hook never blocks the tool.

| Event          | Matcher             | Behavior                                                                  |
| -------------- | ------------------- | ------------------------------------------------------------------------- |
| `PreToolUse`   | `Grep\|Glob\|Bash`  | Extracts search pattern from tool input, runs `gitnexus augment`, injects graph context before tool executes |
| `PostToolUse`  | `Bash`              | Detects `git commit/merge/rebase` → checks index staleness → notifies agent to reindex |

## Verify

1. Index the project: `npx gitnexus analyze`
2. Restart CodeBuddy or reload the window so it picks up the new MCP config.
3. In CodeBuddy, check the MCP panel — GitNexus should appear as a connected server.
4. Try a query: ask CodeBuddy "Show me the auth flow" — GitNexus tools will be available.

## MCP config format

CodeBuddy uses `~/.codebuddy/.mcp.json` (JSONC format):

```jsonc
{
  "mcpServers": {
    "gitnexus": {
      "type": "stdio",
      "command": "gitnexus",
      "args": ["mcp"]
    }
  }
}
```

## Skills format

Skills follow the Agent Skills standard installed at `~/.codebuddy/skills/gitnexus-*/SKILL.md`. Each skill includes YAML frontmatter with `name` and `description` fields that CodeBuddy uses to decide when to invoke the skill.

## Configuration priority

CodeBuddy uses two levels of configuration for hooks — project-level overrides user-level:

| Level   | Path                                      | Priority |
| ------- | ----------------------------------------- | -------- |
| Project | `<workspace>/.codebuddy/settings.json`    | High     |
| User    | `~/.codebuddy/settings.json`              | Low      |

`gitnexus setup` writes hooks to **user-level** (`~/.codebuddy/settings.json`), so they apply across all projects. To override or add project-specific hooks, create `<workspace>/.codebuddy/settings.json` in your project.

## Project-level setup (optional)

For project-specific configuration, place these files in your project:

```
<your-project>/
└── .codebuddy/
    └── skills/          ← Project-specific skills
```

MCP servers configured at the project level (`.mcp.json` in project root) take precedence over user-level configuration.

## Troubleshooting

- **GitNexus not visible in MCP panel** — Check `~/.codebuddy/.mcp.json` exists and is valid JSONC. Run `npx gitnexus setup` to regenerate.
- **`gitnexus` command not found** — Install globally with `npm i -g gitnexus` so the `command: "gitnexus"` entry resolves from PATH.
- **No tools available** — Run `npx gitnexus analyze` in your project first, then reload CodeBuddy.

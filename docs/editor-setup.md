# Editor setup

[Back to GitNexus](../README.md)

## Automatic setup

`gitnexus setup` auto-detects your editors and writes the correct global MCP config. Run it once. To configure only selected integrations, pass `--coding-agent`/`-c` with a comma-separated list, e.g. `gitnexus setup -c cursor,codex`.

| Editor                   | MCP | Skills | Hooks (auto-augment)                                                                                              | Support      |
| ------------------------ | --- | ------ | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| **Claude Code**          | Yes | Yes    | Yes (PreToolUse + PostToolUse)                                                                                    | **Full**     |
| **Cursor**               | Yes | Yes    | Yes (postToolUse, [manual install](../gitnexus-cursor-integration/README.md#hook-install))                        | **Full**     |
| **Antigravity** (Google) | Yes | Yes    | Yes (AfterTool, [Gemini CLI hooks schema](https://geminicli.com/docs/hooks/reference/))[¹](#fn-antigravity-hooks) | **Full**     |
| **Codex**                | Yes | Yes    | Yes (PreToolUse + PostToolUse, [Codex hooks](https://developers.openai.com/codex/hooks))                          | **Full**     |
| **Factory** (Droid)      | Yes | Yes    | Yes (PostToolUse, [plugin](../gitnexus-factory-plugin/))                                                          | **Full**     |
| **OpenCode**             | Yes | Yes    | Yes (`tool.execute.after`, [plugin](https://opencode.ai/docs/plugins/))                                            | **Full**     |
| **CodeBuddy** (Tencent)  | Yes | Yes    | —                                                                                                                 | MCP + Skills |
| **Qoder** (Alibaba)      | Yes | Yes    | —                                                                                                                 | MCP + Skills |
| **Windsurf**             | Yes | —      | —                                                                                                                 | MCP          |

> **Full** means MCP tools + agent skills + hooks that enrich searches with graph context. **Claude Code** and **Codex** go deepest: their PreToolUse hooks enrich the search before it runs, and their PostToolUse hooks also detect a stale index after commits and prompt the agent to reindex. **Cursor**, **Antigravity**, and **Factory** augment from a post-tool hook only, so they enrich the result rather than the query and do not carry the stale-index hint.

OpenCode's plugin uses the v1 `tool.execute.after` API: it enriches search results and adds a stale-index hint after git mutations. The integration is verified with OpenCode 1.19.5; OpenCode v2 uses a different plugin API.

For Bash tools, the hooks recognize literal commands and known options; ambiguous shell constructs are skipped. Stale-index hints concern the current OpenCode project.

<a id="fn-antigravity-hooks"></a>

> ¹ **Antigravity hooks** follow the [Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/) (Antigravity 2.0 is the documented successor to Gemini CLI). Augmentation runs in `AfterTool` because `BeforeTool` has no context-injection channel in the Gemini contract — the agent sees graph context appended to the tool result via `hookSpecificOutput.additionalContext`. Stale-index hints land in the same channel after a successful `git commit/merge/rebase/cherry-pick/pull`. The schema may evolve if Antigravity-specific hook docs diverge from Gemini CLI's; the implementation will track those changes.

## Manual MCP configuration (if you prefer not to run gitnexus setup)

**Claude Code** (full support — MCP + skills + hooks):

```bash
# macOS / Linux
claude mcp add gitnexus -- npx -y gitnexus@latest mcp

# Windows
claude mcp add gitnexus -- cmd /c npx -y gitnexus@latest mcp
```

**Codex** (full support — MCP + skills + hooks):

```bash
codex mcp add gitnexus -- npx -y gitnexus@latest mcp
```

Or via `~/.codex/config.toml` (system scope) / `.codex/config.toml` (project scope):

```toml
[mcp_servers.gitnexus]
command = "npx"
args = ["-y", "gitnexus@latest", "mcp"]
```

Codex hooks (PreToolUse graph enrichment + PostToolUse stale-index detection in `~/.codex/hooks.json`, [same schema as Claude Code](https://developers.openai.com/codex/hooks)) need the bundled adapter script, so they are installed by `gitnexus setup -c codex` rather than manually.

Alternatively, install everything as a [Codex plugin](https://developers.openai.com/codex/plugins/build) (MCP + skills + hooks in one step):

```bash
codex plugin marketplace add abhigyanpatwari/GitNexus
# then inside Codex: /plugins → install "GitNexus"
```

> **Codex notes:** SessionStart is intentionally not registered — Codex reads [AGENTS.md natively](https://developers.openai.com/codex/guides/agents-md), which already carries the GitNexus context block. Newly installed hooks need a one-time approval in Codex via `/hooks` before they run. Pick **one** install route (`gitnexus setup -c codex` **or** the plugin): plugin hooks load alongside `~/.codex/hooks.json`, so installing both can fire duplicate hooks per tool call.

**Factory** (Droid) — MCP + skills via `gitnexus setup -c droid`, or add the server manually to `~/.factory/mcp.json` ([user scope](https://docs.factory.ai/cli/configuration/mcp), applies to all projects):

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

`gitnexus setup -c droid` also installs skills to `~/.factory/skills/`. For the PostToolUse search-augment hook, install the bundled [`gitnexus-factory-plugin/`](../gitnexus-factory-plugin/) — from a marketplace that includes this repo, run `droid plugin install gitnexus@<marketplace>`, or point Droid at it via `extraKnownMarketplaces` in `.factory/settings.json`. Factory reads [`AGENTS.md` natively](https://docs.factory.ai/), which already carries the GitNexus context block.

**Cursor** (`~/.cursor/mcp.json` — global, works for all projects):

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

**Antigravity** (Google) — `~/.gemini/antigravity/mcp_config.json`:

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

> `gitnexus setup` also merges an `AfterTool` entry into `~/.gemini/settings.json` (under the canonical [Gemini CLI hooks schema](https://geminicli.com/docs/hooks/reference/)) and installs skills to `~/.gemini/antigravity/skills/`. Existing user hooks are preserved. The hook adapter's path is rewritten at install time, so run `gitnexus setup` rather than hand-editing.

**OpenCode** (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "gitnexus": {
      "type": "local",
      "command": ["gitnexus", "mcp"]
    }
  }
}
```

Run `gitnexus setup -c opencode` to also install skills and the auto-loaded plugin at `~/.config/opencode/plugins/gitnexus.js`. Restart OpenCode after setup. The plugin runs GitNexus asynchronously with the interpreter captured during setup, enriches `grep`/`glob`/`bash` searches, and suggests `gitnexus analyze` after a git mutation leaves the index stale. Rerun setup after moving or reinstalling GitNexus. `gitnexus uninstall --force` removes this plugin while preserving sibling plugins.

**CodeBuddy** (Tencent) — priority chain, edit the **first non-empty file that exists**: `~/.codebuddy/.mcp.json` (recommended) → `~/.codebuddy/mcp.json` (deprecated) → `~/.codebuddy.json` (legacy). CodeBuddy reads only the first existing file, so adding servers to a higher-priority file than the one currently in use would hide the servers below it. Create `~/.codebuddy/.mcp.json` only if none exist:

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

**Qoder** (Alibaba) — `~/.qoder.json`:

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

## Install problems? npm 11 crash · slow cold install · no C++ toolchain

> **On npm 11.x?** `npx` can crash during install with `Cannot destructure property 'package' of 'node.target'` (an npm/arborist bug, before GitNexus runs). Use pnpm instead — it builds the native deps explicitly:
>
> ```bash
> pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter dlx gitnexus@latest analyze
> ```
>
> Or install globally (`npm install -g gitnexus@latest`) and run `gitnexus analyze`. See [#1939](https://github.com/abhigyanpatwari/GitNexus/issues/1939).

> **Fastest MCP startup:** install globally (`npm i -g gitnexus`) before running `gitnexus setup` — this writes an absolute-path MCP config that bypasses `npx` entirely. On a cold cache, an `npx`-based MCP install can exceed Claude Code's `MCP_TIMEOUT` default (~30s).

> **No C++ toolchain?** Vendored grammars use committed prebuilds when one matches the platform. Source-build fallback needs `python3`, `make` and `g++`. Set `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` before `npm install -g gitnexus` to skip Dart, Proto, Swift, Kotlin and Zig grammar setup. The C grammar remains required. Only the exact value `1` enables this option; it does not skip other native dependencies.

> **Local embeddings are opt-in.** Default `npm install` does not fetch `@huggingface/transformers` or `onnxruntime-node`. Run `gitnexus embeddings install` (or `gitnexus analyze --embeddings`, which auto-heals) to fetch the stack through your npm registry config into `~/.gitnexus/embedding-runtime`. CUDA GPU binaries still use NuGet via `--cuda` ([#2370](https://github.com/abhigyanpatwari/GitNexus/issues/2370)). The prefix needs Node with `module.registerHooks` (≥ 22.15 on 22.x, ≥ 23.5 on 23.x). A leftover 1.6.12 package-first tree is residual until a clean reinstall; `--force` only refreshes prefix overrides.

> **About `tree-sitter-kotlin`:** like Dart/Proto/Swift, Kotlin is a **vendored** grammar (under `gitnexus/vendor/tree-sitter-kotlin`). Upstream ships **source only** (no prebuilt binaries), so GitNexus cross-builds the platform prebuilds itself (via the `build-tree-sitter-prebuilds` GitHub Actions workflow) and vendors them — the same uniform pipeline used for Dart, Proto, and Swift. `node-gyp-build` selects the right `.node` at require time, so **no C/C++ toolchain is needed**. If no prebuild matches your platform-arch, only Kotlin (`.kt`/`.kts`) parsing is unavailable; the rest of `gitnexus` is unaffected.

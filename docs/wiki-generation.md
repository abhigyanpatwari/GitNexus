# Wiki generation

[Back to GitNexus](../README.md)

Generate LLM-powered documentation from your knowledge graph:

```bash
# Requires an LLM API key (MINIMAX_API_KEY, ANTHROPIC_API_KEY, GITNEXUS_API_KEY or OPENAI_API_KEY)
gitnexus wiki
gitnexus wiki --api-key <key>  # or pass the key on the command line

# Use a custom model or provider (default model: MiniMax-M3)
gitnexus wiki --model gpt-4o
gitnexus wiki --base-url https://api.anthropic.com/v1
gitnexus wiki --provider anthropic  # Anthropic Messages API (default model: claude-opus-5-5)
gitnexus wiki --provider grok   # local Grok Build CLI (uses `grok login`, no API key)
# Providers: minimax, anthropic, openai, openrouter, azure, custom,
# and the local agent CLIs cursor, claude, codex, opencode and grok

# Azure OpenAI with a legacy deployment URL also needs an api-version
gitnexus wiki --provider azure --api-version 2024-10-21 \
  --base-url https://<resource>.openai.azure.com/openai/deployments/<deployment>

# Turn reasoning mode on or off. MiniMax-M3 uses adaptive thinking unless
# --no-reasoning-model is set; o1, o3 and their -mini or -preview models are detected.
gitnexus wiki --reasoning-model
gitnexus wiki --no-reasoning-model

# Force full regeneration
gitnexus wiki --force

# Run more LLM calls in parallel (default: 3)
gitnexus wiki --concurrency 6

# Increase the timeout or retries for large codebases or slow LLM providers
gitnexus wiki --timeout <seconds>  # LLM request timeout in seconds (default: disabled)
gitnexus wiki --retries <n>        # Max LLM retry attempts per request (default: 3)

# Raise the completion-token limit (default: 16384)
gitnexus wiki --max-completion-tokens 131072
GITNEXUS_MAX_COMPLETION_TOKENS=131072 gitnexus wiki
# Or set "maxCompletionTokens": 131072 in ~/.gitnexus/config.json
# Precedence: flag, then the environment variable, then the config file.

# Allow a specific LAN/self-hosted HTTP LLM host (HTTPS is preferred for remote endpoints)
gitnexus wiki --base-url http://llama-box.local:8080/v1 --allow-insecure-connection llama-box.local
# Or set a comma-separated host allowlist:
GITNEXUS_ALLOW_INSECURE_CONNECTION=llama-box.local,192.168.1.23

# Change the output language
gitnexus wiki --lang <lang>  # e.g. english, chinese, spanish, japanese

# Review the module structure before any page is generated
gitnexus wiki --review

# Print the commands and responses of a local agent CLI provider
gitnexus wiki --provider claude --verbose

# Publish the wiki as a public GitHub Gist after generation (needs the GitHub CLI, `gh`)
gitnexus wiki --gist
```

`--provider`, `--model`, `--base-url`, `--api-key`, `--api-version` and `--reasoning-model`
are saved to `~/.gitnexus/config.json`, so later runs reuse them without the flags. The API
key is stored there as plain text. Switching to another `--provider` clears the saved key,
base URL, model, api-version and reasoning setting. `--api-version` is appended to requests
only for Azure: `--provider azure` or an Azure OpenAI base URL.

`--review` stops after modules are grouped. It prints the module tree, saves it as
`module_tree.json` in the wiki output folder, and asks whether to continue. Answer `edit` to
open the file in `$EDITOR` (or `$VISUAL`, else `vi`) and generate pages from the edited tree,
or `n` to stop. In a non-interactive shell, generation continues without asking.

The completion limit must be a positive integer supported by your model. It applies to
OpenAI-compatible HTTP providers; local agent CLI providers manage their own limits.
For reasoning models, the limit includes reasoning tokens as well as the visible answer.
When a provider reports `finish_reason: "length"`, GitNexus rejects the incomplete response
instead of saving it as a finished page. Failed modules are listed, the command exits with
status 1, and a normal rerun retries them even if the repository commit has not changed.
Increase `--max-completion-tokens` within your model's supported limit before retrying.
Truncated grouping or overview responses also fail the run; batched grouping retains its
directory-based fallback. Incomplete runs are not published with `--gist`.
Use `--force` to replace incomplete pages already saved by an older version.

For safety, `http://` LLM base URLs are allowed by default only for loopback hosts (`localhost`, `127.0.0.1`, `::1`). `--allow-insecure-connection` and `GITNEXUS_ALLOW_INSECURE_CONNECTION` accept exact hostnames or IP addresses only; do not include schemes, ports, paths, credentials, or wildcards.

The wiki generator reads the indexed graph structure, groups files into modules via LLM, generates per-module documentation pages, and creates an overview page — all with cross-references to the knowledge graph.

A module whose source does not fit one page (30,000 tokens) is split by directory, below the
directory its files share, so a Gradle or Maven module is split at its packages
(`src — main/entity`). Small neighbouring directories share a page up to the same size, and so
do the files sitting directly in a directory (`top-level files (1 of 2)`), so only a single file
larger than a page is cut. A module of three files or fewer stays on one page. IntelliJ project
files (`.iml`, `.ipr`, `.iws`) and Gradle lockfiles are not indexed, so they get no page.

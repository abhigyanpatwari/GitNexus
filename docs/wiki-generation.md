# Wiki generation

[Back to GitNexus](../README.md)

Generate LLM-powered documentation from your knowledge graph:

```bash
# Requires an LLM API key (OPENAI_API_KEY, etc.)
gitnexus wiki

# Use a custom model or provider (default model: minimax/minimax-m2.5)
gitnexus wiki --model gpt-4o
gitnexus wiki --base-url https://api.anthropic.com/v1
gitnexus wiki --provider grok   # local Grok Build CLI (uses `grok login`, no API key)

# Force full regeneration
gitnexus wiki --force

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
```

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

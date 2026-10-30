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

For safety, `http://` LLM base URLs are allowed by default only for loopback hosts (`localhost`, `127.0.0.1`, `::1`). `--allow-insecure-connection` and `GITNEXUS_ALLOW_INSECURE_CONNECTION` accept exact hostnames or IP addresses only; do not include schemes, ports, paths, credentials, or wildcards.

The wiki generator reads the indexed graph structure, groups files into modules via LLM, generates per-module documentation pages, and creates an overview page — all with cross-references to the knowledge graph.

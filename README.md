# GitNexus

<div align="center">

  <a href="https://trendshift.io/repositories/19809" target="_blank">
    <img src="https://trendshift.io/api/badge/repositories/19809" alt="abhigyanpatwari%2FGitNexus | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/>
  </a>

  <p>
    <a href="https://discord.gg/MgJrmsqr62">
      <img src="https://img.shields.io/discord/1477255801545429032?color=5865F2&logo=discord&logoColor=white" alt="Discord"/>
    </a>
    <a href="https://www.npmjs.com/package/gitnexus">
      <img src="https://img.shields.io/npm/v/gitnexus.svg" alt="npm version"/>
    </a>
    <a href="https://polyformproject.org/licenses/noncommercial/1.0.0/">
      <img src="https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg" alt="License: PolyForm Noncommercial"/>
    </a>
    <a href="https://securityscorecards.dev/viewer/?uri=github.com/abhigyanpatwari/GitNexus">
      <img src="https://api.securityscorecards.dev/projects/github.com/abhigyanpatwari/GitNexus/badge" alt="OpenSSF Scorecard"/>
    </a>
    <a href="https://github.com/abhigyanpatwari/GitNexus/actions/workflows/ci.yml">
      <img src="https://github.com/abhigyanpatwari/GitNexus/actions/workflows/ci.yml/badge.svg" alt="CI Workflows"/>
    </a>
  </p>
</div>

GitNexus indexes a codebase into a knowledge graph of symbols, calls, dependencies
and execution flows. Use it through your coding agent's MCP tools, the CLI, or a
web graph explorer.

[Quick start](#quick-start) · [Documentation](#documentation) ·
[Web UI](https://gitnexus.vercel.app) · [Discord](https://discord.gg/MgJrmsqr62)

https://github.com/user-attachments/assets/172685ba-8e54-4ea7-9ad1-e31a3398da72

## Quick start

Requires **Node.js 22.18+ on 22.x, or 24.11+**. See [platform requirements](gitnexus/README.md#requirements)
for Linux and Windows native dependencies.

```bash
# Run from your repository root
npx gitnexus analyze

# Connect your editors once
npx gitnexus setup
```

`analyze` builds the index, installs agent skills, registers Claude Code hooks,
and writes `AGENTS.md` / `CLAUDE.md` context files. `setup` configures MCP for your
editors. Use `gitnexus analyze --index-only` to index without those repository
integration files.

For repeated use, install globally with `npm install -g gitnexus`.
If installation fails, see [troubleshooting](gitnexus/README.md#troubleshooting).

## What you can do

| Task                                        | Tool             |
| ------------------------------------------- | ---------------- |
| Find code and related execution flows       | `query`          |
| Inspect a symbol's callers and dependencies | `context`        |
| Check what a change could affect            | `impact`         |
| Trace a path between two symbols            | `trace`          |
| Review the impact of a Git diff             | `detect_changes` |
| Preview and apply a semantic rename         | `rename`         |

Ask your agent questions such as “What calls this function?” or “What would this
change affect?” Resolution depends on language support and available evidence;
check reported ambiguity, index freshness and coverage limits.

## Editor setup

`gitnexus setup` detects Claude Code, Cursor, Codex, Antigravity, Factory Droid,
OpenCode, CodeBuddy and Qoder. Windsurf requires manual MCP configuration.
To select editors:

```bash
gitnexus setup -c cursor,codex
```

See [editor setup](docs/editor-setup.md) for the support matrix, manual MCP
configuration, hooks and plugin installation.

## Everyday commands

```bash
gitnexus analyze                 # Refresh the current repository's index
gitnexus analyze --watch         # Reindex as local files change
gitnexus query "authentication"  # Search the graph
gitnexus impact UserService --direction upstream
gitnexus status                  # Check index freshness
gitnexus list                    # List indexed repositories
gitnexus serve                   # Serve indexed repositories to the web UI
```

For multiple concurrent agents, use one `gitnexus mcp --http --port 3111` server
and connect clients to `http://127.0.0.1:3111/mcp`. See the
[shared-server instructions](docs/cli-reference.md#multi-client-setups-use---http-not-stdio).

## Web UI

Run `gitnexus serve`, then open [gitnexus.vercel.app](https://gitnexus.vercel.app).
The UI connects to the backend to browse indexed repositories and use AI chat.
It uses the existing index; no re-upload or re-index is needed.

<img width="1280" alt="GitNexus graph explorer" src="https://github.com/user-attachments/assets/cc5d637d-e0e5-48e6-93ff-5bcfdb929285" />

For Docker, hosted deployments, image verification, or a local frontend, see
[deployment](docs/deployment.md).

## Supported languages

C, C++, C#, COBOL, Dart, Go, Java, JavaScript, Kotlin, Objective-C, Oracle PL/SQL,
PHP, Python, Ruby, Rust, Swift, TypeScript, Vue and Zig have registered providers. Support
varies by construct; see the [language inventories](docs/languages/README.md)
for measured behavior, exclusions and remaining gaps.

## Documentation

<a id="cli-reference"></a>
<a id="environment-variables"></a>
<a id="vector-cutoff-tuning"></a>

| Read                                                                                                                               | For                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [CLI reference](docs/cli-reference.md)                                                                                             | Commands, indexing flags, watch mode, configuration and shared stores |
| [Environment variables](docs/cli-reference.md#environment-variables) · [vector tuning](docs/cli-reference.md#vector-cutoff-tuning) | Runtime settings and search tuning                                    |
| [MCP reference](docs/mcp-reference.md)                                                                                             | All tools, resources, examples, policies and response budgets         |
| [Editor setup](docs/editor-setup.md)                                                                                               | Supported integrations and manual configuration                       |
| [Deployment](docs/deployment.md)                                                                                                   | Docker, Render, image signatures and local frontend setup             |
| [Wiki generation](docs/wiki-generation.md)                                                                                         | Model configuration and generated repository documentation            |
| [Runbook](RUNBOOK.md)                                                                                                              | Index recovery, embeddings and operational troubleshooting            |
| [Architecture](ARCHITECTURE.md) · [type resolution](type-resolution-system.md)                                                     | How the indexer and resolution layers work                            |
| [Type-resolution roadmap](type-resolution-roadmap.md)                                                                              | Planned work and acceptance criteria                                  |

## Security and privacy

The CLI indexes code locally without an LLM. Optional remote embeddings, wiki
generation and AI chat use the providers you configure. The web UI accesses the
backend it connects to. Review [security guidance](SECURITY.md) and
[deployment authentication](docs/deployment.md#deploy-to-render) before exposing
an index to other users.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and pull requests,
[TESTING.md](TESTING.md) for validation, and [GUARDRAILS.md](GUARDRAILS.md) for
repository rules.

## Enterprise

GitNexus is available as an **enterprise offering** — fully managed **SaaS** or **self-hosted** deployment. Commercial use of the OSS version is also available with proper licensing.

Enterprise includes:

- **PR Review** — automated blast radius analysis on pull requests
- **Auto-updating Code Wiki** — always up-to-date documentation (Code Wiki is also available in OSS)
- **Auto-reindexing** — knowledge graph stays fresh automatically
- **Multi-repo support** — unified graph across repositories
- **OCaml support** — additional language coverage
- **Priority feature/language support** — request new languages or features

**Upcoming:** auto regression forensics · end-to-end test generation

👉 Learn more at [akonlabs.com](https://akonlabs.com) — for commercial licensing or enterprise inquiries, ping us on [Discord](https://discord.gg/AAsRVT6fGb) or email founders@akonlabs.com

## Community Integrations

Built by the community — not officially maintained, but worth checking out.

| Project                                                                       | Author                                                 | Description                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [pi-gitnexus](https://github.com/tintinweb/pi-gitnexus)                       | [@tintinweb](https://github.com/tintinweb)             | GitNexus plugin for [pi](https://pi.dev) — `pi install npm:pi-gitnexus` |
| [gitnexus-stable-ops](https://github.com/ShunsukeHayashi/gitnexus-stable-ops) | [@ShunsukeHayashi](https://github.com/ShunsukeHayashi) | Stable ops & deployment workflows (Miyabi ecosystem)                    |
| [KiloCode MCP workflow](Documentation/kilo-code-mcp.md)                       | [@oktanishq](https://github.com/oktanishq)             | Guide to connect GitNexus MCP to Kilo Code and verify tools.            |

> Have a project built on GitNexus? Open a PR to add it here!

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Commercial licensing is available through
[akonlabs.com](https://akonlabs.com).

## Acknowledgments

- [Tree-sitter](https://tree-sitter.github.io/) — AST parsing
- [LadybugDB](https://ladybugdb.com/) — embedded graph database with vector support (formerly KuzuDB)
- [Sigma.js](https://www.sigmajs.org/) — WebGL graph rendering
- [transformers.js](https://huggingface.co/docs/transformers.js) — browser ML
- [Graphology](https://graphology.github.io/) — graph data structures
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol

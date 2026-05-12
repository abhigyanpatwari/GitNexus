# GitNexus Documentation

Welcome to the GitNexus documentation!

## Directory Structure

```
docs/
├── code-indexing/      # Code indexing docs
│   └── cobol/         # COBOL code indexing guide
├── graph-node/        # Graph database structure docs
│   └── overview.md    # Graph data model overview
├── guides/            # Usage guides
│   └── microservices-grpc.md  # Microservice gRPC guide
├── plugins/           # Plugin system docs
│   ├── README.md      # Plugin system overview
│   ├── development-guide.md   # Plugin development guide
│   ├── api-reference.md       # Plugin API reference
│   ├── llm-guide.md          # LLM-assisted development guide
│   ├── quickstart.md         # Quick start
│   ├── troubleshooting.md    # Troubleshooting
│   ├── changelog.md          # Changelog
│   └── examples/            # Plugin examples
│       ├── README.md
│       ├── parser-plugins/   # Parser plugin examples
│       └── analyzer-plugins/ # Analyzer plugin examples
├── superpowers/       # Advanced features
│   └── specs/
│       └── 2026-04-02-pr626-high-fixes-design.md
└── zh/                # Chinese documentation
    └── graph-node/
        └── overview.md
```

## Quick Links

### Getting Started
- [Plugin Quickstart](plugins/quickstart.md) - Create your first plugin in 5 minutes

### Plugin Development
- [Plugin Development Guide](plugins/development-guide.md) - Complete plugin development workflow
- [API Reference](plugins/api-reference.md) - Detailed API documentation
- [LLM Development Guide](plugins/llm-guide.md) - AI-assisted plugin development

### Advanced Topics
- [Graph Data Model](graph-node/overview.md) - How GitNexus builds its code graph
- [COBOL Indexing](code-indexing/cobol/) - Mainframe code indexing
- [Microservice gRPC](guides/microservices-grpc.md) - Cross-repository dependency analysis

## What's New

### v1.0.0 (2026-04-26)

**Plugin System Released!**

GitNexus 1.0.0 introduces a full plugin system including:

- Parser Plugins: Parse specific file types (XML, YAML, SQL, etc.)
- Analyzer Plugins: Analyze code semantics (Spring, React, TypeScript, etc.)
- Processor Plugins: Process data at specific pipeline stages
- Integration Plugins: Integrate external tools and services

See the [Plugin System Docs](plugins/README.md) for details.

## Resources

- [GitHub Repository](https://github.com/gitnexus/gitnexus)
- [Plugin Marketplace](https://github.com/gitnexus/plugins) (coming soon)
- [Discord Community](https://discord.gg/gitnexus)
- [Issue Tracker](https://github.com/gitnexus/gitnexus/issues)

## Language

- English (current)
- [简体中文](zh/README.md)

---

**Maintainer**: GitNexus Team
**Last updated**: 2026-04-26
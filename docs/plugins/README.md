# GitNexus Plugin System

GitNexus Plugin System is an extensible architecture that allows developers to extend GitNexus functionality through plugins. The plugin system is designed to be LLM-friendly, supporting rapid plugin generation and development through large language models.

## Core Features

- **Easy to Develop**: Simple interface definitions minimize development cost
- **Highly Extensible**: Supports multiple plugin types including parser, analyzer, processor, and integration
- **LLM-Friendly**: Provides standard templates and examples, supports rapid plugin generation via LLM
- **Hot Pluggable**: Load and unload plugins at runtime
- **Configuration Management**: Supports global and project-level plugin configuration

## Plugin Types

| Type | Purpose | Interface |
|------|---------|-----------|
| **Parser Plugin** | Parse specific file types | `ParserPlugin` |
| **Analyzer Plugin** | Analyze code semantics | `AnalyzerPlugin` |
| **Processor Plugin** | Handle language-specific features | `ProcessorPlugin` |
| **Integration Plugin** | Integrate external tools | `IntegrationPlugin` |

## Available Plugins

| Plugin | Directory | Description |
|--------|-----------|-------------|
| JPA Plugin | `gitnexus-plugins/jpa-plugin/` | Parses JPA entities, repositories, and field annotations, generating `JpaEntity`, `JpaRepository`, `JpaField` nodes |
| Kafka Plugin | `gitnexus-plugins/kafka-plugin/` | Parses Kafka consumer/producer code and configuration, generating `KafkaConfig`, `KafkaTopics`, `KafkaConsumer`, `KafkaProducer` nodes |
| MyBatis Plugin | `gitnexus-plugins/mybatis-plugin/` | Parses MyBatis Mapper interfaces and XML mapping files, generating `MyBatisMapper`, `MyBatisSql`, `MyBatisMethod` nodes |
| Spring Boot Plugin | `gitnexus-plugins/spring-boot-plugin/` | Parses Spring Boot components, Beans, DI, AOP, transactions, etc., generating `Bean`, `ConfigProperty`, `KafkaTopic` and other nodes |
| Markdown Plugin | `gitnexus-plugins/markdown-plugin/` | Parses Markdown documents with Profile customization (generic, api-docs, adr), generating `MarkdownDoc`, `MarkdownHeading`, `CodeBlock`, `Link`, `Image`, `Todo`, `Table` nodes |

## Quick Start

### Scan and Load Plugins

```bash
cd gitnexus
gitnexus plugin scan ../gitnexus-plugins/
```

### List Installed Plugins

```bash
gitnexus plugin list
```

### Analyze a Project (Plugins Apply Automatically)

```bash
gitnexus analyze /path/to/repo
```

## Example Plugins

### JPA Plugin
Path: `gitnexus-plugins/jpa-plugin/`

Parses JPA entity classes, Repository interfaces, and field annotations.
- Node types: `JpaEntity`, `JpaRepository`, `JpaField`
- Supports: `@Entity`, `@Table`, `@Id`, `@Column`, `@OneToMany`, etc.

### Kafka Plugin
Path: `gitnexus-plugins/kafka-plugin/`

Parses Kafka configuration, consumer/producer code.
- Node types: `KafkaConfig`, `KafkaTopics`, `KafkaConsumer`, `KafkaProducer`
- Supports: `@KafkaListener`, `KafkaTemplate`, etc.

### MyBatis Plugin
Path: `gitnexus-plugins/mybatis-plugin/`

Parses MyBatis Mapper interfaces and XML mapping files.
- Node types: `MyBatisMapper`, `MyBatisXmlMapper`, `MyBatisSql`, `MyBatisMethod`
- Supports: `@Select`, `@Insert`, `@Update`, `<select>`, `<insert>`, etc.

### Spring Boot Plugin
Path: `gitnexus-plugins/spring-boot-plugin/`

Parses Spring Boot components, Beans, DI, AOP, transactions, caching, etc.
- Node types: `Bean`, `ConfigProperty`, `KafkaTopic`, `KafkaConsumer`, `KafkaProducer`
- Supports: `@Component`, `@Service`, `@Transactional`, `@Cacheable`, etc.

### Markdown Plugin
Path: `gitnexus-plugins/markdown-plugin/`

Parses Markdown documents with Profile customization.
- Node types: `MarkdownDoc`, `MarkdownHeading`, `CodeBlock`, `Link`, `Image`, `Todo`, `Table`
- Built-in Profiles: `generic` (general), `api-docs` (API documentation), `adr` (Architecture Decision Records)
- Supports custom Profiles (see `gitnexus-plugins/README.md`)

## CLI Commands

| Command | Description |
|---------|-------------|
| `gitnexus plugin list` | List all installed plugins |
| `gitnexus plugin load <path>` | Load a plugin |
| `gitnexus plugin unload <name>` | Unload a plugin |
| `gitnexus plugin enable <name>` | Enable a plugin |
| `gitnexus plugin disable <name>` | Disable a plugin |
| `gitnexus plugin status` | Show plugin system status |
| `gitnexus plugin scan [dir]` | Scan plugin directory and auto-load |

## Related Documentation

- [Development Guide](development-guide.md) - Detailed plugin development workflow
- [API Reference](api-reference.md) - Complete plugin API documentation
- [LLM Development Guide](llm-guide.md) - Using LLMs to assist plugin development
- [Quick Start](quickstart.md) - Create your first plugin in 5 minutes
- [Troubleshooting](troubleshooting.md) - Common issues and solutions

## Contact

- **GitHub Issues**: https://github.com/abhigyanpatwari/GitNexus/issues
- **Discord**: https://discord.gg/gitnexus
- **Email**: support@gitnexus.io

---

**Version**: 1.1.0
**Last Updated**: 2026-05-07
**Maintainer**: GitNexus Team

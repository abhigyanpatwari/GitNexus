# Plugin Examples

This directory contains example plugins for the GitNexus plugin system, demonstrating how to develop various types of plugins.

## Available Example Plugins

| Plugin Name | Type | Description | Directory |
|-------------|------|-------------|-----------|
| **Spring Boot Plugin** | Parser + Analyzer | Parses Spring Boot application configuration and components | [spring-boot-plugin](./spring-boot-plugin/) |
| **MyBatis Plugin** | Parser + Analyzer | Parses MyBatis framework Mapper interfaces and XML mapping files | [mybatis-plugin](./mybatis-plugin/) |
| **JPA Plugin** | Analyzer | Parses JPA framework entity classes and repository interfaces | [jpa-plugin](./jpa-plugin/) |
| **Kafka Plugin** | Parser + Analyzer | Parses Kafka-related code and configuration | [kafka-plugin](./kafka-plugin/) |
| **XML Parser Plugin** | Parser | Parses XML files | [parser-plugins/xml-parser](./parser-plugins/xml-parser/) |
| **Spring Analyzer Plugin** | Analyzer | Analyzes Spring framework code | [analyzer-plugins/spring-analyzer](./analyzer-plugins/spring-analyzer/) |

## How to Use Example Plugins

### 1. Build the Plugin

```bash
# Navigate to the plugin directory
cd examples/spring-boot-plugin

# Install dependencies
npm install

# Build the plugin
npm run build

# Install the plugin
npm install -g .
```

### 2. Enable the Plugin

```bash
npx gitnexus plugin enable gitnexus-spring-boot-plugin
```

### 3. Analyze a Project

```bash
npx gitnexus analyze
```

## Plugin Development Guide

- [Development Guide](../development-guide.md) - Complete plugin development workflow
- [API Reference](../api-reference.md) - Detailed API documentation
- [LLM Development Guide](../llm-guide.md) - Using LLMs for plugin development
- [Quick Start](../quickstart.md) - Get started in 5 minutes

## Plugin Types

### Parser Plugin (ParserPlugin)
- Responsible for parsing specific file types
- Supported file types specified via the `extensions` property
- Implements `parse` method to process file content

### Analyzer Plugin (AnalyzerPlugin)
- Responsible for analyzing code semantics
- Supported languages specified via the `languages` property
- Implements `analyze` method to analyze code nodes

### Processor Plugin (ProcessorPlugin)
- Responsible for processing data at specific stages
- Defines processing phase and priority
- Implements `process` method to handle data

### Integration Plugin (IntegrationPlugin)
- Responsible for integrating external tools and services
- Implements `execute` method to perform integration operations

## Example Plugin Feature Descriptions

### Spring Boot Plugin
- Parses Spring Boot configuration files (YAML, properties)
- Analyzes Spring Boot components (Controller, Service, Repository, etc.)
- Extracts Spring Boot annotations and configuration

### MyBatis Plugin
- Parses MyBatis XML mapping files
- Analyzes MyBatis Mapper interfaces
- Extracts SQL statements and methods

### JPA Plugin
- Analyzes JPA entity classes
- Identifies JPA repository interfaces
- Extracts entity relationships and field annotations

### Kafka Plugin
- Parses Kafka configuration files
- Analyzes Kafka consumers and producers
- Identifies Kafka annotations and topic configuration

### XML Parser Plugin
- Parses XML file structure
- Extracts elements, attributes, and text content
- Generates XML document nodes and edges

### Spring Analyzer Plugin
- Analyzes Spring framework code
- Identifies Spring components and dependency injection
- Extracts Spring configuration and annotations

## Best Practices

1. **Naming Convention**: Use `gitnexus-[feature]-plugin` naming format
2. **Modularity**: Split complex functionality into multiple plugins
3. **Error Handling**: Implement robust error handling mechanisms
4. **Performance**: Consider performance for large files and projects
5. **Testing**: Write unit tests and integration tests
6. **Documentation**: Provide detailed documentation and examples

## Contributing

If you have new plugin examples or improvement suggestions, feel free to submit a pull request.

## Contact

- **GitHub Issues**: https://github.com/gitnexus/gitnexus/issues
- **Discord**: https://discord.gg/gitnexus
- **Email**: support@gitnexus.io

---

**Version**: 1.0.0
**Last Updated**: 2026-04-26
**Maintainer**: GitNexus Team

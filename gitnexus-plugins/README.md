# GitNexus Plugins

This directory contains custom plugins for GitNexus.

## Directory Structure

```
gitnexus-plugins/
├── README.md          # This file
├── jpa-plugin/         # JPA (Java Persistence API) plugin
├── kafka-plugin/      # Kafka plugin
├── mybatis-plugin/    # MyBatis plugin
├── spring-boot-plugin/ # Spring Boot plugin
├── markdown-plugin/   # Markdown plugin (with Profile system)
└── yaml-parser/       # YAML/YML configuration file parser plugin
```

## Available Plugins

| Plugin | Description | Node Labels |
|---------|-------------|-------------|
| `jpa-plugin` | Parses JPA entities, repositories, and field annotations | `JpaEntity`, `JpaRepository`, `JpaField` |
| `kafka-plugin` | Parses Kafka consumers, producers, and config | `KafkaConfig`, `KafkaTopics`, `KafkaConsumer`, `KafkaProducer` |
| `mybatis-plugin` | Parses MyBatis mappers, XML mappings, and SQL statements | `MyBatisMapper`, `MyBatisXmlMapper`, `MyBatisSql`, `MyBatisMethod` |
| `spring-boot-plugin` | Parses Spring Boot components, beans, DI, AOP, transactions, etc. | `Bean`, `ConfigProperty`, `KafkaTopic`, `KafkaConsumer`, `KafkaProducer` |
| `markdown-plugin` | Parses Markdown documents with Profile-based customization | `MarkdownDoc`, `MarkdownHeading`, `CodeBlock`, `Link`, `Image`, `Todo`, `Table` |
| `yaml-parser` | Parses YAML/YML configuration files, extracts keys, values, and hierarchy | `YamlConfig`, `YamlSection`, `YamlProperty`, `YamlArrayItem` |

## How to Use

### 1. Scan and load plugins

```bash
cd gitnexus
gitnexus plugin scan ../gitnexus-plugins/
```

### 2. List installed plugins

```bash
gitnexus plugin list
```

### 3. Index your repository (plugins will be used automatically)

```bash
gitnexus analyze /path/to/your/repo
```

### 4. Query with plugin-extended node types

```bash
gitnexus query "jpa entity"
gitnexus query "kafka consumer"
gitnexus context --name "MyController"
```

## Customizing Markdown Plugin

The `markdown-plugin` supports custom **Profiles** for different document types.

### Built-in Profiles
- `generic` — Default for all Markdown files
- `api-docs` — Detects API documentation (Swagger, OpenAPI, etc.)
- `adr` — Architecture Decision Records

### Adding Custom Profile

1. Create a new file `my-custom-profile.ts`:

```typescript
import { MarkdownProfile, SectionParser, createNode, GraphNode } from 'gitnexus-shared';

class MySectionParser implements SectionParser {
  name = 'my-section';
  parse(lines, index, filePath, context) {
    // Your parsing logic here
    return { nodes: [...], edges: [...], nextIndex: index + 1 };
  }
}

export const myDocProfile: MarkdownProfile = {
  name: 'my-doc',
  detect: (content) => content.includes('## My Special Section'),
  parsers: [new MySectionParser()],
  priority: 20  // Higher = matched first
};
```

2. Load the plugin with your custom profile:

```bash
gitnexus plugin load ../gitnexus-plugins/markdown-plugin \
  --config '{"customProfiles":["./my-custom-profile.js"]}'
```

## Plugin Development

Each plugin has the following structure:

```
plugin-name/
├── package.json      # npm config with "gitnexus": { "plugin": true }
├── tsconfig.json    # TypeScript config
└── src/
    └── index.ts    # Plugin implementation
```

### Building a Plugin

```bash
cd gitnexus-plugins/plugin-name
npm install
npm run build
```

### TypeScript Types

Plugins use types from `gitnexus-shared`:

```typescript
import {
  ParserPlugin, AnalyzerPlugin,
  ParseResult, AnalysisResultItem,
  createNode, createEdge,
  GraphNode, GraphRelationship
} from 'gitnexus-shared';
```

## Updating Plugins

When `gitnexus-shared` is updated, rebuild plugins:

```bash
cd gitnexus-shared && npm run build
cd ../gitnexus-plugins
for dir in */; do
  cd $dir && npm install && npm run build && cd ..
done
```

## License

Same as GitNexus (PolyForm Noncommercial 1.0.0).

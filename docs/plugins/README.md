# GitNexus 插件系统

GitNexus 插件系统是一个可扩展的架构，允许开发者通过插件扩展 GitNexus 的功能。插件系统设计为 LLM 友好，支持通过大语言模型快速生成和开发插件。

## 核心特性

- **易于开发**：简单的接口定义，最小化开发成本
- **高度可扩展**：支持解析器、分析器、处理器等多种插件类型
- **LLM 友好**：提供标准模板和示例，支持通过 LLM 快速生成插件
- **热插拔**：运行时加载和卸载插件
- **配置管理**：支持全局和项目级插件配置

## 插件类型

| 插件类型 | 作用 | 接口 |
|---------|------|------|
| **解析器插件** | 解析特定文件类型 | `ParserPlugin` |
| **分析器插件** | 分析代码语义 | `AnalyzerPlugin` |
| **处理器插件** | 处理特定语言特性 | `ProcessorPlugin` |
| **集成插件** | 集成外部工具 | `IntegrationPlugin` |

## 可用插件

| 插件 | 目录 | 描述 |
|-------|------|---------|
| JPA Plugin | `gitnexus-plugins/jpa-plugin/` | 解析 JPA 实体、仓库、字段注解，生成 `JpaEntity`、`JpaRepository`、`JpaField` 节点 |
| Kafka Plugin | `gitnexus-plugins/kafka-plugin/` | 解析 Kafka 消费者/生产者代码和配置，生成 `KafkaConfig`、`KafkaTopics`、`KafkaConsumer`、`KafkaProducer` 节点 |
| MyBatis Plugin | `gitnexus-plugins/mybatis-plugin/` | 解析 MyBatis Mapper 接口和 XML 映射文件，生成 `MyBatisMapper`、`MyBatisSql`、`MyBatisMethod` 节点 |
| Spring Boot Plugin | `gitnexus-plugins/spring-boot-plugin/` | 解析 Spring Boot 组件、Bean、DI、AOP、事务等，生成 `Bean`、`ConfigProperty`、`KafkaTopic` 等节点 |
| Markdown Plugin | `gitnexus-plugins/markdown-plugin/` | 解析 Markdown 文档，支持 Profile 定制（generic、api-docs、adr），生成 `MarkdownDoc`、`MarkdownHeading`、`CodeBlock`、`Link`、`Image`、`Todo`、`Table` 节点 |

## 快速开始

### 扫描和加载插件

```bash
cd gitnexus
gitnexus plugin scan ../gitnexus-plugins/
```

### 列出已加载插件

```bash
gitnexus plugin list
```

### 分析项目（插件自动生效）

```bash
gitnexus analyze /path/to/repo
```

## 示例插件

### JPA 插件
路径：`gitnexus-plugins/jpa-plugin/`

解析 JPA 实体类、Repository 接口、字段注解。
- 节点类型：`JpaEntity`、`JpaRepository`、`JpaField`
- 支持：`@Entity`、`@Table`、`@Id`、`@Column`、`@OneToMany` 等

### Kafka 插件
路径：`gitnexus-plugins/kafka-plugin/`

解析 Kafka 配置、消费者/生产者代码。
- 节点类型：`KafkaConfig`、`KafkaTopics`、`KafkaConsumer`、`KafkaProducer`
- 支持：`@KafkaListener`、`KafkaTemplate` 等

### MyBatis 插件
路径：`gitnexus-plugins/mybatis-plugin/`

解析 MyBatis Mapper 接口和 XML 映射文件。
- 节点类型：`MyBatisMapper`、`MyBatisXmlMapper`、`MyBatisSql`、`MyBatisMethod`
- 支持：`@Select`、`@Insert`、`@Update`、`<select>`、`<insert>` 等

### Spring Boot 插件
路径：`gitnexus-plugins/spring-boot-plugin/`

解析 Spring Boot 组件、Bean、DI、AOP、事务、缓存等。
- 节点类型：`Bean`、`ConfigProperty`、`KafkaTopic`、`KafkaConsumer`、`KafkaProducer`
- 支持：`@Component`、`@Service`、`@Transactional`、`@Cacheable` 等

### Markdown 插件
路径：`gitnexus-plugins/markdown-plugin/`

解析 Markdown 文档，支持 Profile 定制。
- 节点类型：`MarkdownDoc`、`MarkdownHeading`、`CodeBlock`、`Link`、`Image`、`Todo`、`Table`
- 内置 Profile：`generic`（通用）、`api-docs`（API 文档）、`adr`（架构决策记录）
- 支持自定义 Profile（见 `gitnexus-plugins/README.md`）

## CLI 命令

| 命令 | 描述 |
|------|------|
| `gitnexus plugin list` | 列出所有已安装的插件 |
| `gitnexus plugin load <path>` | 加载插件 |
| `gitnexus plugin unload <name>` | 卸载插件 |
| `gitnexus plugin enable <name>` | 启用插件 |
| `gitnexus plugin disable <name>` | 禁用插件 |
| `gitnexus plugin status` | 显示插件系统状态 |
| `gitnexus plugin scan [dir]` | 扫描插件目录并自动加载 |

## 相关文档

- [开发指南](development-guide.md) - 详细的插件开发流程
- [API 参考](api-reference.md) - 完整的插件 API 文档
- [LLM 开发指南](llm-guide.md) - 如何使用 LLM 辅助开发插件
- [快速开始](quickstart.md) - 5分钟创建第一个插件
- [故障排除](troubleshooting.md) - 常见问题解决

## 联系方式

- **GitHub Issues**：https://github.com/abhigyanpatwari/GitNexus/issues
- **Discord**：https://discord.gg/gitnexus
- **Email**：support@gitnexus.io

---

**版本**：1.1.0
**最后更新**：2026-05-07
**维护者**：GitNexus 团队
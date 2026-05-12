# 插件示例

本目录包含 GitNexus 插件系统的示例插件，展示如何开发各种类型的插件。

## 可用示例插件

| 插件名称 | 类型 | 功能描述 | 目录 |
|---------|------|----------|------|
| **Spring Boot 插件** | 解析器 + 分析器 | 解析 Spring Boot 应用的配置和组件 | [spring-boot-plugin](./spring-boot-plugin/) |
| **MyBatis 插件** | 解析器 + 分析器 | 解析 MyBatis 框架的 Mapper 接口和 XML 映射文件 | [mybatis-plugin](./mybatis-plugin/) |
| **JPA 插件** | 分析器 | 解析 JPA 框架的实体类和仓库接口 | [jpa-plugin](./jpa-plugin/) |
| **Kafka 插件** | 解析器 + 分析器 | 解析 Kafka 相关的代码和配置 | [kafka-plugin](./kafka-plugin/) |
| **XML 解析插件** | 解析器 | 解析 XML 文件 | [parser-plugins/xml-parser](./parser-plugins/xml-parser/) |
| **Spring 分析器插件** | 分析器 | 分析 Spring 框架代码 | [analyzer-plugins/spring-analyzer](./analyzer-plugins/spring-analyzer/) |

## 如何使用示例插件

### 1. 构建插件

```bash
# 进入插件目录
cd examples/spring-boot-plugin

# 安装依赖
npm install

# 构建插件
npm run build

# 安装插件
npm install -g .
```

### 2. 启用插件

```bash
npx gitnexus plugin enable gitnexus-spring-boot-plugin
```

### 3. 分析项目

```bash
npx gitnexus analyze
```

## 插件开发指南

- [开发指南](../development-guide.md) - 完整的插件开发流程
- [API 参考](../api-reference.md) - 详细的 API 文档
- [LLM 开发指南](../llm-guide.md) - 使用 LLM 辅助开发
- [快速开始](../quickstart.md) - 5 分钟快速上手

## 插件类型

### 解析器插件 (ParserPlugin)
- 负责解析特定文件类型
- 支持的文件类型通过 `extensions` 属性指定
- 实现 `parse` 方法处理文件内容

### 分析器插件 (AnalyzerPlugin)
- 负责分析代码语义
- 支持的语言通过 `languages` 属性指定
- 实现 `analyze` 方法分析代码节点

### 处理器插件 (ProcessorPlugin)
- 负责处理特定阶段的数据
- 定义处理阶段和优先级
- 实现 `process` 方法处理数据

### 集成插件 (IntegrationPlugin)
- 负责集成外部工具和服务
- 实现 `execute` 方法执行集成操作

## 示例插件功能说明

### Spring Boot 插件
- 解析 Spring Boot 配置文件（YAML、properties）
- 分析 Spring Boot 组件（Controller、Service、Repository 等）
- 提取 Spring Boot 注解和配置

### MyBatis 插件
- 解析 MyBatis XML 映射文件
- 分析 MyBatis Mapper 接口
- 提取 SQL 语句和方法

### JPA 插件
- 分析 JPA 实体类
- 识别 JPA 仓库接口
- 提取实体关系和字段注解

### Kafka 插件
- 解析 Kafka 配置文件
- 分析 Kafka 消费者和生产者
- 识别 Kafka 注解和主题配置

### XML 解析插件
- 解析 XML 文件结构
- 提取元素、属性和文本内容
- 生成 XML 文档的节点和边

### Spring 分析器插件
- 分析 Spring 框架代码
- 识别 Spring 组件和依赖注入
- 提取 Spring 配置和注解

## 最佳实践

1. **命名规范**：使用 `gitnexus-[功能]-plugin` 的命名格式
2. **模块化**：将复杂功能拆分为多个插件
3. **错误处理**：实现健壮的错误处理机制
4. **性能优化**：考虑大文件和大型项目的性能
5. **测试**：编写单元测试和集成测试
6. **文档**：提供详细的文档和示例

## 贡献

如果您有新的插件示例或改进建议，欢迎提交 pull request。

## 联系方式

- **GitHub Issues**：https://github.com/gitnexus/gitnexus/issues
- **Discord**：https://discord.gg/gitnexus
- **Email**：support@gitnexus.io

---

**版本**：1.0.0
**最后更新**：2026-04-26
**维护者**：GitNexus 团队
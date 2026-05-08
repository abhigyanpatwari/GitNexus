# Kafka 插件示例

## 功能描述

这个插件用于解析 Kafka 相关的代码，提取消费者、生产者、主题配置等组件，并生成相应的节点和边关系。

## 目录结构

```
kafka-plugin/
├── src/
│   └── index.ts          # 插件主文件
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
└── README.md             # 插件文档
```

## 代码实现

### src/index.ts

```typescript
import { ParserPlugin, AnalyzerPlugin, ParseResult, AnalysisResult, ParserRegistry, AnalyzerRegistry, AnalysisContext, createNode, createEdge } from 'gitnexus-shared';

/**
 * Kafka 插件
 * 解析 Kafka 相关的代码和配置
 */
export class KafkaPlugin implements ParserPlugin, AnalyzerPlugin {
  name = 'gitnexus-kafka-plugin';
  version = '1.0.0';
  description = 'Kafka plugin for GitNexus';
  extensions = ['.yml', '.yaml', '.properties', '.java'];
  languages = ['java'];
  
  /**
   * 解析文件内容
   */
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes = [];
    const edges = [];
    
    try {
      if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
        await this.parseYamlConfig(content, filePath, nodes, edges);
      } else if (filePath.endsWith('.properties')) {
        await this.parsePropertiesConfig(content, filePath, nodes, edges);
      } else if (filePath.endsWith('.java')) {
        // Java 文件由分析器处理
      }
      
      return {
        nodes,
        edges,
        metadata: {
          format: this.getFileFormat(filePath),
          filePath
        }
      };
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        metadata: {},
        error: (error as Error).message
      };
    }
  }
  
  /**
   * 分析代码语义
   */
  async analyze(node: any, context: AnalysisContext): Promise<AnalysisResult> {
    const results = [];
    
    // 分析 Kafka 消费者
    if (node.type === 'class_declaration') {
      const className = node.name?.text;
      const implements = node.implements || [];
      
      // 检查是否实现了 Kafka 消费者接口
      if (this.isKafkaConsumer(implements)) {
        results.push({
          type: 'kafka.consumer',
          name: className,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine
          },
          properties: this.extractConsumerProperties(node)
        });
      }
    }
    
    // 分析 Kafka 注解
    if (node.type === 'annotation') {
      const annotationName = node.name?.text;
      if (this.isKafkaAnnotation(annotationName)) {
        results.push({
          type: 'kafka.annotation',
          name: annotationName,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine
          },
          properties: this.extractAnnotationProperties(node)
        });
      }
    }
    
    // 分析 Kafka 生产者
    if (node.type === 'method_declaration') {
      const methodName = node.name?.text;
      const body = node.body?.text || '';
      
      // 检查是否包含 Kafka 生产者代码
      if (this.containsKafkaProducerCode(body)) {
        results.push({
          type: 'kafka.producer',
          name: methodName,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine
          },
          properties: this.extractProducerProperties(node)
        });
      }
    }
    
    return {
      results,
      metadata: {
        analyzer: this.name,
        language: context.language
      }
    };
  }
  
  /**
   * 解析 YAML 配置文件
   */
  private async parseYamlConfig(content: string, filePath: string, nodes: any[], edges: any[]): Promise<void> {
    // 简单的 YAML 解析
    // 实际项目中可以使用 yaml 库进行更复杂的解析
    
    // 提取 Kafka 配置
    if (content.includes('spring.kafka')) {
      const kafkaNode = createNode('KafkaConfig', {
        name: 'kafka',
        filePath
      });
      nodes.push(kafkaNode);
      
      // 提取主题配置
      if (content.includes('topics')) {
        const topicsNode = createNode('KafkaTopics', {
          name: 'topics',
          filePath
        });
        nodes.push(topicsNode);
        
        edges.push(createEdge('HAS_CONFIG', kafkaNode.id, topicsNode.id, {
          confidence: 1.0,
          reason: 'Kafka topics config'
        }));
      }
    }
  }
  
  /**
   * 解析 properties 配置文件
   */
  private async parsePropertiesConfig(content: string, filePath: string, nodes: any[], edges: any[]): Promise<void> {
    const lines = content.split('\n');
    const kafkaConfig = {};
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex > 0) {
        const key = trimmed.substring(0, equalsIndex).trim();
        const value = trimmed.substring(equalsIndex + 1).trim();
        
        if (key.startsWith('spring.kafka')) {
          kafkaConfig[key] = value;
        }
      }
    }
    
    // 创建 Kafka 配置节点
    if (Object.keys(kafkaConfig).length > 0) {
      const kafkaNode = createNode('KafkaConfig', {
        name: 'kafka',
        filePath
      });
      nodes.push(kafkaNode);
    }
  }
  
  /**
   * 检查是否为 Kafka 消费者
   */
  private isKafkaConsumer(implements: any[]): boolean {
    for (const impl of implements) {
      const implName = impl.text;
      if (implName.includes('Consumer') && (implName.includes('Kafka') || implName.includes('Message'))) {
        return true;
      }
    }
    return false;
  }
  
  /**
   * 检查是否为 Kafka 注解
   */
  private isKafkaAnnotation(annotationName: string): boolean {
    const kafkaAnnotations = [
      'KafkaListener',
      'KafkaHandler',
      'TopicPartition',
      'PartitionOffset',
      'Header',
      'SendTo'
    ];
    return kafkaAnnotations.includes(annotationName);
  }
  
  /**
   * 检查是否包含 Kafka 生产者代码
   */
  private containsKafkaProducerCode(body: string): boolean {
    const producerKeywords = [
      'KafkaTemplate',
      'producer',
      'send(',
      'kafkaTemplate'
    ];
    return producerKeywords.some(keyword => body.includes(keyword));
  }
  
  /**
   * 提取消费者属性
   */
  private extractConsumerProperties(node: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    if (node.implements) {
      properties.implements = node.implements.map((i: any) => i.text);
    }
    
    if (node.extends) {
      properties.extends = node.extends.text;
    }
    
    return properties;
  }
  
  /**
   * 提取注解属性
   */
  private extractAnnotationProperties(annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    if (annotation.arguments) {
      properties.arguments = this.extractArguments(annotation.arguments);
    }
    
    return properties;
  }
  
  /**
   * 提取生产者属性
   */
  private extractProducerProperties(node: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    if (node.returnType) {
      properties.returnType = node.returnType.text;
    }
    
    if (node.parameters) {
      properties.parameters = node.parameters.map((p: any) => ({
        name: p.name?.text,
        type: p.type?.text
      }));
    }
    
    return properties;
  }
  
  /**
   * 提取参数
   */
  private extractArguments(argumentsNode: any): Record<string, any> {
    const args: Record<string, any> = {};
    
    if (argumentsNode.type === 'annotation_argument_list') {
      for (const arg of argumentsNode.arguments) {
        if (arg.type === 'assignment_expression') {
          const name = arg.left.text;
          const value = this.extractArgumentValue(arg.right);
          args[name] = value;
        } else {
          args.value = this.extractArgumentValue(arg);
        }
      }
    }
    
    return args;
  }
  
  /**
   * 提取参数值
   */
  private extractArgumentValue(valueNode: any): any {
    if (valueNode.type === 'string_literal') {
      return valueNode.value;
    } else if (valueNode.type === 'number_literal') {
      return Number(valueNode.value);
    } else if (valueNode.type === 'boolean_literal') {
      return valueNode.value === 'true';
    } else if (valueNode.type === 'array_expression') {
      return valueNode.elements.map((e: any) => this.extractArgumentValue(e));
    } else if (valueNode.type === 'object_expression') {
      const obj: Record<string, any> = {};
      for (const prop of valueNode.properties) {
        const name = prop.key.text;
        const value = this.extractArgumentValue(prop.value);
        obj[name] = value;
      }
      return obj;
    } else {
      return valueNode.text || valueNode.value;
    }
  }
  
  /**
   * 获取文件格式
   */
  private getFileFormat(filePath: string): string {
    if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
      return 'yaml';
    } else if (filePath.endsWith('.properties')) {
      return 'properties';
    } else if (filePath.endsWith('.java')) {
      return 'java';
    }
    return 'unknown';
  }
  
  /**
   * 注册到解析器注册表
   */
  register(registry: ParserRegistry | AnalyzerRegistry): void {
    if ('registerParser' in registry) {
      registry.registerParser(this);
    } else if ('registerAnalyzer' in registry) {
      registry.registerAnalyzer(this);
    }
  }
  
  /**
   * 检查文件是否支持
   */
  supports(filePath: string): boolean {
    return this.extensions.some(ext => filePath.endsWith(ext));
  }
  
  /**
   * 检查语言是否支持
   */
  supportsLanguage(language: string): boolean {
    return this.languages.includes(language);
  }
  
  /**
   * 初始化插件
   */
  async init(config: any): Promise<void> {
    console.log(`Initialized ${this.name} with config:`, config);
  }
  
  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    console.log(`Disposed ${this.name}`);
  }
}

// 导出插件实例
export default new KafkaPlugin();
```

### package.json

```json
{
  "name": "gitnexus-kafka-plugin",
  "version": "1.0.0",
  "description": "Kafka plugin for GitNexus",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "jest"
  },
  "keywords": [
    "gitnexus",
    "plugin",
    "kafka",
    "java"
  ],
  "author": "GitNexus Team",
  "license": "MIT",
  "dependencies": {
    "gitnexus-shared": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0"
  },
  "gitnexus": {
    "plugin": true,
    "type": "parser"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "declaration": true,
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "node_modules",
    "dist"
  ]
}
```

### README.md

```markdown
# GitNexus Kafka Plugin

Kafka plugin for GitNexus. Parses Kafka-related code and configurations, extracts consumers, producers, and topics.

## Features

- Parses Kafka configuration files (YAML, properties)
- Analyzes Kafka consumer implementations
- Identifies Kafka annotations
- Detects Kafka producer code
- Generates nodes and edges for Kafka components
- Supports Spring Kafka

## Installation

### Local Installation

```bash
# Clone the repository
git clone https://github.com/gitnexus/gitnexus-plugins.git
cd gitnexus-plugins/examples/kafka-plugin

# Install dependencies
npm install

# Build the plugin
npm run build

# Install globally
npm install -g .
```

### NPM Installation

```bash
npm install -g gitnexus-kafka-plugin
```

## Usage

### Enable the Plugin

```bash
npx gitnexus plugin enable gitnexus-kafka-plugin
```

### Analyze a Kafka Project

```bash
# Analyze a Kafka project
npx gitnexus analyze
```

### View Plugin Status

```bash
npx gitnexus plugin list
```

## Configuration

### Global Configuration

Add the following to `~/.gitnexus/plugins.json`:

```json
{
  "plugins": [
    {
      "name": "gitnexus-kafka-plugin",
      "enabled": true,
      "config": {
        "scanConsumers": true,
        "scanProducers": true,
        "scanConfigurations": true,
        "includeTestFiles": false
      }
    }
  ]
}
```

### Project Configuration

Add the following to `.gitnexus/plugins.json` in your project:

```json
{
  "plugins": [
    {
      "name": "gitnexus-kafka-plugin",
      "enabled": true,
      "config": {
        "scanConsumers": true,
        "scanProducers": true,
        "scanConfigurations": true,
        "includeTestFiles": true
      }
    }
  ]
}
```

## Examples

### Sample Kafka Consumer

```java
@Service
public class KafkaConsumerService implements ConsumerSeekAware {
    @KafkaListener(topics = "orders", groupId = "order-group")
    public void consumeOrder(Order order) {
        System.out.println("Received order: " + order);
    }
    
    @KafkaListener(topics = "payments", groupId = "payment-group")
    public void consumePayment(Payment payment) {
        System.out.println("Received payment: " + payment);
    }
}
```

### Sample Kafka Producer

```java
@Service
public class KafkaProducerService {
    private final KafkaTemplate<String, Object> kafkaTemplate;
    
    public KafkaProducerService(KafkaTemplate<String, Object> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }
    
    public void sendOrder(Order order) {
        kafkaTemplate.send("orders", order);
    }
    
    public void sendPayment(Payment payment) {
        kafkaTemplate.send("payments", payment);
    }
}
```

### Sample Kafka Configuration

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    consumer:
      group-id: my-group
      auto-offset-reset: earliest
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
    topics:
      orders: orders-topic
      payments: payments-topic
```

### Generated Nodes

- `KafkaConfig` - Kafka configuration
- `KafkaTopics` - Kafka topics
- `kafka.consumer` - Kafka consumer
- `kafka.producer` - Kafka producer
- `kafka.annotation` - Kafka annotation

### Generated Edges

- `HAS_CONFIG` - Kafka config contains topics
- `HAS_CONSUMER` - Service has Kafka consumers
- `HAS_PRODUCER` - Service has Kafka producers
- `USES_TOPIC` - Consumer/producer uses topic

## Testing

### Run Tests

```bash
npm test
```

### Test Coverage

```bash
npm run test:coverage
```

## Development

### Build the Plugin

```bash
npm run build
```

### Watch Mode

```bash
npm run dev
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests
5. Submit a pull request

## License

MIT

## Contact

- **GitHub**：https://github.com/gitnexus/gitnexus
- **Discord**：https://discord.gg/gitnexus
- **Email**：support@gitnexus.io
```

## 如何使用

### 1. 安装依赖

```bash
cd kafka-plugin
npm install
```

### 2. 构建插件

```bash
npm run build
```

### 3. 安装插件

```bash
npm install -g .
```

### 4. 启用插件

```bash
npx gitnexus plugin enable gitnexus-kafka-plugin
```

### 5. 分析项目

```bash
npx gitnexus analyze
```

## 插件工作原理

1. **文件识别**：通过 `supports` 方法识别 Kafka 相关文件
2. **配置解析**：解析 YAML 和 properties 配置文件中的 Kafka 配置
3. **代码分析**：分析 Java 代码中的 Kafka 消费者、生产者和注解
4. **节点生成**：为配置、消费者、生产者创建节点
5. **边生成**：创建组件之间的依赖关系边
6. **结果返回**：返回包含节点和边的解析结果

## 扩展建议

1. **支持更复杂的 Kafka 配置**：如分区、副本、消费者组等
2. **添加 Kafka Streams 支持**：分析 Kafka Streams 代码
3. **实现 Kafka 主题关系图**：生成主题之间的依赖关系
4. **支持 Kafka Connect**：分析 Kafka Connect 配置
5. **添加 Kafka 性能分析**：分析潜在的性能问题

## 故障排查

### 常见问题

1. **消费者识别失败**：确保实现了正确的 Kafka 消费者接口
2. **生产者识别失败**：确保使用了 KafkaTemplate 或其他生产者 API
3. **配置解析错误**：检查配置文件格式是否正确
4. **性能问题**：对于大型项目，可能需要调整分析策略

### 调试技巧

1. **启用调试模式**：`GITNEXUS_DEBUG=1 npx gitnexus analyze`
2. **查看日志**：`~/.gitnexus/logs/plugin.log`
3. **测试插件**：`npx gitnexus plugin test gitnexus-kafka-plugin`

---

**版本**：1.0.0
**最后更新**：2026-04-26
**维护者**：GitNexus 团队
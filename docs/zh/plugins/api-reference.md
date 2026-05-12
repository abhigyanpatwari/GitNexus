# GitNexus 插件 API 参考

## 1. 核心接口

### 1.1 插件基类接口

```typescript
interface Plugin {
  /** 插件名称 */
  name: string;
  
  /** 插件版本 */
  version: string;
  
  /** 插件描述 */
  description?: string;
  
  /** 初始化插件 */
  init?(config: PluginConfig): Promise<void>;
  
  /** 清理资源 */
  dispose?(): Promise<void>;
}
```

### 1.2 解析器插件接口

```typescript
interface ParserPlugin extends Plugin {
  /** 支持的文件扩展名 */
  extensions: string[];
  
  /** 解析文件内容 */
  parse(content: string, filePath: string): Promise<ParseResult>;
  
  /** 注册到解析器注册表 */
  register(registry: ParserRegistry): void;
  
  /** 检查文件是否支持 */
  supports(filePath: string): boolean;
}
```

### 1.3 分析器插件接口

```typescript
interface AnalyzerPlugin extends Plugin {
  /** 支持的语言 */
  languages: string[];
  
  /** 分析代码语义 */
  analyze(node: ASTNode, context: AnalysisContext): Promise<AnalysisResult>;
  
  /** 注册到分析器注册表 */
  register(registry: AnalyzerRegistry): void;
  
  /** 检查语言是否支持 */
  supports(language: string): boolean;
}
```

### 1.4 处理器插件接口

```typescript
interface ProcessorPlugin extends Plugin {
  /** 处理阶段 */
  phase: string;
  
  /** 处理优先级 */
  priority?: number;
  
  /** 处理数据 */
  process(data: any, context: ProcessContext): Promise<any>;
  
  /** 注册到处理器注册表 */
  register(registry: ProcessorRegistry): void;
}
```

### 1.5 集成插件接口

```typescript
interface IntegrationPlugin extends Plugin {
  /** 集成目标 */
  target: string;
  
  /** 执行集成操作 */
  execute(data: any, context: IntegrationContext): Promise<IntegrationResult>;
  
  /** 注册到集成注册表 */
  register(registry: IntegrationRegistry): void;
}
```

## 2. 数据结构

### 2.1 解析结果

```typescript
interface ParseResult {
  /** 解析生成的节点 */
  nodes: Node[];
  
  /** 解析生成的边 */
  edges: Edge[];
  
  /** 元数据 */
  metadata: Record<string, any>;
  
  /** 错误信息 */
  error?: string;
}
```

### 2.2 节点结构

```typescript
interface Node {
  /** 节点 ID */
  id: string;
  
  /** 节点类型 */
  label: string;
  
  /** 节点属性 */
  properties: Record<string, any>;
  
  /** 源文件路径 */
  filePath: string;
  
  /** 开始行号 */
  startLine?: number;
  
  /** 结束行号 */
  endLine?: number;
}
```

### 2.3 边结构

```typescript
interface Edge {
  /** 边 ID */
  id: string;
  
  /** 边类型 */
  type: string;
  
  /** 源节点 ID */
  source: string;
  
  /** 目标节点 ID */
  target: string;
  
  /** 边属性 */
  properties: Record<string, any>;
  
  /** 置信度 */
  confidence?: number;
  
  /** 原因 */
  reason?: string;
}
```

### 2.4 分析上下文

```typescript
interface AnalysisContext {
  /** 当前文件路径 */
  filePath: string;
  
  /** 当前语言 */
  language: string;
  
  /** 语义模型 */
  semanticModel: SemanticModel;
  
  /** 解析器实例 */
  parser: Parser;
  
  /** 分析配置 */
  config: AnalysisConfig;
}
```

### 2.5 处理上下文

```typescript
interface ProcessContext {
  /** 处理阶段 */
  phase: string;
  
  /** 项目路径 */
  projectPath: string;
  
  /** 知识图谱 */
  knowledgeGraph: KnowledgeGraph;
  
  /** 处理配置 */
  config: ProcessConfig;
}
```

## 3. 注册表接口

### 3.1 解析器注册表

```typescript
interface ParserRegistry {
  /** 注册解析器 */
  registerParser(parser: ParserPlugin): void;
  
  /** 获取解析器 */
  getParser(filePath: string): ParserPlugin | undefined;
  
  /** 获取所有解析器 */
  getParsers(): ParserPlugin[];
  
  /** 注销解析器 */
  unregisterParser(name: string): void;
}
```

### 3.2 分析器注册表

```typescript
interface AnalyzerRegistry {
  /** 注册分析器 */
  registerAnalyzer(analyzer: AnalyzerPlugin): void;
  
  /** 获取分析器 */
  getAnalyzers(language: string): AnalyzerPlugin[];
  
  /** 获取所有分析器 */
  getAnalyzers(): AnalyzerPlugin[];
  
  /** 注销分析器 */
  unregisterAnalyzer(name: string): void;
}
```

### 3.3 处理器注册表

```typescript
interface ProcessorRegistry {
  /** 注册处理器 */
  registerProcessor(processor: ProcessorPlugin): void;
  
  /** 获取处理器 */
  getProcessors(phase: string): ProcessorPlugin[];
  
  /** 获取所有处理器 */
  getProcessors(): ProcessorPlugin[];
  
  /** 注销处理器 */
  unregisterProcessor(name: string): void;
}
```

### 3.4 集成注册表

```typescript
interface IntegrationRegistry {
  /** 注册集成 */
  registerIntegration(integration: IntegrationPlugin): void;
  
  /** 获取集成 */
  getIntegration(target: string): IntegrationPlugin | undefined;
  
  /** 获取所有集成 */
  getIntegrations(): IntegrationPlugin[];
  
  /** 注销集成 */
  unregisterIntegration(name: string): void;
}
```

## 4. 配置结构

### 4.1 插件配置

```typescript
interface PluginConfig {
  /** 插件配置项 */
  [key: string]: any;
  
  /** 全局配置 */
  global?: Record<string, any>;
  
  /** 项目配置 */
  project?: Record<string, any>;
  
  /** 环境变量 */
  env?: Record<string, string>;
}
```

### 4.2 分析配置

```typescript
interface AnalysisConfig {
  /** 分析深度 */
  depth?: number;
  
  /** 是否启用缓存 */
  cache?: boolean;
  
  /** 分析超时时间（毫秒） */
  timeout?: number;
  
  /** 自定义配置 */
  [key: string]: any;
}
```

### 4.3 处理配置

```typescript
interface ProcessConfig {
  /** 是否并行处理 */
  parallel?: boolean;
  
  /** 处理线程数 */
  threads?: number;
  
  /** 批处理大小 */
  batchSize?: number;
  
  /** 自定义配置 */
  [key: string]: any;
}
```

## 5. API 方法

### 5.1 插件管理 API

#### 5.1.1 加载插件

```typescript
function loadPlugin(pluginPath: string): Promise<Plugin>;
```

**参数**：
- `pluginPath`：插件路径

**返回**：
- 加载的插件实例

#### 5.1.2 卸载插件

```typescript
function unloadPlugin(pluginName: string): Promise<void>;
```

**参数**：
- `pluginName`：插件名称

#### 5.1.3 列出插件

```typescript
function listPlugins(): Promise<PluginInfo[]>;
```

**返回**：
- 插件信息列表

### 5.2 解析器 API

#### 5.2.1 解析文件

```typescript
function parseFile(filePath: string, content: string): Promise<ParseResult>;
```

**参数**：
- `filePath`：文件路径
- `content`：文件内容

**返回**：
- 解析结果

#### 5.2.2 解析目录

```typescript
function parseDirectory(directoryPath: string): Promise<ParseResult>;
```

**参数**：
- `directoryPath`：目录路径

**返回**：
- 解析结果

### 5.3 分析器 API

#### 5.3.1 分析节点

```typescript
function analyzeNode(node: ASTNode, context: AnalysisContext): Promise<AnalysisResult>;
```

**参数**：
- `node`：AST 节点
- `context`：分析上下文

**返回**：
- 分析结果

#### 5.3.2 分析文件

```typescript
function analyzeFile(filePath: string): Promise<AnalysisResult>;
```

**参数**：
- `filePath`：文件路径

**返回**：
- 分析结果

### 5.4 处理器 API

#### 5.4.1 处理数据

```typescript
function processData(data: any, phase: string, context: ProcessContext): Promise<any>;
```

**参数**：
- `data`：要处理的数据
- `phase`：处理阶段
- `context`：处理上下文

**返回**：
- 处理后的数据

#### 5.4.2 执行处理流程

```typescript
function executeProcessFlow(data: any, phases: string[]): Promise<any>;
```

**参数**：
- `data`：初始数据
- `phases`：处理阶段列表

**返回**：
- 最终处理结果

## 6. 事件系统

### 6.1 事件类型

| 事件名称 | 触发时机 | 事件数据 |
|---------|---------|---------|
| `plugin.loaded` | 插件加载完成 | `{ pluginName: string }` |
| `plugin.unloaded` | 插件卸载完成 | `{ pluginName: string }` |
| `parse.start` | 解析开始 | `{ filePath: string }` |
| `parse.complete` | 解析完成 | `{ filePath: string, result: ParseResult }` |
| `parse.error` | 解析错误 | `{ filePath: string, error: string }` |
| `analyze.start` | 分析开始 | `{ filePath: string }` |
| `analyze.complete` | 分析完成 | `{ filePath: string, result: AnalysisResult }` |
| `analyze.error` | 分析错误 | `{ filePath: string, error: string }` |
| `process.start` | 处理开始 | `{ phase: string }` |
| `process.complete` | 处理完成 | `{ phase: string, result: any }` |
| `process.error` | 处理错误 | `{ phase: string, error: string }` |

### 6.2 事件监听

```typescript
interface EventEmitter {
  /** 监听事件 */
  on(event: string, listener: (data: any) => void): void;
  
  /** 监听事件（仅一次） */
  once(event: string, listener: (data: any) => void): void;
  
  /** 移除事件监听 */
  off(event: string, listener: (data: any) => void): void;
  
  /** 触发事件 */
  emit(event: string, data: any): void;
}
```

## 7. 工具函数

### 7.1 节点工具

```typescript
/** 生成节点 ID */
function generateNodeId(label: string, properties: Record<string, any>): string;

/** 创建节点 */
function createNode(label: string, properties: Record<string, any>): Node;

/** 合并节点 */
function mergeNodes(node1: Node, node2: Node): Node;
```

### 7.2 边工具

```typescript
/** 生成边 ID */
function generateEdgeId(type: string, source: string, target: string): string;

/** 创建边 */
function createEdge(type: string, source: string, target: string, properties?: Record<string, any>): Edge;

/** 合并边 */
function mergeEdges(edge1: Edge, edge2: Edge): Edge;
```

### 7.3 文件工具

```typescript
/** 获取文件扩展名 */
function getFileExtension(filePath: string): string;

/** 获取文件语言 */
function getFileLanguage(filePath: string): string;

/** 检查文件是否为文本文件 */
function isTextFile(filePath: string): boolean;

/** 读取文件内容 */
function readFile(filePath: string): Promise<string>;
```

### 7.4 配置工具

```typescript
/** 加载配置 */
function loadConfig(configPath: string): Promise<Record<string, any>>;

/** 合并配置 */
function mergeConfig(base: Record<string, any>, override: Record<string, any>): Record<string, any>;

/** 获取配置值 */
function getConfigValue(config: Record<string, any>, path: string, defaultValue?: any): any;
```

## 8. 错误处理

### 8.1 错误类型

| 错误类型 | 描述 | 代码 |
|---------|------|------|
| `PluginLoadError` | 插件加载失败 | 1001 |
| `ParserError` | 解析错误 | 2001 |
| `AnalyzerError` | 分析错误 | 3001 |
| `ProcessorError` | 处理错误 | 4001 |
| `IntegrationError` | 集成错误 | 5001 |
| `ConfigurationError` | 配置错误 | 6001 |
| `ValidationError` | 验证错误 | 7001 |

### 8.2 错误处理模式

```typescript
try {
  // 插件操作
} catch (error) {
  if (error instanceof PluginLoadError) {
    // 处理插件加载错误
  } else if (error instanceof ParserError) {
    // 处理解析错误
  } else {
    // 处理其他错误
  }
}
```

## 9. 性能优化

### 9.1 缓存策略

```typescript
interface Cache {
  /** 获取缓存 */
  get(key: string): Promise<any>;
  
  /** 设置缓存 */
  set(key: string, value: any, ttl?: number): Promise<void>;
  
  /** 删除缓存 */
  delete(key: string): Promise<void>;
  
  /** 清空缓存 */
  clear(): Promise<void>;
}
```

### 9.2 并行处理

```typescript
interface WorkerPool {
  /** 执行任务 */
  execute<T>(task: () => Promise<T>): Promise<T>;
  
  /** 执行批量任务 */
  executeBatch<T>(tasks: (() => Promise<T>)[]): Promise<T[]>;
  
  /** 关闭工作池 */
  close(): Promise<void>;
}
```

### 9.3 流式处理

```typescript
interface StreamProcessor {
  /** 处理流 */
  process(stream: Readable): Promise<ParseResult>;
  
  /** 处理文件流 */
  processFile(filePath: string): Promise<ParseResult>;
}
```

## 10. 安全考虑

### 10.1 插件权限

| 权限 | 描述 | 默认值 |
|------|------|--------|
| `file.read` | 读取文件 | true |
| `file.write` | 写入文件 | false |
| `network.request` | 网络请求 | false |
| `process.spawn` | 执行进程 | false |
| `system.info` | 系统信息 | true |

### 10.2 安全最佳实践

- **最小权限原则**：只授予插件必要的权限
- **输入验证**：验证所有用户输入
- **输出编码**：编码所有输出内容
- **沙箱隔离**：在沙箱中运行插件
- **定期更新**：及时更新插件依赖

## 11. 兼容性

### 11.1 版本兼容性

| GitNexus 版本 | 插件 API 版本 | 兼容性 |
|---------------|---------------|--------|
| 1.0.x | 1.0 | ✅ 兼容 |
| 1.1.x | 1.1 | ✅ 兼容 |
| 2.0.x | 2.0 | ⚠️ 部分兼容 |
| 3.0.x | 3.0 | ❌ 不兼容 |

### 11.2 语言兼容性

| 语言 | 支持状态 | 备注 |
|------|----------|------|
| TypeScript | ✅ 完全支持 | 推荐使用 |
| JavaScript | ✅ 完全支持 | 无类型检查 |
| Python | ⚠️ 部分支持 | 需要适配器 |
| Java | ⚠️ 部分支持 | 需要适配器 |

## 12. 示例代码

### 12.1 完整的解析器插件

```typescript
import { ParserPlugin, ParseResult, ParserRegistry, createNode, createEdge } from 'gitnexus-shared';
import { parse } from 'json5';

export class JsonParserPlugin implements ParserPlugin {
  name = 'gitnexus-json-plugin';
  version = '1.0.0';
  description = 'JSON and JSON5 parser plugin for GitNexus';
  extensions = ['.json', '.json5'];
  
  async parse(content: string, filePath: string): Promise<ParseResult> {
    try {
      const data = parse(content);
      const nodes = [];
      const edges = [];
      
      // 处理 JSON 数据
      this.processJson(data, filePath, 'root', nodes, edges);
      
      return {
        nodes,
        edges,
        metadata: {
          format: 'json',
          size: content.length
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
  
  private processJson(data: any, filePath: string, parentId: string, nodes: any[], edges: any[]): void {
    if (typeof data === 'object' && data !== null) {
      for (const [key, value] of Object.entries(data)) {
        const nodeId = `json:${filePath}:${key}`;
        const node = createNode('JsonProperty', {
          name: key,
          value: JSON.stringify(value),
          type: typeof value,
          filePath
        });
        nodes.push(node);
        
        if (parentId !== 'root') {
          const edge = createEdge('HAS_PROPERTY', parentId, nodeId, {
            confidence: 1.0,
            reason: 'JSON property'
          });
          edges.push(edge);
        }
        
        this.processJson(value, filePath, nodeId, nodes, edges);
      }
    }
  }
  
  register(registry: ParserRegistry): void {
    registry.registerParser(this);
  }
  
  supports(filePath: string): boolean {
    const extension = filePath.split('.').pop()?.toLowerCase();
    return this.extensions.some(ext => ext === `.${extension}`);
  }
  
  async init(config: any): Promise<void> {
    // 初始化逻辑
    console.log(`Initialized ${this.name} with config:`, config);
  }
  
  async dispose(): Promise<void> {
    // 清理逻辑
    console.log(`Disposed ${this.name}`);
  }
}

export default new JsonParserPlugin();
```

### 12.2 完整的分析器插件

```typescript
import { AnalyzerPlugin, AnalysisResult, AnalyzerRegistry, AnalysisContext } from 'gitnexus-shared';

export class SpringAnalyzerPlugin implements AnalyzerPlugin {
  name = 'gitnexus-spring-plugin';
  version = '1.0.0';
  description = 'Spring framework analyzer plugin for GitNexus';
  languages = ['java'];
  
  async analyze(node: any, context: AnalysisContext): Promise<AnalysisResult> {
    const results = [];
    
    // 分析 Spring 注解
    if (node.type === 'annotation') {
      const annotationName = node.name?.text;
      if (annotationName) {
        results.push({
          type: 'spring.annotation',
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
    
    // 分析 Spring 组件
    if (node.type === 'class_declaration') {
      const classAnnotations = node.annotations || [];
      for (const annotation of classAnnotations) {
        const annotationName = annotation.name?.text;
        if (['Controller', 'RestController', 'Service', 'Repository', 'Component'].includes(annotationName)) {
          results.push({
            type: 'spring.component',
            name: node.name?.text,
            componentType: annotationName,
            location: {
              filePath: context.filePath,
              startLine: node.startLine,
              endLine: node.endLine
            }
          });
        }
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
  
  private extractAnnotationProperties(annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};
    // 提取注解属性
    return properties;
  }
  
  register(registry: AnalyzerRegistry): void {
    registry.registerAnalyzer(this);
  }
  
  supports(language: string): boolean {
    return this.languages.includes(language);
  }
}

export default new SpringAnalyzerPlugin();
```

## 13. 测试 API

### 13.1 测试工具

```typescript
interface PluginTester {
  /** 测试插件加载 */
  testLoad(pluginPath: string): Promise<void>;
  
  /** 测试插件解析 */
  testParse(plugin: ParserPlugin, filePath: string, content: string): Promise<ParseResult>;
  
  /** 测试插件分析 */
  testAnalyze(plugin: AnalyzerPlugin, node: any, context: AnalysisContext): Promise<AnalysisResult>;
  
  /** 测试插件处理 */
  testProcess(plugin: ProcessorPlugin, data: any, context: ProcessContext): Promise<any>;
  
  /** 运行完整测试套件 */
  runTests(pluginPath: string): Promise<TestResult>;
}
```

### 13.2 测试示例

```typescript
import { PluginTester } from 'gitnexus-shared';

const tester = new PluginTester();

// 测试解析器插件
async function testJsonParser() {
  const result = await tester.testParse(
    jsonParserPlugin,
    'test.json',
    '{"name": "test", "value": 123}'
  );
  console.log('Parse result:', result);
}

// 运行完整测试
async function runTests() {
  const result = await tester.runTests('./gitnexus-json-plugin');
  console.log('Test result:', result);
}
```

## 14. 部署指南

### 14.1 本地部署

```bash
# 安装插件
npm install -g ./gitnexus-my-plugin

# 验证安装
npx gitnexus plugin list

# 启用插件
npx gitnexus plugin enable gitnexus-my-plugin
```

### 14.2 NPM 部署

1. **发布到 NPM**：
   ```bash
   npm publish
   ```

2. **安装插件**：
   ```bash
   npm install -g gitnexus-my-plugin
   ```

### 14.3 Docker 部署

```dockerfile
FROM node:18-alpine

RUN npm install -g gitnexus gitnexus-my-plugin

CMD ["gitnexus", "serve"]
```

## 15. 监控与日志

### 15.1 日志级别

| 级别 | 描述 |
|------|------|
| `debug` | 详细调试信息 |
| `info` | 普通信息 |
| `warn` | 警告信息 |
| `error` | 错误信息 |
| `fatal` | 致命错误 |

### 15.2 日志配置

```json
{
  "logging": {
    "level": "info",
    "file": "~/.gitnexus/logs/plugin.log",
    "console": true,
    "rotation": {
      "maxSize": "10MB",
      "maxFiles": 5
    }
  }
}
```

### 15.3 监控指标

| 指标 | 描述 | 单位 |
|------|------|------|
| `plugin.load.time` | 插件加载时间 | 毫秒 |
| `parse.time` | 解析时间 | 毫秒 |
| `analyze.time` | 分析时间 | 毫秒 |
| `process.time` | 处理时间 | 毫秒 |
| `memory.usage` | 内存使用 | MB |
| `error.count` | 错误计数 | 次 |

## 16. 常见问题

### 16.1 插件加载失败

**问题**：插件加载时出现 `Module not found` 错误

**解决方案**：
- 检查插件依赖是否安装
- 确保插件路径正确
- 验证 Node.js 版本兼容性

### 16.2 解析性能问题

**问题**：解析大文件时性能不佳

**解决方案**：
- 实现流式解析
- 使用 Worker 线程并行处理
- 启用缓存机制

### 16.3 插件冲突

**问题**：多个插件处理相同文件类型

**解决方案**：
- 调整插件优先级
- 明确插件处理范围
- 使用 `supports` 方法进行精确匹配

### 16.4 内存泄漏

**问题**：插件运行后内存使用持续增长

**解决方案**：
- 及时释放资源
- 实现 `dispose` 方法
- 避免循环引用

## 17. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-04-26 | 初始版本 |
| 1.1.0 | 2026-05-15 | 添加集成插件接口 |
| 1.2.0 | 2026-06-01 | 增强事件系统 |
| 2.0.0 | 2026-07-01 | 重构 API 设计 |

## 18. 贡献指南

### 18.1 API 变更流程

1. **提出变更**：在 GitHub Issues 中提出 API 变更建议
2. **讨论**：与社区讨论变更的必要性和影响
3. **实现**：实现 API 变更
4. **测试**：编写测试用例验证变更
5. **文档**：更新 API 文档
6. **发布**：发布新版本

### 18.2 代码规范

- **TypeScript**：使用 TypeScript 编写插件
- **ESLint**：遵循 ESLint 规范
- **Prettier**：使用 Prettier 格式化代码
- **Jest**：使用 Jest 编写测试

### 18.3 提交规范

```
<type>(<scope>): <description>

<body>

<footer>
```

**类型**：
- `feat`：新功能
- `fix`：bug 修复
- `docs`：文档更新
- `style`：代码风格
- `refactor`：代码重构
- `test`：测试更新
- `chore`：构建流程

## 19. 联系我们

- **GitHub**：https://github.com/gitnexus/gitnexus
- **Discord**：https://discord.gg/gitnexus
- **Email**：support@gitnexus.io
- **Twitter**：@gitnexus

---

**版本**：1.0.0
**最后更新**：2026-04-26
**维护者**：GitNexus 团队
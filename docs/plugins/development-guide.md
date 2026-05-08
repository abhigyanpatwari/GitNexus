# GitNexus 插件开发指南#

## 1. 概述#

GitNexus 插件系统允许开发者扩展解析能力，支持更多文件类型和语言特性。本指南将详细介绍如何开发 GitNexus 插件。

## 2. 插件架构#

### 2.1 核心组件#

```
┌─────────────────────────────────────────────────┐
│                     GitNexus Core                     │
├─────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ Parser API  │  │ Analyzer API│  │ Processor API│   │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
├─────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ Plugin A    │  │ Plugin B    │  │ Plugin C    │   │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────┘
```

### 2.2 插件类型#

| 插件类型 | 作用 | 接口 |
|---------|------|------|
| **解析器插件** | 解析特定文件类型 | `ParserPlugin` |
| **分析器插件** | 分析代码语义 | `AnalyzerPlugin` |
| **处理器插件** | 处理特定语言特性 | `ProcessorPlugin` |
| **集成插件** | 集成外部工具 | `IntegrationPlugin` |

## 3. 环境设置#

### 3.1 创建插件项目#

```bash
# 进入插件目录
cd gitnexus-plugins/

# 创建插件目录
mkdir gitnexus-my-plugin
cd gitnexus-my-plugin/

# 初始化项目
npm init -y
```

### 3.2 项目结构#

```
gitnexus-my-plugin/
├── src/
│   └── index.ts          # 插件主文件
├── package.json
├── tsconfig.json
└── README.md
```

### 3.3 package.json 配置#

```json
{
  "name": "gitnexus-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "description": "My custom plugin for GitNexus",
  "main": "dist/index.js",
  "gitnexus": { "plugin": true },
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "gitnexus-shared": "file:../gitnexus-shared"
  }
}
```

**注意**：从 `gitnexus-plugins/` 目录，使用 `"file:../gitnexus-shared"` 指向同级目录的 `gitnexus-shared`。

或者使用 `npm link` 方式：

```bash
# 先在 gitnexus-shared 目录
cd gitnexus-shared
npm run build
npm link

# 然后在插件目录
cd ../gitnexus-plugins/your-plugin
npm link gitnexus-shared
```

### 3.4 tsconfig.json 配置#

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

## 4. 开发解析器插件#

### 4.1 解析器插件接口#

```typescript
import { ParserPlugin, ParseResult, ParserRegistry, GraphNode, GraphRelationship, createNode, createEdge } from 'gitnexus-shared';

export interface MyPluginConfig {
  strictMode?: boolean;
}

export class MyParserPlugin implements ParserPlugin {
  name = 'gitnexus-my-plugin';
  version = '1.0.0';
  description = 'My custom parser plugin';
  extensions = ['.myext', '.myformat'];
  
  private config: MyPluginConfig = {};
  
  async init(config: MyPluginConfig): Promise<void> {
    this.config = config;
  }
  
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];
    
    try {
      // 解析内容
      const parsed = this.parseContent(content, filePath);
      
      // 生成节点
      for (const item of parsed.items) {
        const node = createNode('MyNode', {
          name: item.name,
          value: item.value,
          filePath
        });
        nodes.push(node);
        
        // 生成边（如果有父节点）
        if (item.parent) {
          edges.push(createEdge('CONTAINS', item.parent, node.id, {
            confidence: 1.0,
            reason: 'parent-child relationship'
          }));
        }
      }
      
      return {
        nodes,
        edges,
        metadata: {
          format: 'myformat',
          itemCount: parsed.items.length
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
  
  private parseContent(content: string, filePath: string): any {
    // 实现解析逻辑
    return { items: [] };
  }
  
  register(registry: ParserRegistry): void {
    registry.registerParser(this);
  }
  
  supports(filePath: string): boolean {
    return this.extensions.some(ext => filePath.endsWith(ext));
  }
  
  async dispose(): Promise<void> {
    // 清理资源
  }
}

export default new MyParserPlugin();
```

### 4.2 解析结果格式#

```typescript
interface ParseResult {
  /** 解析生成的节点 */
  nodes: GraphNode[];
  
  /** 解析生成的边 */
  edges: GraphRelationship[];
  
  /** 元数据 */
  metadata: Record<string, any>;
  
  /** 错误信息 */
  error?: string;
}

interface GraphNode {
  id: string;
  label: NodeLabel;
  properties: NodeProperties;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

interface GraphRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  confidence: number;
  reason: string;
  properties?: Record<string, any>;
}
```

## 5. 开发分析器插件#

### 5.1 分析器插件接口#

```typescript
import { 
  AnalyzerPlugin, 
  AnalysisResult, 
  AnalyzerRegistry, 
  AnalysisContext 
} from 'gitnexus-shared';

export class MyAnalyzerPlugin implements AnalyzerPlugin {
  name = 'gitnexus-my-analyzer';
  version = '1.0.0';
  description = 'My custom analyzer plugin';
  languages = ['java', 'typescript'];
  
  async analyze(node: any, context: AnalysisContext): Promise<AnalysisResult> {
    const results = [];
    
    // 分析节点
    if (node.type === 'class_declaration') {
      results.push({
        type: 'my.analyzed_class',
        name: node.name?.text,
        location: {
          filePath: context.filePath,
          startLine: node.startLine,
          endLine: node.endLine
        },
        properties: {
          modifiers: node.modifiers?.map((m: any) => m.text) || []
        }
      });
    }
    
    return {
      results,
      metadata: {
        analyzer: this.name,
        language: context.language
      }
    };
  }
  
  register(registry: AnalyzerRegistry): void {
    registry.registerAnalyzer(this);
  }
  
  supports(language: string): boolean {
    return this.languages.includes(language);
  }
}

export default new MyAnalyzerPlugin();
```

### 5.2 分析上下文#

```typescript
interface AnalysisContext {
  filePath: string;
  language: string;
  semanticModel: any;
  parser: any;
  config: AnalysisConfig;
}

interface AnalysisConfig {
  depth?: number;
  cache?: boolean;
  timeout?: number;
  [key: string]: any;
}
```

## 6. 开发处理器插件#

### 6.1 处理器插件接口#

```typescript
import { 
  ProcessorPlugin, 
  ProcessorRegistry, 
  ProcessContext 
} from 'gitnexus-shared';

export class MyProcessorPlugin implements ProcessorPlugin {
  name = 'gitnexus-my-processor';
  version = '1.0.0';
  description = 'My custom processor plugin';
  phase = 'post-parse';
  priority = 100;
  
  async process(data: any, context: ProcessContext): Promise<any> {
    // 处理数据
    const { knowledgeGraph } = context;
    
    // 添加额外的节点和边
    const extraNodes = this.generateExtraNodes(data);
    const extraEdges = this.generateExtraEdges(data);
    
    // 将额外节点和边添加到知识图谱
    for (const node of extraNodes) {
      knowledgeGraph.addNode(node);
    }
    for (const edge of extraEdges) {
      knowledgeGraph.addEdge(edge);
    }
    
    return {
      ...data,
      processed: true,
      processor: this.name
    };
  }
  
  private generateExtraNodes(data: any): any[] {
    return [];
  }
  
  private generateExtraEdges(data: any): any[] {
    return [];
  }
  
  register(registry: ProcessorRegistry): void {
    registry.registerProcessor(this);
  }
}

export default new MyProcessorPlugin();
```

### 6.2 处理上下文#

```typescript
interface ProcessContext {
  phase: string;
  projectPath: string;
  knowledgeGraph: any;
  config: ProcessConfig;
}

interface ProcessConfig {
  parallel?: boolean;
  threads?: number;
  batchSize?: number;
  [key: string]: any;
}
```

## 7. 开发集成插件#

### 7.1 集成插件接口#

```typescript
import { 
  IntegrationPlugin, 
  IntegrationRegistry, 
  IntegrationContext,
  IntegrationResult 
} from 'gitnexus-shared';

export class MyIntegrationPlugin implements IntegrationPlugin {
  name = 'gitnexus-my-integration';
  version = '1.0.0';
  description = 'My custom integration plugin';
  target = 'my-service';
  
  async execute(data: any, context: IntegrationContext): Promise<IntegrationResult> {
    try {
      // 执行集成操作
      const result = await this.callExternalService(data, context);
      
      return {
        success: true,
        data: result,
        metadata: {
          integration: this.name,
          target: this.target
        }
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }
  
  private async callExternalService(data: any, context: IntegrationContext): Promise<any> {
    // 调用外部服务
    return {};
  }
  
  register(registry: IntegrationRegistry): void {
    registry.registerIntegration(this);
  }
}

export default new MyIntegrationPlugin();
```

## 8. Markdown 插件（Profile 系统）#

GitNexus 提供了一个强大的 Markdown 插件，支持通过 **Profile** 对不同类型文档进行定制化解析。

### 8.1 内置 Profile#

| Profile | 匹配条件 | 解析内容 |
|---------|-----------|----------|
| `generic` | 默认匹配所有 Markdown 文件 | 标题、代码块、链接、图片、TODO、表格 |
| `api-docs` | 包含 `@api`/`## API`/`swagger` | 同上 + API 特定解析 |
| `adr` | 包含 `## Status`/`Architecture Decision Record` | 同上 + ADR 结构 |

### 8.2 自定义 Profile#

创建 `my-profile.ts`：

```typescript
import { MarkdownProfile, SectionParser, createNode, GraphNode } from 'gitnexus-shared';

// 自定义解析器：提取特定章节
class MySectionParser implements SectionParser {
  name = 'my-section';
  
  parse(lines: string[], startIndex: number, filePath: string, context: any) {
    const line = lines[startIndex];
    const match = line.match(/^## My Special Section$/);
    if (!match) return null;
    
    // 提取章节内容
    const contentLines: string[] = [];
    let j = startIndex + 1;
    while (j < lines.length && !lines[j].startsWith('## ')) {
      contentLines.push(lines[j]);
      j++;
    }
    
    const sectionNode = createNode('MySection', {
      name: 'My Special Section',
      filePath,
      content: contentLines.join('\n'),
      startLine: startIndex + 1
    });
    
    const nodes: GraphNode[] = [sectionNode];
    const edges = [];
    
    if (context.currentHeadingId) {
      edges.push(createEdge('HAS_SECTION', context.currentHeadingId, sectionNode.id, {}));
    }
    
    return { nodes, edges, nextIndex: j };
  }
}

// 自定义 Profile
export const myDocProfile: MarkdownProfile = {
  name: 'my-doc',
  detect: (content: string) => content.includes('## My Special Section'),
  parsers: [new MySectionParser()],
  priority: 20 // 高优先级
};
```

### 8.3 加载自定义 Profile#

```bash
# 方式 1：通过插件配置加载
gitnexus plugin load ../gitnexus-plugins/markdown-plugin \
  --config '{"customProfiles":["./my-profile.js"]}'

# 方式 2：使用已提供的 Profile
# （api-docs、adr 等会自动检测）
```

## 9. 测试插件#

### 9.1 单元测试#

```typescript
import { describe, it, expect, beforeEach } from 'jest';
import { MyParserPlugin } from '../src/index';

describe('MyParserPlugin', () => {
  let plugin: MyParserPlugin;
  
  beforeEach(() => {
    plugin = new MyParserPlugin();
  });
  
  it('should have correct name', () => {
    expect(plugin.name).toBe('gitnexus-my-plugin');
  });
  
  it('should support correct file extensions', () => {
    expect(plugin.supports('test.myext')).toBe(true);
    expect(plugin.supports('test.txt')).toBe(false);
  });
  
  it('should parse valid content', async () => {
    const content = 'sample content';
    const result = await plugin.parse(content, '/path/to/test.myext');
    
    expect(result.nodes).toBeDefined();
    expect(result.edges).toBeDefined();
    expect(result.error).toBeUndefined();
  });
  
  it('should handle parse errors', async () => {
    const content = 'invalid content';
    const result = await plugin.parse(content, '/path/to/test.myext');
    
    expect(result.error).toBeDefined();
  });
});
```

### 9.2 集成测试#

```typescript
import { describe, it, expect } from 'jest';
import { pluginManager } from 'gitnexus-core/plugins';
import { loadPlugin, unloadPlugin } from 'gitnexus-core/plugins/plugin-loader';

describe('Plugin Integration', () => {
  beforeEach(async () => {
    // 加载测试插件
    await loadPlugin({ pluginPath: './test-plugin' });
  });
  
  afterEach(async () => {
    // 清理
    unloadPlugin('gitnexus-test-plugin');
  });
  
  it('should load and register plugin', () => {
    const plugin = pluginManager.getPlugin('gitnexus-test-plugin');
    expect(plugin).toBeDefined();
  });
  
  it('should parse files using plugin', async () => {
    const parser = pluginManager.parserRegistry.getParser('/path/to/test.myext');
    expect(parser).toBeDefined();
  });
});
```

## 10. 调试技巧#

### 10.1 启用调试模式#

```bash
GITNEXUS_DEBUG=1 gitnexus analyze
```

### 10.2 查看日志#

```bash
# 查看插件日志
cat ~/.gitnexus/logs/plugin.log

# 实时查看日志
tail -f ~/.gitnexus/logs/plugin.log
```

### 10.3 测试单个插件#

```bash
# 加载插件
gitnexus plugin load ../gitnexus-plugins/my-plugin/

# 测试插件
gitnexus analyze --verbose

# 查看插件状态
gitnexus plugin status
```

## 11. 发布插件#

### 11.1 发布到 npm#

```bash
# 登录 npm
npm login

# 发布
cd gitnexus-plugins/my-plugin/
npm publish

# 发布到特定标签
npm publish --tag beta
```

### 11.2 插件命名规范#

- 解析器插件：`gitnexus-[format]-plugin`
- 分析器插件：`gitnexus-[language]-plugin`
- 处理器插件：`gitnexus-[feature]-plugin`
- 集成插件：`gitnexus-[service]-integration`

示例：
- `gitnexus-xml-plugin`
- `gitnexus-java-plugin`
- `gitnexus-spring-plugin`
- `gitnexus-github-integration`

## 12. 最佳实践#

### 12.1 性能优化#

- **缓存解析结果**：避免重复解析相同内容
- **流式处理**：处理大文件时使用流式解析
- **并行处理**：利用 Worker 线程并行处理
- **懒加载**：按需加载插件功能

### 12.2 错误处理#

```typescript
async parse(content: string, filePath: string): Promise<ParseResult> {
  try {
    // 解析逻辑
  } catch (error) {
    // 记录错误
    console.error(`Parse error in ${filePath}:`, error);
    
    // 返回错误结果
    return {
      nodes: [],
      edges: [],
      metadata: {},
      error: `Parse failed: ${(error as Error).message}`
    };
  }
}
```

### 12.3 配置管理#

```typescript
interface PluginConfig {
  strictMode?: boolean;
  cacheEnabled?: boolean;
  maxFileSize?: number;
  customOption?: string;
}

async init(config: PluginConfig = {}): Promise<void> {
  this.config = {
    strictMode: false,
    cacheEnabled: true,
    maxFileSize: 1024 * 1024,
    ...config
  };
}
```

### 12.4 资源清理#

```typescript
private resources: any[] = [];

async dispose(): Promise<void> {
  // 清理所有资源
  for (const resource of this.resources) {
    if (typeof resource.dispose === 'function') {
      resource.dispose();
    }
  }
  this.resources = [];
  
  // 清理缓存
  this.cache?.clear();
  
  // 关闭连接
  await this.connection?.close();
}
```

## 13. 常见问题#

### 13.1 插件加载失败#

**问题**：插件加载时出现 `Module not found` 错误

**解决方案**：
- 检查插件依赖是否安装
- 确保插件路径正确
- 验证 Node.js 版本兼容性
- 使用 `npm link` 或 `file:` 协议正确引用 `gitnexus-shared`

### 13.2 解析性能问题#

**问题**：解析大文件时性能不佳

**解决方案**：
- 实现流式解析
- 使用 Worker 线程并行处理
- 启用缓存机制

### 13.3 插件冲突#

**问题**：多个插件处理相同文件类型

**解决方案**：
- 调整插件优先级
- 明确插件处理范围
- 使用 `supports` 方法进行精确匹配

## 14. 相关文档#

- [插件系统总览](../gitnexus-plugins/README.md) - 查看所有可用插件
- [API 参考](api-reference.md) - 完整的插件 API 文档
- [LLM 开发指南](llm-guide.md) - 如何使用 LLM 辅助开发插件
- [快速开始](quickstart.md) - 5分钟创建第一个插件
- [故障排除](troubleshooting.md) - 常见问题解决

## 15. 联系方式#

- **GitHub Issues**：https://github.com/abhigyanpatwari/GitNexus/issues
- **Discord**：https://discord.gg/gitnexus
- **Email**：support@gitnexus.io

---

**版本**：1.1.0
**最后更新**：2026-05-07
**维护者**：GitNexus 团队

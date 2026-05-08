# GitNexus 插件快速开始

本指南将帮助您在 5 分钟内创建并运行您的第一个 GitNexus 插件。

## 前置要求

- Node.js 18+
- npm 8+
- GitNexus CLI 已安装

## 第一步：创建插件项目

```bash
# 进入插件目录
cd gitnexus-plugins/

# 创建插件目录
mkdir gitnexus-hello-plugin
cd gitnexus-hello-plugin

# 初始化 npm 项目
npm init -y
```

## 第二步：创建项目配置

创建 `package.json`：

```json
{
  "name": "gitnexus-hello-plugin",
  "version": "1.0.0",
  "type": "module",
  "description": "Hello World plugin for GitNexus",
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

创建 `tsconfig.json`：

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

## 第三步：编写插件代码

创建 `src/index.ts`：

```typescript
import { 
  ParserPlugin, 
  ParseResult, 
  ParserRegistry,
  createNode,
  createEdge,
  GraphNode,
  GraphRelationship 
} from 'gitnexus-shared';

/**
 * Hello World 解析器插件
 * 解析 .hello 文件，提取简单的键值对
 */
export class HelloParserPlugin implements ParserPlugin {
  name = 'gitnexus-hello-plugin';
  version = '1.0.0';
  description = 'Hello World plugin for GitNexus';
  extensions = ['.hello'];
  
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];
    
    // 解析简单的键值对格式
    // 格式：key=value
    const lines = content.split('\n');
    let lineNumber = 0;
    
    for (const line of lines) {
      lineNumber++;
      const trimmed = line.trim();
      
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // 解析 key=value 格式
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex > 0) {
        const key = trimmed.substring(0, equalIndex).trim();
        const value = trimmed.substring(equalIndex + 1).trim();
        
        // 创建节点
        const node = createNode('HelloKey', {
          name: key,
          value,
          filePath,
          line: lineNumber
        });
        nodes.push(node);
        
        // 如果是配置类型，创建一个分类节点
        if (key.startsWith('config.')) {
          nodes.push(createNode('HelloConfig', {
            name: key,
            filePath,
            line: lineNumber
          }));
        }
      }
    }
    
    return {
      nodes,
      edges,
      metadata: {
        format: 'hello',
        linesProcessed: lineNumber
      }
    };
  }
  
  register(registry: ParserRegistry): void {
    registry.registerParser(this);
  }
  
  supports(filePath: string): boolean {
    return filePath.endsWith('.hello');
  }
}

export default new HelloParserPlugin();
```

## 第四步：构建插件

```bash
# 安装依赖（使用 npm link 或 file: 协议）
cd ../gitnexus-shared && npm run build && npm link
cd ../gitnexus-hello-plugin
npm link gitnexus-shared

# 构建插件
npm run build
```

## 第五步：测试插件

### 创建测试文件

创建 `test.hello`：

```
# Hello World 配置文件
config.app.name=MyApp
config.app.version=1.0.0
database.host=localhost
database.port=5432
```

### 加载并测试插件

```bash
# 进入 GitNexus CLI 目录
cd gitnexus/

# 扫描并加载插件
gitnexus plugin scan ../gitnexus-plugins/

# 列出插件，确认已加载
gitnexus plugin list
```

## 完整示例：JSON 解析插件

如果您需要解析更复杂的格式（如 JSON），这里有一个完整的示例：

```typescript
import { 
  ParserPlugin, 
  ParseResult, 
  ParserRegistry,
  createNode,
  createEdge,
  GraphNode,
  GraphRelationship 
} from 'gitnexus-shared';

export class JsonParserPlugin implements ParserPlugin {
  name = 'gitnexus-json-plugin';
  version = '1.0.0';
  description = 'JSON parser plugin for GitNexus';
  extensions = ['.json'];
  
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];
    
    try {
      const data = JSON.parse(content);
      this.processValue('root', data, filePath, null, nodes, edges);
      
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
        error: `JSON parse error: ${(error as Error).message}`
      };
    }
  }
  
  private processValue(
    key: string, 
    value: any, 
    filePath: string, 
    parentId: string | null,
    nodes: GraphNode[],
    edges: GraphRelationship[]
  ): void {
    const node = createNode('JsonProperty', {
      name: key,
      value: typeof value === 'object' ? null : String(value),
      type: Array.isArray(value) ? 'array' : typeof value,
      filePath
    });
    nodes.push(node);
    
    if (parentId) {
      edges.push(createEdge('HAS_PROPERTY', parentId, node.id, {
        confidence: 1.0,
        reason: 'JSON property'
      }));
    }
    
    if (typeof value === 'object' && value !== null) {
      for (const [childKey, childValue] of Object.entries(value)) {
        this.processValue(childKey, childValue, filePath, node.id, nodes, edges);
      }
    }
  }
  
  register(registry: ParserRegistry): void {
    registry.registerParser(this);
  }
  
  supports(filePath: string): boolean {
    return filePath.endsWith('.json');
  }
}

export default new JsonParserPlugin();
```

## 下一步

- 阅读 [完整开发指南](../gitnexus-plugins/README.md) 了解更高级的特性
- 阅读 [API 参考](api-reference.md) 查看所有可用的接口
- 阅读 [LLM 开发指南](llm-guide.md) 了解如何使用 AI 辅助开发插件
- 查看 [插件目录](../gitnexus-plugins/) 获取更多参考

## 常见问题

**Q: 插件加载成功但没有生效？**
A: 确保插件已启用：`gitnexus plugin enable <plugin-name>`

**Q: 如何调试插件？**
A: 设置环境变量 `GITNEXUS_DEBUG=1` 并查看日志

**Q: 插件可以依赖其他 npm 包吗？**
A: 可以，只需在 package.json 的 dependencies 中添加即可。

**Q: 如何引用 gitnexus-shared？**
A: 在 `gitnexus-plugins/` 目录下，使用 `"gitnexus-shared": "file:../gitnexus-shared"`，或先 `cd gitnexus-shared && npm link`，然后在插件目录 `npm link gitnexus-shared`。

# XML 解析插件示例

## 功能描述

这个插件用于解析 XML 文件，提取 XML 元素和属性，生成相应的节点和边关系。

## 目录结构

```
xml-parser/
├── src/
│   └── index.ts          # 插件主文件
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
└── README.md             # 插件文档
```

## 代码实现

### src/index.ts

```typescript
import { ParserPlugin, ParseResult, ParserRegistry, createNode, createEdge } from 'gitnexus-shared';
import { parseString } from 'xml2js';

/**
 * XML 解析插件
 * 解析 XML 文件，提取元素和属性
 */
export class XmlParserPlugin implements ParserPlugin {
  /** 插件名称 */
  name = 'gitnexus-xml-plugin';
  
  /** 插件版本 */
  version = '1.0.0';
  
  /** 插件描述 */
  description = 'XML file parser plugin for GitNexus';
  
  /** 支持的文件扩展名 */
  extensions = ['.xml'];
  
  /**
   * 解析 XML 文件内容
   * @param content XML 文件内容
   * @param filePath 文件路径
   * @returns 解析结果
   */
  async parse(content: string, filePath: string): Promise<ParseResult> {
    return new Promise((resolve) => {
      parseString(content, { explicitArray: false }, (err, result) => {
        if (err) {
          resolve({
            nodes: [],
            edges: [],
            metadata: { error: err.message }
          });
          return;
        }
        
        const nodes = [];
        const edges = [];
        
        // 处理 XML 根元素
        if (result) {
          const rootKey = Object.keys(result)[0];
          if (rootKey) {
            this.processXmlElement(rootKey, result[rootKey], filePath, null, nodes, edges);
          }
        }
        
        resolve({
          nodes,
          edges,
          metadata: {
            format: 'xml',
            size: content.length,
            rootElement: Object.keys(result)[0] || 'unknown'
          }
        });
      });
    });
  }
  
  /**
   * 处理 XML 元素
   * @param name 元素名称
   * @param value 元素值
   * @param filePath 文件路径
   * @param parentId 父元素 ID
   * @param nodes 节点数组
   * @param edges 边数组
   */
  private processXmlElement(name: string, value: any, filePath: string, parentId: string | null, nodes: any[], edges: any[]): void {
    // 生成元素节点 ID
    const elementId = `xml:${filePath}:${name}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    
    // 创建元素节点
    const elementNode = createNode('XmlElement', {
      name,
      filePath,
      type: 'element'
    });
    nodes.push(elementNode);
    
    // 创建父元素到当前元素的边
    if (parentId) {
      const edge = createEdge('CONTAINS', parentId, elementId, {
        confidence: 1.0,
        reason: 'XML element containment'
      });
      edges.push(edge);
    }
    
    // 处理元素属性
    if (typeof value === 'object' && value !== null) {
      // 提取属性
      const attributes = value['$'] || {};
      for (const [attrName, attrValue] of Object.entries(attributes)) {
        const attrId = `xml:${filePath}:attr:${name}:${attrName}`;
        const attrNode = createNode('XmlAttribute', {
          name: attrName,
          value: String(attrValue),
          element: name,
          filePath
        });
        nodes.push(attrNode);
        
        // 创建元素到属性的边
        const attrEdge = createEdge('HAS_ATTRIBUTE', elementId, attrId, {
          confidence: 1.0,
          reason: 'XML attribute'
        });
        edges.push(attrEdge);
      }
      
      // 处理子元素
      for (const [childName, childValue] of Object.entries(value)) {
        if (childName !== '$') {
          // 处理数组形式的子元素
          if (Array.isArray(childValue)) {
            for (const item of childValue) {
              this.processXmlElement(childName, item, filePath, elementId, nodes, edges);
            }
          } else {
            this.processXmlElement(childName, childValue, filePath, elementId, nodes, edges);
          }
        }
      }
    } else if (value !== undefined) {
      // 处理文本内容
      const textId = `xml:${filePath}:text:${name}`;
      const textNode = createNode('XmlText', {
        value: String(value),
        element: name,
        filePath
      });
      nodes.push(textNode);
      
      // 创建元素到文本的边
      const textEdge = createEdge('HAS_TEXT', elementId, textId, {
        confidence: 1.0,
        reason: 'XML text content'
      });
      edges.push(textEdge);
    }
  }
  
  /**
   * 注册插件到解析器注册表
   * @param registry 解析器注册表
   */
  register(registry: ParserRegistry): void {
    registry.registerParser(this);
  }
  
  /**
   * 检查文件是否支持
   * @param filePath 文件路径
   * @returns 是否支持
   */
  supports(filePath: string): boolean {
    return filePath.endsWith('.xml');
  }
  
  /**
   * 初始化插件
   * @param config 插件配置
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
export default new XmlParserPlugin();
```

### package.json

```json
{
  "name": "gitnexus-xml-plugin",
  "version": "1.0.0",
  "description": "XML file parser plugin for GitNexus",
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
    "xml",
    "parser"
  ],
  "author": "GitNexus Team",
  "license": "MIT",
  "dependencies": {
    "gitnexus-shared": "^1.0.0",
    "xml2js": "^0.6.2"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/xml2js": "^0.4.11",
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
    "module": "commonjs",
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
# GitNexus XML Parser Plugin

XML file parser plugin for GitNexus. Parses XML files and extracts elements, attributes, and text content.

## Features

- Parses XML files with `.xml` extension
- Extracts XML elements, attributes, and text content
- Generates nodes for elements, attributes, and text
- Creates edges for element containment, attribute relationships, and text content
- Supports nested XML structures
- Handles XML namespaces
- Provides error handling for invalid XML

## Installation

### Local Installation

```bash
# Clone the repository
git clone https://github.com/gitnexus/gitnexus-plugins.git
cd gitnexus-plugins/examples/parser-plugins/xml-parser

# Install dependencies
npm install

# Build the plugin
npm run build

# Install globally
npm install -g .
```

### NPM Installation

```bash
npm install -g gitnexus-xml-plugin
```

## Usage

### Enable the Plugin

```bash
npx gitnexus plugin enable gitnexus-xml-plugin
```

### Analyze a Project

```bash
# Analyze a project with XML files
npx gitnexus analyze --plugins gitnexus-xml-plugin
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
      "name": "gitnexus-xml-plugin",
      "enabled": true,
      "config": {
        "strictMode": false,
        "trimWhitespace": true
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
      "name": "gitnexus-xml-plugin",
      "enabled": true,
      "config": {
        "strictMode": true
      }
    }
  ]
}
```

## Examples

### Sample XML File

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    
    <groupId>com.example</groupId>
    <artifactId>my-project</artifactId>
    <version>1.0.0</version>
    
    <dependencies>
        <dependency>
            <groupId>org.springframework</groupId>
            <artifactId>spring-core</artifactId>
            <version>5.3.23</version>
        </dependency>
    </dependencies>
</project>
```

### Generated Nodes

- `XmlElement` with name `project`
- `XmlAttribute` with name `xmlns`
- `XmlAttribute` with name `xmlns:xsi`
- `XmlAttribute` with name `xsi:schemaLocation`
- `XmlElement` with name `modelVersion`
- `XmlText` with value `4.0.0`
- `XmlElement` with name `groupId`
- `XmlText` with value `com.example`
- `XmlElement` with name `artifactId`
- `XmlText` with value `my-project`
- `XmlElement` with name `version`
- `XmlText` with value `1.0.0`
- `XmlElement` with name `dependencies`
- `XmlElement` with name `dependency`
- `XmlElement` with name `groupId` (inside dependency)
- `XmlText` with value `org.springframework`
- `XmlElement` with name `artifactId` (inside dependency)
- `XmlText` with value `spring-core`
- `XmlElement` with name `version` (inside dependency)
- `XmlText` with value `5.3.23`

### Generated Edges

- `CONTAINS` from `project` to `modelVersion`
- `CONTAINS` from `project` to `groupId`
- `CONTAINS` from `project` to `artifactId`
- `CONTAINS` from `project` to `version`
- `CONTAINS` from `project` to `dependencies`
- `CONTAINS` from `dependencies` to `dependency`
- `CONTAINS` from `dependency` to `groupId`
- `CONTAINS` from `dependency` to `artifactId`
- `CONTAINS` from `dependency` to `version`
- `HAS_ATTRIBUTE` from `project` to `xmlns`
- `HAS_ATTRIBUTE` from `project` to `xmlns:xsi`
- `HAS_ATTRIBUTE` from `project` to `xsi:schemaLocation`
- `HAS_TEXT` from `modelVersion` to text node
- `HAS_TEXT` from `groupId` to text node
- `HAS_TEXT` from `artifactId` to text node
- `HAS_TEXT` from `version` to text node
- `HAS_TEXT` from `groupId` (inside dependency) to text node
- `HAS_TEXT` from `artifactId` (inside dependency) to text node
- `HAS_TEXT` from `version` (inside dependency) to text node

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
cd xml-parser
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
npx gitnexus plugin enable gitnexus-xml-plugin
```

### 5. 分析项目

```bash
npx gitnexus analyze --plugins gitnexus-xml-plugin
```

## 插件工作原理

1. **文件识别**：通过 `supports` 方法识别 `.xml` 文件
2. **XML 解析**：使用 `xml2js` 库解析 XML 内容
3. **节点生成**：为 XML 元素、属性和文本创建节点
4. **边生成**：创建元素包含、属性关系和文本内容的边
5. **结果返回**：返回包含节点和边的解析结果

## 扩展建议

1. **支持更多 XML 特性**：如 CDATA  sections、处理指令等
2. **添加 XML Schema 支持**：根据 XSD 验证 XML 结构
3. **实现缓存机制**：缓存解析结果提高性能
4. **添加配置选项**：如是否忽略空白、是否保留注释等
5. **支持 XML 命名空间**：更好地处理命名空间前缀

## 故障排查

### 常见问题

1. **插件加载失败**：检查依赖是否正确安装
2. **解析错误**：检查 XML 文件格式是否正确
3. **性能问题**：对于大 XML 文件，考虑实现流式解析
4. **内存使用**：对于大型 XML 文件，可能需要调整内存限制

### 调试技巧

1. **启用调试模式**：`GITNEXUS_DEBUG=1 npx gitnexus analyze`
2. **查看日志**：`~/.gitnexus/logs/plugin.log`
3. **测试插件**：`npx gitnexus plugin test gitnexus-xml-plugin`

---

**版本**：1.0.0
**最后更新**：2026-04-26
**维护者**：GitNexus 团队
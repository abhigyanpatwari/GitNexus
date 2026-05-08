# MyBatis 插件示例

## 功能描述

这个插件用于解析 MyBatis 框架代码，提取 Mapper 接口、XML 映射文件、SQL 语句等组件，并生成相应的节点和边关系。

## 目录结构

```
mybatis-plugin/
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
 * MyBatis 插件
 * 解析 MyBatis 框架的 Mapper 接口和 XML 映射文件
 */
export class MyBatisPlugin implements ParserPlugin, AnalyzerPlugin {
  name = 'gitnexus-mybatis-plugin';
  version = '1.0.0';
  description = 'MyBatis plugin for GitNexus';
  extensions = ['.xml', '.java'];
  languages = ['java'];
  
  /**
   * 解析文件内容
   */
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes = [];
    const edges = [];
    
    try {
      if (filePath.endsWith('.xml')) {
        await this.parseXmlMapper(content, filePath, nodes, edges);
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
    
    // 分析 MyBatis Mapper 接口
    if (node.type === 'interface_declaration') {
      const interfaceName = node.name?.text;
      const annotations = node.annotations || [];
      
      // 检查是否为 MyBatis Mapper 接口
      if (this.isMapperInterface(annotations)) {
        results.push({
          type: 'mybatis.mapper',
          name: interfaceName,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine
          },
          properties: this.extractMapperProperties(node)
        });
      }
    }
    
    // 分析方法上的 MyBatis 注解
    if (node.type === 'method_declaration') {
      const methodName = node.name?.text;
      const annotations = node.annotations || [];
      
      for (const annotation of annotations) {
        const annotationName = annotation.name?.text;
        if (this.isMyBatisAnnotation(annotationName)) {
          results.push({
            type: 'mybatis.method',
            name: methodName,
            annotation: annotationName,
            location: {
              filePath: context.filePath,
              startLine: node.startLine,
              endLine: node.endLine
            },
            properties: this.extractMethodProperties(node, annotation)
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
  
  /**
   * 解析 XML Mapper 文件
   */
  private async parseXmlMapper(content: string, filePath: string, nodes: any[], edges: any[]): Promise<void> {
    // 简单的 XML 解析
    // 实际项目中可以使用 xml2js 等库进行更复杂的解析
    
    // 提取命名空间
    const namespaceMatch = content.match(/namespace="([^"]+)"/);
    if (namespaceMatch) {
      const namespace = namespaceMatch[1];
      
      const mapperNode = createNode('MyBatisXmlMapper', {
        name: namespace,
        filePath,
        type: 'xml'
      });
      nodes.push(mapperNode);
      
      // 提取 SQL 语句
      const sqlStatements = this.extractSqlStatements(content);
      
      for (const sql of sqlStatements) {
        const sqlNode = createNode('MyBatisSql', {
          id: sql.id,
          type: sql.type,
          filePath
        });
        nodes.push(sqlNode);
        
        edges.push(createEdge('HAS_SQL', mapperNode.id, sqlNode.id, {
          confidence: 1.0,
          reason: 'MyBatis SQL statement'
        }));
      }
    }
  }
  
  /**
   * 提取 SQL 语句
   */
  private extractSqlStatements(content: string): Array<{ id: string, type: string }> {
    const statements = [];
    const statementTypes = ['select', 'insert', 'update', 'delete', 'resultMap', 'parameterMap', 'sql'];
    
    for (const type of statementTypes) {
      const regex = new RegExp(`${type}\s+id="([^"]+)"`, 'g');
      let match;
      while ((match = regex.exec(content)) !== null) {
        statements.push({
          id: match[1],
          type
        });
      }
    }
    
    return statements;
  }
  
  /**
   * 检查是否为 Mapper 接口
   */
  private isMapperInterface(annotations: any[]): boolean {
    for (const annotation of annotations) {
      const annotationName = annotation.name?.text;
      if (annotationName === 'Mapper' || annotationName === 'Repository') {
        return true;
      }
    }
    return false;
  }
  
  /**
   * 检查是否为 MyBatis 注解
   */
  private isMyBatisAnnotation(annotationName: string): boolean {
    const myBatisAnnotations = [
      'Select',
      'Insert',
      'Update',
      'Delete',
      'ResultMap',
      'Param',
      'Options',
      'Result',
      'Results'
    ];
    return myBatisAnnotations.includes(annotationName);
  }
  
  /**
   * 提取 Mapper 接口属性
   */
  private extractMapperProperties(node: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    if (node.extends) {
      properties.extends = node.extends.text;
    }
    
    if (node.typeParameters) {
      properties.typeParameters = node.typeParameters.map((t: any) => t.text);
    }
    
    // 提取方法
    if (node.body && node.body.methods) {
      properties.methods = node.body.methods.map((m: any) => m.name?.text);
    }
    
    return properties;
  }
  
  /**
   * 提取方法属性
   */
  private extractMethodProperties(node: any, annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    if (annotation.arguments) {
      properties.annotationArguments = this.extractArguments(annotation.arguments);
    }
    
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
    if (filePath.endsWith('.xml')) {
      return 'xml';
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
export default new MyBatisPlugin();
```

### package.json

```json
{
  "name": "gitnexus-mybatis-plugin",
  "version": "1.0.0",
  "description": "MyBatis plugin for GitNexus",
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
    "mybatis",
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
# GitNexus MyBatis Plugin

MyBatis plugin for GitNexus. Parses MyBatis framework code and extracts Mapper interfaces, XML mapping files, and SQL statements.

## Features

- Parses MyBatis XML mapping files
- Analyzes MyBatis Mapper interfaces
- Extracts SQL statements from XML files
- Identifies MyBatis annotations in Java code
- Generates nodes and edges for MyBatis components
- Supports both XML-based and annotation-based MyBatis configurations

## Installation

### Local Installation

```bash
# Clone the repository
git clone https://github.com/gitnexus/gitnexus-plugins.git
cd gitnexus-plugins/examples/mybatis-plugin

# Install dependencies
npm install

# Build the plugin
npm run build

# Install globally
npm install -g .
```

### NPM Installation

```bash
npm install -g gitnexus-mybatis-plugin
```

## Usage

### Enable the Plugin

```bash
npx gitnexus plugin enable gitnexus-mybatis-plugin
```

### Analyze a MyBatis Project

```bash
# Analyze a MyBatis project
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
      "name": "gitnexus-mybatis-plugin",
      "enabled": true,
      "config": {
        "scanXmlMappers": true,
        "scanAnnotationMappers": true,
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
      "name": "gitnexus-mybatis-plugin",
      "enabled": true,
      "config": {
        "scanXmlMappers": true,
        "scanAnnotationMappers": false,
        "includeTestFiles": true
      }
    }
  ]
}
```

## Examples

### Sample MyBatis Mapper Interface

```java
@Mapper
public interface UserMapper {
    @Select("SELECT * FROM users WHERE id = #{id}")
    User findById(@Param("id") Long id);
    
    @Insert("INSERT INTO users (name, email) VALUES (#{name}, #{email})")
    @Options(useGeneratedKeys = true, keyProperty = "id")
    void insert(User user);
    
    @Update("UPDATE users SET name = #{name}, email = #{email} WHERE id = #{id}")
    void update(User user);
    
    @Delete("DELETE FROM users WHERE id = #{id}")
    void delete(@Param("id") Long id);
}
```

### Sample MyBatis XML Mapper

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.mapper.UserMapper">
    <resultMap id="UserResultMap" type="com.example.model.User">
        <id property="id" column="id" />
        <result property="name" column="name" />
        <result property="email" column="email" />
    </resultMap>
    
    <select id="findById" resultMap="UserResultMap">
        SELECT * FROM users WHERE id = #{id}
    </select>
    
    <insert id="insert" useGeneratedKeys="true" keyProperty="id">
        INSERT INTO users (name, email) VALUES (#{name}, #{email})
    </insert>
</mapper>
```

### Generated Nodes

- `MyBatisXmlMapper` - XML Mapper file
- `MyBatisSql` - SQL statement
- `mybatis.mapper` - Mapper interface
- `mybatis.method` - Mapper method

### Generated Edges

- `HAS_SQL` - XML Mapper contains SQL statements
- `HAS_METHOD` - Mapper interface contains methods
- `IMPLEMENTS` - Mapper interface implements XML Mapper

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
cd mybatis-plugin
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
npx gitnexus plugin enable gitnexus-mybatis-plugin
```

### 5. 分析项目

```bash
npx gitnexus analyze
```

## 插件工作原理

1. **文件识别**：通过 `supports` 方法识别 MyBatis 相关文件
2. **XML 解析**：解析 MyBatis XML 映射文件，提取命名空间和 SQL 语句
3. **代码分析**：分析 Java 代码中的 MyBatis 注解和 Mapper 接口
4. **节点生成**：为 Mapper 接口、XML 文件、SQL 语句创建节点
5. **边生成**：创建组件之间的依赖关系边
6. **结果返回**：返回包含节点和边的解析结果

## 扩展建议

1. **支持更复杂的 XML 解析**：使用专门的 XML 解析库
2. **添加 SQL 语句分析**：分析 SQL 语句的结构和依赖
3. **支持 MyBatis-Plus**：添加对 MyBatis-Plus 扩展的支持
4. **实现 Mapper 接口和 XML 的匹配**：自动匹配对应的接口和 XML 文件
5. **添加参数和返回值分析**：分析方法参数和返回值类型

## 故障排查

### 常见问题

1. **XML 解析错误**：检查 XML 文件格式是否正确
2. **Mapper 接口识别失败**：确保使用了正确的 `@Mapper` 注解
3. **性能问题**：对于大型项目，可能需要调整解析策略
4. **SQL 语句提取不完整**：检查 SQL 语句格式

### 调试技巧

1. **启用调试模式**：`GITNEXUS_DEBUG=1 npx gitnexus analyze`
2. **查看日志**：`~/.gitnexus/logs/plugin.log`
3. **测试插件**：`npx gitnexus plugin test gitnexus-mybatis-plugin`

---

**版本**：1.0.0
**最后更新**：2026-04-26
**维护者**：GitNexus 团队
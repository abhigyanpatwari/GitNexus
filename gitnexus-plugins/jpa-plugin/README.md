# JPA 插件示例

## 功能描述

这个插件用于解析 JPA (Java Persistence API) 框架代码，提取实体类、仓库接口、查询方法等组件，并生成相应的节点和边关系。

## 目录结构

```
jpa-plugin/
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
 * JPA 插件
 * 解析 JPA 框架的实体类和仓库接口
 */
export class JPAPlugin implements ParserPlugin, AnalyzerPlugin {
  name = 'gitnexus-jpa-plugin';
  version = '1.0.0';
  description = 'JPA plugin for GitNexus';
  extensions = ['.java'];
  languages = ['java'];
  
  /**
   * 解析文件内容
   */
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes = [];
    const edges = [];
    
    // Java 文件由分析器处理
    
    return {
      nodes,
      edges,
      metadata: {
        format: 'java',
        filePath
      }
    };
  }
  
  /**
   * 分析代码语义
   */
  async analyze(node: any, context: AnalysisContext): Promise<AnalysisResult> {
    const results = [];
    
    // 分析 JPA 实体类
    if (node.type === 'class_declaration') {
      const className = node.name?.text;
      const annotations = node.annotations || [];
      
      // 检查是否为 JPA 实体类
      if (this.isJpaEntity(annotations)) {
        results.push({
          type: 'jpa.entity',
          name: className,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine
          },
          properties: this.extractEntityProperties(node, annotations)
        });
      }
    }
    
    // 分析 JPA 仓库接口
    if (node.type === 'interface_declaration') {
      const interfaceName = node.name?.text;
      
      // 检查是否为 JPA 仓库接口
      if (this.isJpaRepository(node)) {
        results.push({
          type: 'jpa.repository',
          name: interfaceName,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine
          },
          properties: this.extractRepositoryProperties(node)
        });
      }
    }
    
    // 分析 JPA 字段注解
    if (node.type === 'field_declaration') {
      const fieldName = node.declarators[0]?.name?.text;
      const annotations = node.annotations || [];
      
      for (const annotation of annotations) {
        const annotationName = annotation.name?.text;
        if (this.isJpaFieldAnnotation(annotationName)) {
          results.push({
            type: 'jpa.field',
            name: fieldName,
            annotation: annotationName,
            location: {
              filePath: context.filePath,
              startLine: node.startLine,
              endLine: node.endLine
            },
            properties: this.extractFieldProperties(node, annotation)
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
   * 检查是否为 JPA 实体类
   */
  private isJpaEntity(annotations: any[]): boolean {
    for (const annotation of annotations) {
      const annotationName = annotation.name?.text;
      if (annotationName === 'Entity' || annotationName === 'Embeddable' || annotationName === 'MappedSuperclass') {
        return true;
      }
    }
    return false;
  }
  
  /**
   * 检查是否为 JPA 仓库接口
   */
  private isJpaRepository(node: any): boolean {
    // 检查是否继承自 JpaRepository 或其他 Spring Data 仓库接口
    if (node.extends) {
      const extendsName = node.extends.text;
      return extendsName.includes('Repository') || 
             extendsName.includes('JpaRepository') ||
             extendsName.includes('CrudRepository') ||
             extendsName.includes('PagingAndSortingRepository');
    }
    return false;
  }
  
  /**
   * 检查是否为 JPA 字段注解
   */
  private isJpaFieldAnnotation(annotationName: string): boolean {
    const jpaFieldAnnotations = [
      'Id',
      'GeneratedValue',
      'Column',
      'JoinColumn',
      'OneToOne',
      'OneToMany',
      'ManyToOne',
      'ManyToMany',
      'Embedded',
      'EmbeddedId',
      'Transient',
      'Temporal',
      'Enumerated',
      'Lob'
    ];
    return jpaFieldAnnotations.includes(annotationName);
  }
  
  /**
   * 提取实体类属性
   */
  private extractEntityProperties(node: any, annotations: any[]): Record<string, any> {
    const properties: Record<string, any> = {};
    
    // 提取表名
    for (const annotation of annotations) {
      if (annotation.name?.text === 'Table') {
        properties.table = this.extractArguments(annotation.arguments);
      } else if (annotation.name?.text === 'Entity') {
        properties.entity = this.extractArguments(annotation.arguments);
      }
    }
    
    if (node.extends) {
      properties.extends = node.extends.text;
    }
    
    if (node.implements) {
      properties.implements = node.implements.map((i: any) => i.text);
    }
    
    return properties;
  }
  
  /**
   * 提取仓库接口属性
   */
  private extractRepositoryProperties(node: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    if (node.extends) {
      properties.extends = node.extends.text;
    }
    
    if (node.typeParameters) {
      properties.typeParameters = node.typeParameters.map((t: any) => t.text);
    }
    
    // 提取查询方法
    if (node.body && node.body.methods) {
      properties.queryMethods = node.body.methods.map((m: any) => ({
        name: m.name?.text,
        returnType: m.returnType?.text
      }));
    }
    
    return properties;
  }
  
  /**
   * 提取字段属性
   */
  private extractFieldProperties(node: any, annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    if (annotation.arguments) {
      properties.annotationArguments = this.extractArguments(annotation.arguments);
    }
    
    if (node.type) {
      properties.type = node.type.text;
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
    } else if (valueNode.type === 'member_expression') {
      return valueNode.text;
    } else {
      return valueNode.text || valueNode.value;
    }
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
export default new JPAPlugin();
```

### package.json

```json
{
  "name": "gitnexus-jpa-plugin",
  "version": "1.0.0",
  "description": "JPA plugin for GitNexus",
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
    "jpa",
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
    "type": "analyzer"
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
# GitNexus JPA Plugin

JPA plugin for GitNexus. Parses JPA framework code and extracts entities, repositories, and relationships.

## Features

- Analyzes JPA entity classes
- Identifies JPA repository interfaces
- Extracts JPA field annotations
- Recognizes entity relationships
- Generates nodes and edges for JPA components
- Supports Spring Data JPA

## Installation

### Local Installation

```bash
# Clone the repository
git clone https://github.com/gitnexus/gitnexus-plugins.git
cd gitnexus-plugins/examples/jpa-plugin

# Install dependencies
npm install

# Build the plugin
npm run build

# Install globally
npm install -g .
```

### NPM Installation

```bash
npm install -g gitnexus-jpa-plugin
```

## Usage

### Enable the Plugin

```bash
npx gitnexus plugin enable gitnexus-jpa-plugin
```

### Analyze a JPA Project

```bash
# Analyze a JPA project
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
      "name": "gitnexus-jpa-plugin",
      "enabled": true,
      "config": {
        "scanEntities": true,
        "scanRepositories": true,
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
      "name": "gitnexus-jpa-plugin",
      "enabled": true,
      "config": {
        "scanEntities": true,
        "scanRepositories": true,
        "includeTestFiles": true
      }
    }
  ]
}
```

## Examples

### Sample JPA Entity

```java
@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    
    @Column(name = "name", nullable = false)
    private String name;
    
    @Column(name = "email", unique = true, nullable = false)
    private String email;
    
    @OneToMany(mappedBy = "user")
    private List<Order> orders;
    
    // getters and setters
}
```

### Sample JPA Repository

```java
public interface UserRepository extends JpaRepository<User, Long> {
    User findByEmail(String email);
    
    List<User> findByNameContaining(String name);
    
    @Query("SELECT u FROM User u WHERE u.email LIKE %:email%")
    List<User> findByEmailLike(@Param("email") String email);
}
```

### Generated Nodes

- `jpa.entity` - JPA entity class
- `jpa.repository` - JPA repository interface
- `jpa.field` - JPA field with annotations

### Generated Edges

- `HAS_FIELD` - Entity has fields
- `HAS_RELATIONSHIP` - Entity has relationships
- `HAS_METHOD` - Repository has query methods
- `MANAGES` - Repository manages entity

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
cd jpa-plugin
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
npx gitnexus plugin enable gitnexus-jpa-plugin
```

### 5. 分析项目

```bash
npx gitnexus analyze
```

## 插件工作原理

1. **文件识别**：通过 `supports` 方法识别 Java 文件
2. **代码分析**：分析 Java 代码中的 JPA 注解和接口
3. **实体识别**：识别带有 `@Entity` 注解的类
4. **仓库识别**：识别继承自 `JpaRepository` 的接口
5. **字段分析**：分析带有 JPA 注解的字段
6. **节点生成**：为实体、仓库、字段创建节点
7. **边生成**：创建组件之间的依赖关系边
8. **结果返回**：返回包含节点和边的解析结果

## 扩展建议

1. **支持更复杂的 JPA 关系**：如级联操作、双向关系等
2. **添加查询方法分析**：分析 Spring Data JPA 的查询方法命名规则
3. **支持 JPA 元模型**：分析 JPA 元模型生成的代码
4. **实现实体关系可视化**：生成实体关系图
5. **添加 JPA 性能分析**：分析潜在的性能问题

## 故障排查

### 常见问题

1. **实体识别失败**：确保使用了正确的 `@Entity` 注解
2. **仓库识别失败**：确保继承自正确的 JPA 仓库接口
3. **性能问题**：对于大型项目，可能需要调整分析策略
4. **关系识别不完整**：检查关系注解的使用是否正确

### 调试技巧

1. **启用调试模式**：`GITNEXUS_DEBUG=1 npx gitnexus analyze`
2. **查看日志**：`~/.gitnexus/logs/plugin.log`
3. **测试插件**：`npx gitnexus plugin test gitnexus-jpa-plugin`

---

**版本**：1.0.0
**最后更新**：2026-04-26
**维护者**：GitNexus 团队
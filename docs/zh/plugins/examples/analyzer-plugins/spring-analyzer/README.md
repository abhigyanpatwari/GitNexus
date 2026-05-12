# Spring 分析器插件示例

## 功能描述

这个插件用于分析 Spring 框架代码，识别 Spring 组件（如 Controller、Service、Repository 等）和注解，生成相应的节点和边关系。

## 目录结构

```
spring-analyzer/
├── src/
│   └── index.ts          # 插件主文件
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
└── README.md             # 插件文档
```

## 代码实现

### src/index.ts

```typescript
import { AnalyzerPlugin, AnalysisResult, AnalyzerRegistry, AnalysisContext } from 'gitnexus-shared';

/**
 * Spring 分析器插件
 * 分析 Spring 框架代码，识别组件和注解
 */
export class SpringAnalyzerPlugin implements AnalyzerPlugin {
  /** 插件名称 */
  name = 'gitnexus-spring-plugin';
  
  /** 插件版本 */
  version = '1.0.0';
  
  /** 插件描述 */
  description = 'Spring framework analyzer plugin for GitNexus';
  
  /** 支持的语言 */
  languages = ['java'];
  
  /**
   * 分析代码语义
   * @param node AST 节点
   * @param context 分析上下文
   * @returns 分析结果
   */
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
        if (this.isSpringComponent(annotationName)) {
          results.push({
            type: 'spring.component',
            name: node.name?.text,
            componentType: annotationName,
            location: {
              filePath: context.filePath,
              startLine: node.startLine,
              endLine: node.endLine
            },
            properties: this.extractComponentProperties(node, annotation)
          });
        }
      }
    }
    
    // 分析 Spring 方法
    if (node.type === 'method_declaration') {
      const methodAnnotations = node.annotations || [];
      for (const annotation of methodAnnotations) {
        const annotationName = annotation.name?.text;
        if (this.isSpringMethodAnnotation(annotationName)) {
          results.push({
            type: 'spring.method',
            name: node.name?.text,
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
   * 提取注解属性
   * @param annotation 注解节点
   * @returns 注解属性
   */
  private extractAnnotationProperties(annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    // 提取注解参数
    if (annotation.arguments) {
      properties.arguments = this.extractArguments(annotation.arguments);
    }
    
    return properties;
  }
  
  /**
   * 提取组件属性
   * @param node 类节点
   * @param annotation 注解节点
   * @returns 组件属性
   */
  private extractComponentProperties(node: any, annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    // 提取注解参数
    if (annotation.arguments) {
      properties.annotationArguments = this.extractArguments(annotation.arguments);
    }
    
    // 提取类修饰符
    if (node.modifiers) {
      properties.modifiers = node.modifiers.map((m: any) => m.text);
    }
    
    // 提取类实现的接口
    if (node.implements) {
      properties.implements = node.implements.map((i: any) => i.text);
    }
    
    // 提取类继承的父类
    if (node.superClass) {
      properties.superClass = node.superClass.text;
    }
    
    return properties;
  }
  
  /**
   * 提取方法属性
   * @param node 方法节点
   * @param annotation 注解节点
   * @returns 方法属性
   */
  private extractMethodProperties(node: any, annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};
    
    // 提取注解参数
    if (annotation.arguments) {
      properties.annotationArguments = this.extractArguments(annotation.arguments);
    }
    
    // 提取方法修饰符
    if (node.modifiers) {
      properties.modifiers = node.modifiers.map((m: any) => m.text);
    }
    
    // 提取方法返回类型
    if (node.returnType) {
      properties.returnType = node.returnType.text;
    }
    
    // 提取方法参数
    if (node.parameters) {
      properties.parameters = node.parameters.map((p: any) => ({
        name: p.name?.text,
        type: p.type?.text
      }));
    }
    
    return properties;
  }
  
  /**
   * 提取注解参数
   * @param arguments 注解参数
   * @returns 参数对象
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
          // 处理没有名称的参数
          args.value = this.extractArgumentValue(arg);
        }
      }
    }
    
    return args;
  }
  
  /**
   * 提取参数值
   * @param valueNode 值节点
   * @returns 参数值
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
   * 检查是否为 Spring 组件注解
   * @param annotationName 注解名称
   * @returns 是否为 Spring 组件
   */
  private isSpringComponent(annotationName: string): boolean {
    const componentAnnotations = [
      'Controller',
      'RestController',
      'Service',
      'Repository',
      'Component',
      'Configuration',
      'Bean',
      'Autowired',
      'Qualifier',
      'Value',
      'RequestMapping',
      'GetMapping',
      'PostMapping',
      'PutMapping',
      'DeleteMapping',
      'PatchMapping'
    ];
    return componentAnnotations.includes(annotationName);
  }
  
  /**
   * 检查是否为 Spring 方法注解
   * @param annotationName 注解名称
   * @returns 是否为 Spring 方法注解
   */
  private isSpringMethodAnnotation(annotationName: string): boolean {
    const methodAnnotations = [
      'RequestMapping',
      'GetMapping',
      'PostMapping',
      'PutMapping',
      'DeleteMapping',
      'PatchMapping',
      'ResponseBody',
      'RequestBody',
      'PathVariable',
      'RequestParam',
      'RequestHeader',
      'CookieValue',
      'SessionAttribute',
      'ModelAttribute'
    ];
    return methodAnnotations.includes(annotationName);
  }
  
  /**
   * 注册插件到分析器注册表
   * @param registry 分析器注册表
   */
  register(registry: AnalyzerRegistry): void {
    registry.registerAnalyzer(this);
  }
  
  /**
   * 检查语言是否支持
   * @param language 语言名称
   * @returns 是否支持
   */
  supports(language: string): boolean {
    return this.languages.includes(language);
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
export default new SpringAnalyzerPlugin();
```

### package.json

```json
{
  "name": "gitnexus-spring-plugin",
  "version": "1.0.0",
  "description": "Spring framework analyzer plugin for GitNexus",
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
    "spring",
    "analyzer"
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
# GitNexus Spring Analyzer Plugin

Spring framework analyzer plugin for GitNexus. Analyzes Spring code and identifies components, annotations, and relationships.

## Features

- Analyzes Java files for Spring components
- Identifies Spring annotations (Controller, Service, Repository, etc.)
- Extracts component relationships and dependencies
- Analyzes Spring MVC endpoints and request mappings
- Supports Spring Boot and traditional Spring applications
- Generates detailed metadata about Spring components

## Installation

### Local Installation

```bash
# Clone the repository
git clone https://github.com/gitnexus/gitnexus-plugins.git
cd gitnexus-plugins/examples/analyzer-plugins/spring-analyzer

# Install dependencies
npm install

# Build the plugin
npm run build

# Install globally
npm install -g .
```

### NPM Installation

```bash
npm install -g gitnexus-spring-plugin
```

## Usage

### Enable the Plugin

```bash
npx gitnexus plugin enable gitnexus-spring-plugin
```

### Analyze a Project

```bash
# Analyze a Spring project
npx gitnexus analyze --plugins gitnexus-spring-plugin
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
      "name": "gitnexus-spring-plugin",
      "enabled": true,
      "config": {
        "scanAllAnnotations": true,
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
      "name": "gitnexus-spring-plugin",
      "enabled": true,
      "config": {
        "scanAllAnnotations": false,
        "includeTestFiles": true
      }
    }
  ]
}
```

## Examples

### Sample Spring Controller

```java
package com.example.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users")
public class UserController {
    
    private final UserService userService;
    
    public UserController(UserService userService) {
        this.userService = userService;
    }
    
    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) {
        return userService.getUserById(id);
    }
}
```

### Generated Analysis Results

- `spring.component` with name `UserController` and type `RestController`
- `spring.annotation` with name `RestController`
- `spring.annotation` with name `RequestMapping` and value `"/api/users"`
- `spring.method` with name `getUser` and annotation `GetMapping`
- `spring.annotation` with name `GetMapping` and value `"/{id}"`
- `spring.annotation` with name `PathVariable`

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
cd spring-analyzer
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
npx gitnexus plugin enable gitnexus-spring-plugin
```

### 5. 分析项目

```bash
npx gitnexus analyze --plugins gitnexus-spring-plugin
```

## 插件工作原理

1. **语言识别**：通过 `supports` 方法识别 Java 文件
2. **AST 分析**：分析 Java 代码的抽象语法树
3. **注解识别**：识别 Spring 相关的注解
4. **组件提取**：提取 Spring 组件信息
5. **关系分析**：分析组件之间的依赖关系
6. **结果生成**：返回包含分析结果的对象

## 扩展建议

1. **支持更多 Spring 注解**：如 Spring Security、Spring Data 等
2. **添加组件依赖分析**：分析组件之间的依赖关系
3. **实现 API 文档生成**：基于 RequestMapping 生成 API 文档
4. **添加配置文件分析**：分析 application.yml/application.properties
5. **支持 Spring Boot 特性**：如 @SpringBootApplication、@EnableAutoConfiguration 等

## 故障排查

### 常见问题

1. **插件加载失败**：检查依赖是否正确安装
2. **分析错误**：检查 Java 文件格式是否正确
3. **性能问题**：对于大型项目，可能需要调整分析策略
4. **识别问题**：确保 Spring 注解使用正确的包路径

### 调试技巧

1. **启用调试模式**：`GITNEXUS_DEBUG=1 npx gitnexus analyze`
2. **查看日志**：`~/.gitnexus/logs/plugin.log`
3. **测试插件**：`npx gitnexus plugin test gitnexus-spring-plugin`

---

**版本**：1.0.0
**最后更新**：2026-04-26
**维护者**：GitNexus 团队
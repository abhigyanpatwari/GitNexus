# Spring Boot 插件示例

## 功能描述

这个插件用于解析 Spring Boot 应用，提取应用配置、控制器、服务、仓库等组件，并生成相应的节点和边关系。支持：

- **Bean 节点生成**：识别 Spring Bean（@Component, @Service, @Repository, @Controller, @RestController, @Configuration, @Aspect）
- **依赖注入关系**：识别 @Autowired、@Inject 等注入点，建立 INJECTS_INTO 关系
- **配置属性绑定**：解析 YAML/properties 配置文件，生成 ConfigProperty 节点
- **Kafka 支持**：识别 Kafka 消费者和生产者
- **AOP 切面分析**：识别 @Aspect、@Pointcut 和通知注解，建立 ADVISES 关系
- **事务管理**：识别 @Transactional 注解
- **缓存注解**：识别 @Cacheable、@CachePut、@CacheEvict 注解
- **定时任务**：识别 @Scheduled 注解
- **异步方法**：识别 @Async 注解
- **安全授权**：识别 @PreAuthorize、@PostAuthorize、@Secured 注解
- **事件系统**：识别 @EventListener 注解

## 架构设计

### 注解注册表模式 (Annotation Registry Pattern)

本插件采用**注册表 + 元数据**混合模式处理 Spring 注解，相比传统的 if-else 方式，具有以下优势：

1. **配置化**：新增注解只需在 `SPRING_ANNOTATIONS` 配置中添加条目
2. **解耦合**：每个注解的处理逻辑统一由 `processSpringAnnotation` 方法处理
3. **可扩展**：支持自定义属性提取器和关系创建器
4. **易维护**：注解逻辑集中管理，代码结构清晰

### 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                    SPRING_ANNOTATIONS                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Transactional → { resultType, properties, relations }│   │
│  │ Cacheable     → { resultType, properties, relations }│   │
│  │ Scheduled     → { resultType, properties }          │   │
│  │ ...                                                    │   │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              processSpringAnnotation()                       │
│  1. 根据注解名查找元数据                                      │
│  2. 提取注解参数                                             │
│  3. 生成分析结果                                              │
│  4. 注册待创建的关系                                          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                        analyze()                             │
│  对每个方法级注解调用 processSpringAnnotation()               │
└─────────────────────────────────────────────────────────────┘
```

## 支持的节点类型

| 节点类型 | 描述 | 属性 |
|---------|------|------|
| `Bean` | Spring Bean | beanName, beanType, beanScope, isPrimary, isLazy, qualifier, aspectExpressions, advices |
| `ConfigProperty` | 配置属性 | configKey, configType, defaultValue |
| `KafkaConsumer` | Kafka 消费者 | kafkaGroupId, kafkaBootstrapServers |
| `KafkaProducer` | Kafka 生产者 | kafkaBootstrapServers |

## 支持的关系类型

| 关系类型 | 描述 | 属性 |
|---------|------|------|
| `INJECTS_INTO` | 依赖注入 | injectionType, qualifier, isRequired |
| `BINDS_TO` | 配置绑定 | bindingType, prefix |
| `CONSUMES_FROM` | 消费消息 | destination, group |
| `PRODUCES_TO` | 生产消息 | destination |
| `ADVISES` | AOP 通知 | adviceType, methodName, pointcut |
| `TRANSACTIONS` | 事务管理 | - |
| `MANAGES` | 缓存管理 | - |
| `SECURES` | 安全授权 | - |

## 代码实现

### 注解元数据配置

```typescript
interface AnnotationMetadata {
  resultType: string;              // 分析结果类型
  properties?: string[];          // 需要提取的属性列表
  extractProperties?: (args: Record<string, unknown>) => Record<string, unknown>;  // 自定义属性提取器
  createsRelation?: {
    type: RelationshipType;      // 关系类型
    targetType?: 'bean' | 'config' | 'event' | 'cache';  // 目标类型
    targetResolver?: (args: Record<string, unknown>) => string | null;  // 目标解析器
  };
}

const SPRING_ANNOTATIONS: Record<string, AnnotationMetadata> = {
  Transactional: {
    resultType: 'spring.boot.transactional',
    properties: ['propagation', 'isolation', 'timeout', 'readOnly', 'rollbackFor', 'noRollbackFor', 'value'],
    createsRelation: { type: 'TRANSACTIONS', targetType: 'bean' }
  },
  Cacheable: {
    resultType: 'spring.boot.cache',
    properties: ['cacheNames', 'key', 'condition', 'unless', 'value'],
    createsRelation: { type: 'MANAGES', targetType: 'cache' }
  },
  Scheduled: {
    resultType: 'spring.boot.scheduled',
    properties: ['cron', 'fixedDelay', 'fixedDelayString', 'fixedRate', 'fixedRateString', 'initialDelay', 'initialDelayString', 'value']
  },
  Async: {
    resultType: 'spring.boot.async',
    properties: ['value']
  },
  PreAuthorize: {
    resultType: 'spring.boot.security',
    properties: ['value', 'spelRef'],
    createsRelation: { type: 'SECURES' }
  },
  EventListener: {
    resultType: 'spring.boot.event',
    properties: ['value', 'condition', 'classes']
  },
  // AOP 通知
  Before: {
    resultType: 'spring.boot.advice',
    properties: ['pointcut', 'argNames', 'value']
  },
  Around: {
    resultType: 'spring.boot.advice',
    properties: ['pointcut', 'argNames', 'value']
  },
  // ... 其他注解
};
```

### 通用注解处理器

```typescript
private processSpringAnnotation(ann: SpringAnnotation, ctx: AnnotationContext): AnalysisResult | null {
  const meta = SPRING_ANNOTATIONS[ann.name];
  if (!meta) return null;

  const args = ann.arguments || {};
  let properties: Record<string, unknown>;

  if (meta.extractProperties) {
    properties = meta.extractProperties(args);
  } else if (meta.properties) {
    properties = {};
    for (const prop of meta.properties) {
      if (args[prop] !== undefined) {
        properties[prop] = args[prop];
      }
    }
  } else {
    properties = args;
  }

  return {
    type: meta.resultType,
    name: ctx.targetName,
    properties,
    location: {
      filePath: ctx.filePath,
      startLine: ctx.startLine,
      endLine: ctx.endLine
    }
  };
}
```

### 使用示例

```typescript
// 在 analyze 方法中
if (node.type === 'method_definition') {
  const annotations = this.extractAnnotations(methodNode);

  for (const ann of annotations) {
    const result = this.processSpringAnnotation(ann, {
      targetName: methodNode.name?.text || '',
      filePath: context.filePath,
      startLine: methodNode.startLine,
      endLine: methodNode.endLine
    });

    if (result) {
      results.push(result);
    }
  }
}
```

## 如何添加新注解

### 方式一：简单配置（推荐）

只需在 `SPRING_ANNOTATIONS` 中添加配置：

```typescript
const SPRING_ANNOTATIONS: Record<string, AnnotationMetadata> = {
  // ... 现有注解

  // 添加新注解
  MyCustomAnnotation: {
    resultType: 'spring.boot.custom',
    properties: ['param1', 'param2', 'param3'],
    createsRelation: { type: 'CUSTOM_RELATION', targetType: 'bean' }
  }
};
```

### 方式二：自定义属性提取

如果需要复杂的属性提取逻辑：

```typescript
const SPRING_ANNOTATIONS: Record<string, AnnotationMetadata> = {
  MyComplexAnnotation: {
    resultType: 'spring.boot.complex',
    extractProperties: (args) => {
      return {
        expression: args.value,
        timeout: parseInt(args.timeout as string) || 5000,
        retryCount: (args.retries as number) || 3
      };
    },
    createsRelation: { type: 'COMPLEX_RELATION' }
  }
};
```

## Spring 组件识别

插件识别以下 Spring 注解：

- `@Component` → beanType: 'component'
- `@Service` → beanType: 'service'
- `@Repository` → beanType: 'repository'
- `@Controller` → beanType: 'controller'
- `@RestController` → beanType: 'restController'
- `@Configuration` → beanType: 'configuration'
- `@Aspect` → beanType: 'aspect'

## 方法级注解支持

**事务管理：**
- `@Transactional` → spring.boot.transactional

**缓存：**
- `@Cacheable` → spring.boot.cache
- `@CachePut` → spring.boot.cache
- `@CacheEvict` → spring.boot.cache

**定时任务：**
- `@Scheduled` → spring.boot.scheduled

**异步方法：**
- `@Async` → spring.boot.async

**安全授权：**
- `@PreAuthorize` → spring.boot.security
- `@PostAuthorize` → spring.boot.security
- `@Secured` → spring.boot.security

**事件系统：**
- `@EventListener` → spring.boot.event

**AOP 通知：**
- `@Before` → spring.boot.advice
- `@After` → spring.boot.advice
- `@Around` → spring.boot.advice
- `@AfterReturning` → spring.boot.advice
- `@AfterThrowing` → spring.boot.advice

**切入点：**
- `@Pointcut` → spring.boot.pointcut

## 配置文件解析

**YAML 配置 (application.yml)**

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/test
    username: root
  kafka:
    bootstrap-servers: localhost:9092
    consumer:
      group-id: my-group
```

**Properties 配置 (application.properties)**

```properties
spring.datasource.url=jdbc:mysql://localhost:3306/test
spring.datasource.username=root
spring.kafka.bootstrap-servers=localhost:9092
```

## 如何使用

### 1. 构建插件

```bash
cd docs/plugins/examples/spring-boot-plugin
npm install
npm run build
```

### 2. 安装插件

```bash
npm install -g .
```

### 3. 启用插件

```bash
npx gitnexus plugin enable gitnexus-spring-boot-plugin
```

### 4. 分析项目

```bash
npx gitnexus analyze
```

## 工作原理

### 分析流程

1. **解析阶段 (Parse Phase)**
   - 解析 `.yml`/`.yaml` 配置文件，生成 ConfigProperty 节点
   - 解析 `.properties` 配置文件，生成 ConfigProperty 节点
   - 解析 Kafka 配置，生成 KafkaConsumer/KafkaProducer 节点

2. **分析阶段 (Analysis Phase)**
   - 分析 Java 类上的 Spring 注解，识别 Spring Bean 组件
   - 分析方法级注解，使用注册表模式统一处理
   - 提取注入点信息

3. **后处理阶段 (onEnd Hook)**
   - 根据识别的组件生成 Bean 节点
   - 建立 INJECTS_INTO 依赖注入关系
   - 建立 ADVISES AOP 通知关系
   - 将节点和边添加到图中

### Bean 节点 ID 格式

```
bean:{filePath}:{beanName}
```

例如：`bean:/path/to/UserService.java:userService`

### 依赖注入关系

```
Bean:UserRepository --INJECTS_INTO--> Bean:UserService
```

表示 UserService 注入了 UserRepository。

### AOP 通知关系

```
Bean:LoggingAspect --ADVISES--> Bean:UserService
```

表示 LoggingAspect 对 UserService 应用了 AOP 通知。

## 故障排查

### 插件未生效

1. 检查插件是否正确安装：`npx gitnexus plugin list`
2. 检查插件是否启用：`npx gitnexus plugin status gitnexus-spring-boot-plugin`
3. 检查项目路径是否包含 `.java` 文件

### Bean 节点未生成

1. 确保 Java 类上有 Spring 注解（@Component, @Service 等）
2. 检查文件扩展名是否为 `.java`
3. 查看日志确认分析阶段是否执行

### 依赖注入关系缺失

1. 确保被注入的类也有 Spring 注解
2. 检查注入类型是否被支持（目前支持 constructor, field, setter, method）
3. 确认两个 Bean 在同一个分析上下文中

### AOP 关系缺失

1. 确保切面类有 `@Aspect` 注解
2. 检查通知方法是否有正确的 AOP 注解（@Before, @After 等）
3. 确认切入点表达式格式正确
4. 确保目标类也是 Spring Bean

### 新增注解未生效

1. 检查注解是否已在 `SPRING_ANNOTATIONS` 中注册
2. 确认 `resultType` 格式正确
3. 确认 `properties` 列表包含所有需要的属性名

---

**版本**：3.0.0
**最后更新**：2026-04-26
**维护者**：GitNexus 团队
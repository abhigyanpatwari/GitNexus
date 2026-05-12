# GitNexus 插件故障排查指南

本指南帮助您解决插件开发和使用过程中遇到的常见问题。

## 目录

- [插件加载问题](#插件加载问题)
- [解析问题](#解析问题)
- [性能问题](#性能问题)
- [配置问题](#配置问题)
- [调试技巧](#调试技巧)

---

## 插件加载问题

### 1. 插件加载失败

**症状**：
```
Error: Cannot find module 'gitnexus-my-plugin'
```

**可能原因**：
- 插件未正确构建
- 路径不正确
- 依赖缺失

**解决方案**：

```bash
# 1. 确保插件已构建
cd /path/to/your/plugin
npm run build

# 2. 检查路径是否正确
# 使用绝对路径
gitnexus plugin load /absolute/path/to/plugin

# 3. 安装依赖
cd /path/to/your/plugin
npm install
```

### 2. 依赖版本冲突

**症状**：
```
Error: Cannot find module 'gitnexus-shared'
```

**解决方案**：

```bash
# 检查 gitnexus-shared 版本
npm list gitnexus-shared

# 安装正确版本
npm install gitnexus-shared@^1.0.0
```

### 3. TypeScript 编译错误

**症状**：
```
error TS2307: Cannot find module 'gitnexus-shared'
```

**解决方案**：

```json
// tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true
  }
}
```

---

## 解析问题

### 1. 插件不识别文件

**症状**：插件已加载但文件没有被解析

**诊断步骤**：

```bash
# 1. 确认插件支持该文件类型
gitnexus plugin list

# 2. 检查插件状态
gitnexus plugin status
```

**解决方案**：

检查 `supports` 方法：

```typescript
supports(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return this.extensions.includes(`.${ext}`);
}
```

### 2. 解析结果为空

**症状**：`parse` 方法返回空数组

**诊断步骤**：

添加调试日志：

```typescript
async parse(content: string, filePath: string): Promise<ParseResult> {
  console.log('Parsing file:', filePath);
  console.log('Content length:', content.length);
  
  try {
    const result = this.doParse(content, filePath);
    console.log('Parse result:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('Parse error:', error);
    return { nodes: [], edges: [], metadata: {}, error: (error as Error).message };
  }
}
```

### 3. 节点 ID 冲突

**症状**：图中出现重复节点

**解决方案**：使用唯一的节点 ID

```typescript
// 错误示例
const nodeId = `user:${name}`;

// 正确示例
const nodeId = `user:${filePath}:${name}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
```

---

## 性能问题

### 1. 解析大文件超时

**症状**：解析大文件时超时

**解决方案**：

```typescript
async parse(content: string, filePath: string): Promise<ParseResult> {
  // 流式处理大文件
  if (content.length > 1024 * 1024) { // > 1MB
    return this.parseLargeFile(content, filePath);
  }
  return this.parseSmallFile(content, filePath);
}

private async parseLargeFile(content: string, filePath: string): Promise<ParseResult> {
  // 分块处理
  const chunkSize = 64 * 1024; // 64KB
  const chunks = [];
  
  for (let i = 0; i < content.length; i += chunkSize) {
    const chunk = content.slice(i, i + chunkSize);
    const result = this.parseChunk(chunk, filePath, i);
    chunks.push(result);
  }
  
  return this.mergeResults(chunks);
}
```

### 2. 内存使用过高

**症状**：解析后内存持续增长

**解决方案**：

```typescript
class MyPlugin implements ParserPlugin {
  private cache = new Map<string, ParseResult>();
  private maxCacheSize = 100;
  
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const cacheKey = `${filePath}:${content.length}`;
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }
    
    const result = await this.doParse(content, filePath);
    
    // LRU 缓存
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, result);
    
    return result;
  }
  
  async dispose(): Promise<void> {
    this.cache.clear();
  }
}
```

### 3. 重复解析相同文件

**症状**：文件被重复解析

**解决方案**：使用缓存和增量解析

```typescript
class MyPlugin implements ParserPlugin {
  private lastModified = new Map<string, number>();
  
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const stats = fs.statSync(filePath);
    const modified = stats.mtimeMs;
    
    if (this.lastModified.get(filePath) === modified) {
      console.log('File not changed, skipping:', filePath);
      return { nodes: [], edges: [], metadata: { cached: true } };
    }
    
    this.lastModified.set(filePath, modified);
    return this.doParse(content, filePath);
  }
}
```

---

## 配置问题

### 1. 配置文件格式错误

**症状**：
```
SyntaxError: Unexpected token
```

**正确格式**：

```json
{
  "plugins": [
    {
      "name": "gitnexus-my-plugin",
      "enabled": true,
      "config": {
        "strictMode": false
      }
    }
  ]
}
```

### 2. 插件配置不生效

**诊断步骤**：

```bash
# 检查配置文件位置
# 全局: ~/.gitnexus/plugins.json
# 项目级: .gitnexus/plugins.json
```

**解决方案**：

确保配置中的插件名称与实际插件名称匹配：

```typescript
// 插件中的名称
name = 'gitnexus-my-plugin';

// 配置文件中也必须使用这个名称
{
  "name": "gitnexus-my-plugin",
  "enabled": true
}
```

### 3. 环境变量配置

**解决方案**：

```typescript
class MyPlugin implements ParserPlugin {
  private config = {
    apiKey: process.env.MY_PLUGIN_API_KEY,
    debug: process.env.MY_PLUGIN_DEBUG === 'true'
  };
}
```

---

## 调试技巧

### 1. 启用调试模式

```bash
# Linux/macOS
GITNEXUS_DEBUG=1 gitnexus analyze

# Windows (PowerShell)
$env:GITNEXUS_DEBUG=1; gitnexus analyze
```

### 2. 查看详细日志

```bash
# 实时查看日志
tail -f ~/.gitnexus/logs/plugin.log

# 查看最近 100 行
tail -n 100 ~/.gitnexus/logs/plugin.log
```

### 3. 使用 VSCode 调试

创建 `.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Plugin",
      "program": "${workspaceFolder}/node_modules/.bin/gitnexus",
      "args": ["analyze"],
      "env": {
        "GITNEXUS_DEBUG": "1"
      }
    }
  ]
}
```

### 4. 测试单个文件

创建测试脚本 `test-plugin.ts`：

```typescript
import { pluginManager } from './src/core/plugins/index.js';

async function test() {
  // 加载插件
  await pluginManager.loadPlugin({
    pluginPath: './src/plugins/my-plugin'
  });
  
  // 获取解析器
  const parser = pluginManager.parserRegistry.getParser('/path/to/test.file');
  
  if (!parser) {
    console.error('Parser not found!');
    return;
  }
  
  // 解析文件
  const fs = await import('fs');
  const content = fs.readFileSync('/path/to/test.file', 'utf8');
  const result = await parser.parse(content, '/path/to/test.file');
  
  console.log('Parse result:', JSON.stringify(result, null, 2));
}

test().catch(console.error);
```

运行：

```bash
npx ts-node test-plugin.ts
```

### 5. 检查插件状态

```bash
# 列出所有插件
gitnexus plugin list

# 查看详细状态
gitnexus plugin status

# 测试特定文件
gitnexus analyze --verbose --path /path/to/project
```

### 6. 常见错误代码

| 错误代码 | 描述 | 解决方案 |
|---------|------|----------|
| 1001 | 插件加载失败 | 检查依赖和路径 |
| 2001 | 解析错误 | 检查文件格式 |
| 2002 | 不支持的文件类型 | 检查 supports 方法 |
| 3001 | 分析错误 | 检查 AST 结构 |
| 4001 | 处理错误 | 检查处理逻辑 |

---

## 获取帮助

如果以上方法都无法解决您的问题：

1. 查看 [GitHub Issues](https://github.com/gitnexus/gitnexus/issues)
2. 加入 [Discord 社区](https://discord.gg/gitnexus)
3. 发送邮件至 support@gitnexus.io

---

**最后更新**：2026-04-26
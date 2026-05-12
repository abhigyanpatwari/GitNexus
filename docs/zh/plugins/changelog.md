# GitNexus 插件系统更新日志

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-04-26 | 初始版本 |

## v1.0.0 (2026-04-26)

### 新增功能

#### 核心功能
- **插件系统架构**：完整的插件系统，支持解析器、分析器、处理器和集成插件
- **插件管理器**：`PluginManager` 类，管理所有插件的加载、卸载和状态
- **插件注册表**：提供四种注册表（解析器、分析器、处理器、集成）
- **插件钩子系统**：集成到 GitNexus 管道，支持 before/after 钩子

#### 插件类型
- **解析器插件接口** (`ParserPlugin`)
- **分析器插件接口** (`AnalyzerPlugin`)
- **处理器插件接口** (`ProcessorPlugin`)
- **集成插件接口** (`IntegrationPlugin`)

#### CLI 命令
- `gitnexus plugin list` - 列出所有已安装的插件
- `gitnexus plugin load <path>` - 加载插件
- `gitnexus plugin unload <name>` - 卸载插件
- `gitnexus plugin enable <name>` - 启用插件
- `gitnexus plugin disable <name>` - 禁用插件
- `gitnexus plugin status` - 显示插件系统状态
- `gitnexus plugin scan [dir]` - 扫描插件目录

#### 配置文件
- 全局配置：`~/.gitnexus/plugins.json`
- 项目配置：`.gitnexus/plugins.json`

### 文档
- [开发指南](development-guide.md) - 完整的插件开发文档
- [API 参考](api-reference.md) - 详细的 API 接口文档
- [LLM 开发指南](llm-guide.md) - 使用 LLM 辅助开发插件
- [快速开始](quickstart.md) - 5 分钟快速上手
- [故障排查](troubleshooting.md) - 常见问题解答
- [示例插件](examples/) - XML 解析插件和 Spring 分析器插件示例

### 技术实现

#### 核心文件
- `src/core/plugins/types.ts` - 插件类型定义
- `src/core/plugins/plugin-manager.ts` - 插件管理器实现
- `src/core/plugins/plugin-loader.ts` - 插件加载器
- `src/core/plugins/plugin-hooks.ts` - 插件钩子系统
- `src/core/plugins/index.ts` - 插件系统入口
- `src/cli/plugin.ts` - CLI 命令实现

#### 集成点
- 修改 `src/core/ingestion/pipeline.ts`，集成插件钩子

### 示例插件
- **XML 解析插件** (`gitnexus-xml-plugin`)
  - 解析 `.xml` 文件
  - 提取元素、属性和文本内容
  - 生成 CONTAINS、HAS_ATTRIBUTE、HAS_TEXT 边

- **Spring 分析器插件** (`gitnexus-spring-plugin`)
  - 分析 Java 代码中的 Spring 组件
  - 识别 @Controller、@Service、@Repository 等注解
  - 提取组件依赖关系

### 已知限制

1. **性能**：大文件解析可能需要优化
2. **缓存**：尚未实现智能缓存机制
3. **测试**：需要更多集成测试

### 计划中的功能

- [ ] 插件市场
- [ ] 插件自动更新
- [ ] 插件沙箱隔离
- [ ] 可视化插件开发工具
- [ ] 插件性能分析器
- [ ] 更多内置插件

---

## 贡献者

- GitNexus 团队

## 反馈

如果您发现 bug 或有功能建议，请提交到 [GitHub Issues](https://github.com/gitnexus/gitnexus/issues)。
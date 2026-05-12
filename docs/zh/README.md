# GitNexus 文档

欢迎使用 GitNexus 文档！

## 目录结构

```
docs/
├── code-indexing/      # 代码索引相关文档
│   └── cobol/         # COBOL 代码索引详解
├── graph-node/        # 图数据库结构文档
│   └── overview.md    # 图数据模型概述
├── guides/            # 使用指南
│   └── microservices-grpc.md  # 微服务 gRPC 指南
├── plugins/           # 插件系统文档
│   ├── README.md      # 插件系统总览
│   ├── development-guide.md   # 插件开发指南
│   ├── api-reference.md       # 插件 API 参考
│   ├── llm-guide.md          # LLM 辅助开发指南
│   ├── quickstart.md         # 快速开始
│   ├── troubleshooting.md    # 故障排查
│   ├── changelog.md          # 更新日志
│   └── examples/            # 插件示例
│       ├── README.md
│       ├── parser-plugins/   # 解析器插件示例
│       └── analyzer-plugins/ # 分析器插件示例
├── superpowers/       # 高级功能文档
│   └── specs/
│       └── 2026-04-02-pr626-high-fixes-design.md
└── zh/                # 中文文档
    └── graph-node/
        └── overview.md
```

## 快速链接

### 新手入门
- [插件快速开始](plugins/quickstart.md) - 5 分钟创建您的第一个插件

### 插件开发
- [插件开发指南](plugins/development-guide.md) - 完整的插件开发流程
- [API 参考](plugins/api-reference.md) - 详细的 API 文档
- [LLM 开发指南](plugins/llm-guide.md) - 使用 AI 辅助开发

### 高级主题
- [图数据结构](graph-node/overview.md) - 了解 GitNexus 如何构建代码图谱
- [COBOL 索引](code-indexing/cobol/) - 大型机的代码索引方案
- [微服务 gRPC](guides/microservices-grpc.md) - 跨仓库依赖分析

## 最新更新

### v1.0.0 (2026-04-26)

**插件系统发布！**

GitNexus 1.0.0 引入了完整的插件系统，支持：

- 解析器插件：解析特定文件类型（XML、YAML、SQL 等）
- 分析器插件：分析代码语义（Spring、React、TypeScript 等）
- 处理器插件：处理特定阶段的数据
- 集成插件：集成外部工具和服务

详见 [插件系统文档](plugins/README.md)。

## 资源链接

- [GitHub 仓库](https://github.com/gitnexus/gitnexus)
- [插件市场](https://github.com/gitnexus/plugins) (即将推出)
- [Discord 社区](https://discord.gg/gitnexus)
- [问题反馈](https://github.com/gitnexus/gitnexus/issues)

## 语言

- [English](../README.md)
- 简体中文 (当前)

---

**维护者**：GitNexus 团队
**最后更新**：2026-04-26
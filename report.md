# v0.1.0 → v0.1.3 工作汇报

**总览**: 26 个 commits，70 个文件，+5636 / -376 行，周期 2026-06-03 ~ 2026-06-08（6天）。

---

## 一、核心功能：测试覆盖率子系统（全新）

这是 v0.1.1～v0.1.3 的核心交付，从零构建了一个完整的覆盖率采集、存储、查询、可视化闭环。

### 1. 数据层（v0.1.1）

| 模块 | 说明 |
|------|------|
| **Shared 类型** | 新增 `CoverageRun` 节点标签、`COVERED_BY` 关系类型、`coverageRatio`/`hitCount` 等属性 |
| **LadybugDB 持久化** | 新增 `CoverageRun` 节点表 + CSV 写入器 + 适配器支持 |
| **CoverageStore (SQLite)** | 5 张表（runs / line_hits / branch_hits / symbol_coverage / edge_traversal），完整 CRUD |

### 2. 解析与映射层（v0.1.1）

- **4 种解析器**: LCOV（通用）、Go cover、Cobertura XML（Java/Kotlin）、Generic JSON
- **3 种映射器**: LineMapper（行级）、BranchMapper（分支级）、EdgeMapper（边级遍历）

### 3. 摄取管线（v0.1.1～v0.1.2）

| 组件 | 能力 |
|------|------|
| **Ingestor** | 完整摄取管线，解析 → 映射 → 持久化 |
| **Streaming** | 流式摄入，支持大文件实时处理 |
| **Merger** | 多次运行数据合并，支持分支级合并 |
| **GraphBridge** | 覆盖率数据写入 Neo4j 图，与代码图谱关联 |

### 4. CLI 命令组（v0.1.1～v0.1.2）

```
gitnexus coverage import   # 导入覆盖率文件
gitnexus coverage stream   # 流式导入
gitnexus coverage list     # 列出所有运行
gitnexus coverage show     # 查看运行详情
gitnexus coverage diff     # 对比两次运行
gitnexus coverage merge    # 合并运行
gitnexus coverage rm       # 删除运行
```
完整 i18n 支持（英文/中文）。

### 5. MCP 工具（v0.1.1～v0.1.2）

- 新增 `coverage_status` 工具 — 查询当前覆盖率概览
- 新增 `coverage_diff` 工具 — 对比两次覆盖率运行
- `context` / `impact` / `detect_changes` 工具增强 — 输出中融合覆盖率数据

### 6. HTTP API 端点（v0.1.3）

- `GET /api/coverage/status` — 覆盖率概览
- `GET /api/coverage/runs` — 运行列表
- `GET /api/coverage/diff` — 运行对比

### 7. Web UI 可视化闭环（v0.1.3）

| 功能 | 说明 |
|------|------|
| **图热力图** | GraphCanvas 中开启"覆盖率模式"，节点按覆盖率着色（绿/黄/红/灰） |
| **CoveragePanel** | 右侧面板新增 Coverage 标签页 — 总览进度条、运行列表、Top 未覆盖符号（可点击定位）、Diff 对比 |
| **ProcessFlowModal 叠加** | 执行流弹窗中显示步骤级覆盖率摘要条 |

### 8. 测试（全周期）

- **15 个覆盖率测试文件**: 覆盖 store、parsers、mappers、ingestor、streaming、merger、graph-bridge、CLI、HTTP API、coverage-colors
- **全量测试**: 10,671 通过，零回归

---

## 二、架构总览

```
                          ┌──────────────────────────────┐
  LCOV / Go / Cobertura ──┤  Parsers (4种)               │
  Generic JSON         ──┤                              │
                          └──────────┬───────────────────┘
                                     ▼
                          ┌──────────────────────────────┐
                          │  Mappers (Line/Branch/Edge)  │
                          └──────────┬───────────────────┘
                                     ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                    Ingestion Pipeline                        │
  │  Ingestor ──► Streaming ──► Merger ──► GraphBridge          │
  └──────────┬──────────────────────────────────────┬───────────┘
             ▼                                      ▼
  ┌──────────────────┐                   ┌──────────────────────┐
  │  CoverageStore   │                   │  LadybugDB (图数据库) │
  │  (SQLite, 5表)   │                   │  COVERED_BY 关系      │
  └────────┬─────────┘                   └──────────┬───────────┘
           │                                        │
           ▼                                        ▼
  ┌──────────────────┐                   ┌──────────────────────┐
  │  CLI / MCP /     │◄──────────────────│  代码图谱关联查询     │
  │  HTTP API        │                   │                      │
  └────────┬─────────┘                   └──────────────────────┘
           │
           ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    Web UI 可视化                              │
  │  GraphCanvas 热力图 │ CoveragePanel │ ProcessFlowModal 叠加  │
  └──────────────────────────────────────────────────────────────┘
```

---

## 三、技术亮点

- **对现有系统零侵入**: 覆盖率作为独立子系统，不修改现有摄取管线核心代码
- **多格式解析器**: 支持 C/C++/Go/Java/Kotlin/JavaScript 等主流语言的覆盖率工具输出
- **流式处理**: 支持大体积覆盖率文件（百万行级）的流式摄入
- **全链路闭环**: CLI → MCP → HTTP API → Web UI，每一层都可以独立获取覆盖率数据
- **GitNexus 特色**: 覆盖率数据与代码图谱深度整合，支持符号级、文件级、进程级的覆盖分析

---

## 四、关键文件索引

### 后端新增/修改

| 文件 | 说明 |
|------|------|
| `gitnexus/src/core/coverage/types.ts` | 核心类型定义（CanonicalCoverage, CoverageRunRecord 等 10+ 接口） |
| `gitnexus/src/core/coverage/store.ts` | CoverageStore — SQLite 5表存储，完整 CRUD |
| `gitnexus/src/core/coverage/parsers/` | LCOV / Go / Cobertura / Generic JSON 解析器 |
| `gitnexus/src/core/coverage/mappers/` | LineMapper / BranchMapper / EdgeMapper |
| `gitnexus/src/core/coverage/ingestor.ts` | 完整摄取管线 |
| `gitnexus/src/core/coverage/streaming.ts` | 流式摄入 |
| `gitnexus/src/core/coverage/merger.ts` | 多次运行合并 |
| `gitnexus/src/core/coverage/graph-bridge.ts` | 图数据库桥接 |
| `gitnexus/src/cli/coverage.ts` | CLI 命令组（import/stream/list/show/diff/merge/rm） |
| `gitnexus/src/mcp/local/local-backend.ts` | MCP 工具 + 公共方法 |
| `gitnexus/src/mcp/tools.ts` | coverage_status / coverage_diff 工具定义 |
| `gitnexus/src/mcp/resources.ts` | coverage 资源模板 |
| `gitnexus/src/server/api.ts` | HTTP API 端点 |

### Web UI 新增/修改

| 文件 | 说明 |
|------|------|
| `gitnexus-web/src/services/backend-client.ts` | 覆盖率 API 客户端（类型 + 3 个 fetch 函数） |
| `gitnexus-web/src/lib/coverage-colors.ts` | 覆盖率着色函数 |
| `gitnexus-web/src/lib/graph-adapter.ts` | SigmaNodeAttributes 扩展 |
| `gitnexus-web/src/hooks/useSigma.ts` | 覆盖率模式 nodeReducer |
| `gitnexus-web/src/hooks/useAppState.tsx` | coverageMode 状态 |
| `gitnexus-web/src/hooks/app-state/graph.tsx` | coverageMode 上下文 |
| `gitnexus-web/src/components/GraphCanvas.tsx` | 覆盖率切换按钮 |
| `gitnexus-web/src/components/CoveragePanel.tsx` | 覆盖率面板（新建） |
| `gitnexus-web/src/components/RightPanel.tsx` | Coverage 标签页 |
| `gitnexus-web/src/components/ProcessFlowModal.tsx` | 覆盖率摘要条 |
| `gitnexus-web/src/components/ProcessesPanel.tsx` | 步骤覆盖率富化 |
| `gitnexus-web/src/lib/mermaid-generator.ts` | ProcessStep 扩展 |

### 测试文件

| 文件 | 测试类型 |
|------|----------|
| `gitnexus/test/unit/coverage-store.test.ts` | 存储 |
| `gitnexus/test/unit/coverage-lcov-parser.test.ts` | LCOV 解析 |
| `gitnexus/test/unit/coverage-go-parser.test.ts` | Go 解析 |
| `gitnexus/test/unit/coverage-cobertura-parser.test.ts` | Cobertura 解析 |
| `gitnexus/test/unit/coverage-generic-parser.test.ts` | Generic JSON 解析 |
| `gitnexus/test/unit/coverage-line-mapper.test.ts` | 行映射 |
| `gitnexus/test/unit/coverage-branch-mapper.test.ts` | 分支映射 |
| `gitnexus/test/unit/coverage-edge-mapper.test.ts` | 边映射 |
| `gitnexus/test/unit/coverage-streaming.test.ts` | 流式处理 |
| `gitnexus/test/unit/coverage-merger.test.ts` | 合并 |
| `gitnexus/test/unit/coverage-graph-bridge.test.ts` | 图桥接 |
| `gitnexus/test/integration/coverage-ingestor.test.ts` | 摄取管线 |
| `gitnexus/test/integration/coverage-cli.test.ts` | CLI 烟雾测试 |
| `gitnexus/test/integration/coverage-api.test.ts` | HTTP API 集成测试 |
| `gitnexus-web/test/lib/coverage-colors.test.ts` | 着色函数单元测试 |

### Shared 层

| 文件 | 说明 |
|------|------|
| `gitnexus-shared/src/graph/types.ts` | coverageRatio / lastCoveredAt / hitCount 等属性 |
| `gitnexus-shared/src/lbug/schema-constants.ts` | CoverageRun 表名 |

---

## 五、Commit 时间线

| 日期 | Commits | 内容 |
|------|---------|------|
| 2026-06-03 | 11 | 数据层 + 解析映射层 + 摄取管线 + CLI + MCP 工具 + 基础测试 |
| 2026-06-05 | 4 | 分支覆盖率 + 图持久化修复 + 流式增强 |
| 2026-06-08 | 11 | MCP 集成增强 + Cobertura 解析器 + i18n + 测试补全 + 可视化闭环 |

---

*报告生成于 2026-06-08，分支 v0.1.3，基线 main。*
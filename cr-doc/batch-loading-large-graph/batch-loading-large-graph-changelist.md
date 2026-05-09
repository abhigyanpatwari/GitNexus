# 大型图谱分批加载 - 变更清单

## 变更概述

本次需求实现了大型图谱的智能分批加载机制，当边数超过 100,000 时自动切换为分批加载模式，优化了大型项目的加载性能和用户体验。

---

## 变更文件清单

### 服务器端（gitnexus）

#### 1. `gitnexus/src/server/api.ts`
**变更类型**：新增功能

**新增接口**：
- `GET /api/edges/count` - 获取边总数
  - 参数：`repo` (可选)
  - 返回：`{ total: number, repoName: string }`
  
- `GET /api/edges` - 分页获取边数据
  - 参数：`repo` (可选), `offset` (默认0), `limit` (默认1000，最大100000)
  - 返回：`{ edges: [], nodes: [], hasMore: boolean, nextOffset: number }`

**实现要点**：
- 使用 Cypher `ORDER BY sourceId, targetId, type` 确保稳定排序
- 批量查询涉及节点，避免 N+1 问题
- 支持所有节点类型（File, Function, Class, etc.）
- 边数据包含完整关系信息（type, confidence, reason, step）

**代码行数**：~150 行新增

---

### 前端（gitnexus-web）

#### 2. `gitnexus-web/src/services/server-connection.ts`
**变更类型**：功能增强

**新增接口**：
- `BatchInfo` - 批次信息类型定义

**新增函数**：
- `fetchEdgesCount(baseUrl, repoName?)` - 获取边统计
- `fetchEdgesBatch(baseUrl, offset, limit, repoName?, signal?)` - 分批获取边数据

**修改函数**：
- `connectToServer()` - 增加分批加载逻辑
  - 新增 `batchInfo?: BatchInfo` 参数
  - 判断边数：≤ 100,000 全量加载，> 100,000 分批加载
  - 使用 `Map<id, node>` 自动去重节点
  - 每批之间 10ms 延迟让出事件循环

**代码行数**：~85 行新增

---

#### 3. `gitnexus-web/src/types/pipeline.ts`
**变更类型**：类型扩展

**修改接口**：
- `PipelineProgress` - 新增 `batchInfo` 字段
  ```typescript
  batchInfo?: {
    currentBatch: number;
    totalBatches: number;
    batchPhase: 'fetching' | 'merging' | 'rendering';
  }
  ```

**代码行数**：~6 行新增

---

#### 4. `gitnexus-web/src/components/LoadingOverlay.tsx`
**变更类型**：UI 增强

**新增功能**：
- 批次进度展示：`Batch X / Y`
- 批次阶段状态：`Fetching edges...` / `Merging data...` / `Rendering...`
- 动画脉冲效果

**代码行数**：~16 行新增

---

#### 5. `gitnexus-web/src/App.tsx`
**变更类型**：功能增强

**修改函数**：
- `autoConnect()` 中的进度回调
  - 新增 `batchInfo` 参数处理
  - 区分全量加载 / 分批加载模式
  - 显示不同的进度消息

**代码行数**：~14 行修改

---

## 变更统计

- **新增文件**: 0 个
- **修改文件**: 5 个
- **删除文件**: 0 个
- **总变更行数**: ~271 行

---

## 技术要点

### 1. 智能阈值判断
- 边数 ≤ 100,000：保持全量加载
- 边数 > 100,000：自动分批加载

### 2. 节点去重机制
- 使用 `Map<id, node>` 结构
- O(1) 复杂度的去重查询
- 自动合并多批次节点

### 3. 稳定分页
- 使用 Cypher `ORDER BY sourceId, targetId, type`
- 避免分页结果重复或遗漏

### 4. 进度反馈
- 批次级别进度：当前批次/总批次
- 阶段级别进度：Fetching / Merging / Rendering
- 百分比进度：基于已处理边数

---

## 向后兼容性

✅ **完全兼容**：
- 小型项目（边数 < 100,000）保持原有加载流程
- API 接口向后兼容
- UI 展示在两种模式下都正常

---

## 性能优化

1. **内存优化**：
   - 使用 Map 去重，不额外缓存
   - 每批处理后立即合并
   
2. **网络优化**：
   - 批量查询节点，避免 N+1
   - 保持 HTTP keep-alive

3. **UI 流畅性**：
   - 每批之间 10ms 延迟让出事件循环
   - 进度条平滑过渡

---

## 已知限制

1. **深分页性能**：SKIP 在大偏移量时性能下降
2. **文件内容重复**：File 节点 content 可能在多批次中重复传输

---

## 后续优化方向

- [ ] 游标分页替代深 SKIP
- [ ] File content 按需加载
- [ ] 支持断点续传
- [ ] 增量更新

---

**最后更新**: （待实现完成后更新）

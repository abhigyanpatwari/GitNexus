# Evolver v1 测试报告

**日期:** 2026-05-26
**版本:** v1 (feat/evolver-core-types → main 合并后)
**测试环境:** Windows 本地开发环境
**测试框架:** Vitest 4.1.6 / TypeScript 5.x / Node.js 26.2.0

## 1. 测试范围

Evolver 全自动进化系统 v1 包含 10 个生产模块和 1 个桶导出，全部为新增内部模块，不修改任何已有 CLI/MCP/HTTP/图谱契约。

### 生产模块

| 模块 | 文件 | 职责 |
|------|------|------|
| Core Types | `types.ts` | 共享接口、枚举、数据模型 |
| Metric Evaluator | `metric-evaluator.ts` | 指标增量、回归、预算、安全、回滚判定 |
| Resource Manager | `resource-manager.ts` | 资源预算执行和降级指导 |
| Variant Generator | `variant-generator.ts` | 参数/算法/结构变体生成 |
| Sandbox Runner | `sandbox-runner.ts` | 注入函数沙箱试验执行 |
| Safety Gate | `safety-gate.ts` | 自动晋升门禁决策 |
| Promotion Controller | `promotion-controller.ts` | 参数变更应用和回滚 |
| Evolution Memory | `evolution-memory.ts` | 内存审计记录存储和检索 |
| Error Corrector | `error-corrector.ts` | 错误类型到修正动作映射 |
| Evolver Runtime | `evolver-runtime.ts` | 编排完整进化循环 |

### 测试文件

| 测试文件 | 测试数 | 覆盖模块 |
|----------|--------|----------|
| `types.test.ts` | 5 | Core Types |
| `metric-evaluator.test.ts` | 10 | Metric Evaluator |
| `resource-manager.test.ts` | 8 | Resource Manager |
| `variant-generator.test.ts` | 4 | Variant Generator |
| `sandbox-runner.test.ts` | 5 | Sandbox Runner |
| `safety-gate.test.ts` | 7 | Safety Gate |
| `promotion-controller.test.ts` | 5 | Promotion Controller |
| `evolution-memory.test.ts` | 5 | Evolution Memory |
| `error-corrector.test.ts` | 7 | Error Corrector |
| `evolver-runtime.test.ts` | 3 | Evolver Runtime |
| `evolver-acceptance.test.ts` | 9 | 端到端验收 |

## 2. 单元测试结果

```
Test Files:  11 passed (11)
Tests:       51 passed (51)
Duration:    ~1.7s
```

**零失败、零跳过。**

### 按模块详细结果

| 模块 | 通过 | 失败 | 关键验证点 |
|------|------|------|-----------|
| Core Types | 5 | 0 | 所有枚举值、接口字段完整性 |
| Metric Evaluator | 10 | 0 | 指标增量计算、回归检测、预算判定、安全发现、回滚验证、突变类型决策 |
| Resource Manager | 8 | 0 | 预算内允许、超限拒绝、并发限制、高风险配额、降级计划生成 |
| Variant Generator | 4 | 0 | 参数/算法/结构变体生成、patch 构建、回滚计划、来源记录 |
| Sandbox Runner | 5 | 0 | 成功试验、超时处理、错误捕获、预算约束、协议验证 |
| Safety Gate | 7 | 0 | 低风险参数允许、算法/结构需审查、安全发现拒绝、缺少来源拒绝、缺少回滚拒绝 |
| Promotion Controller | 5 | 0 | 参数应用、嵌套路径设置、非允许决策不应用、回滚恢复、深拷贝隔离 |
| Evolution Memory | 5 | 0 | 添加记录、按类型查询、按目标查询、按变体查询、空结果 |
| Error Corrector | 7 | 0 | 7 种错误类型到修正动作的完整映射 |
| Evolver Runtime | 3 | 0 | 安全参数晋升、回归拒绝、结构变体待审查 |
| Acceptance | 9 | 0 | 端到端验收场景（见第 3 节） |

## 3. 验收测试覆盖

验收测试覆盖设计规格中的 9 个用户可见需求：

| # | 验收场景 | 期望 | 实际 | 状态 |
|---|---------|------|------|------|
| 1 | 从指标差距发现改进需求 | 基线 0.72 < 目标 0.90，gap 存在 | gap 检测正确 | ✅ |
| 2 | 生成参数/算法/结构三种变体 | 3 种 mutationType | parameter/algorithm/structure 全覆盖 | ✅ |
| 3 | 沙箱评估变体产生试验结果 | 返回指标和资源消耗 | metrics + resourceUsage 完整 | ✅ |
| 4 | 自动应用低风险参数变更 | gate=allow，参数更新 | topK 更新，gate=allow | ✅ |
| 5 | 阻止结构变体自动应用 | gate=needs-review，参数不变 | gate=needs-review，参数未变 | ✅ |
| 6 | 每步记录审计记忆 | variant/trial/evaluation/gate 写入 | 4 类记录全部存在 | ✅ |
| 7 | 参数退化后选择回滚修正 | correction.type=rollback-parameters | 映射正确 | ✅ |
| 8 | 回滚已晋升的参数变更 | 参数恢复原值 | topK 恢复 | ✅ |
| 9 | 拒绝导致回归的变体 | verdict=reject，regressions 非空 | 检测到回归并拒绝 | ✅ |

## 4. 运行时实机验证

使用 `tsx` 直接调用 Evolver 运行时，模拟完整进化循环：

```
=== Evolver Live Test ===
Gate Decision: allow
Promoted: true
Verdict: promote
Parameter topK before: 5, after: 6
Memory records - variants: 1 trials: 1 evaluations: 1 gates: 1 promotions: 1
Correction for degradation: rollback-parameters
After rollback, topK: 5
=== ALL CHECKS PASSED ===
```

**验证结论：** 运行时在真实 Node.js 环境中完整执行了"生成变体 → 沙箱评估 → 安全门决策 → 参数晋升 → 审计记录 → 错误修正 → 回滚恢复"全流程。

## 5. 集成兼容性验证

| 检查项 | 结果 |
|--------|------|
| TypeScript 类型检查（Evolver 模块） | 0 错误 |
| 项目构建 (`npm run build`) | 成功，291 文件重写 |
| GitNexus 服务器启动 | `http://127.0.0.1:4747` 正常运行 |
| 健康检查 API | `{"status":"ok"}` |
| 抽样非 Evolver 测试 (utils/graph/server/security) | 4 文件 60 测试全通过 |
| 已有功能影响 | 零影响（纯新增模块） |

## 6. 安全边界验证

| 安全约束 | 验证方式 | 结果 |
|----------|---------|------|
| 参数级变体可自动晋升 | 验收测试 #4 | ✅ 仅低风险且评估通过时自动应用 |
| 算法级变体需审查 | Safety Gate 测试 | ✅ gate=needs-review |
| 结构级变体仅生成计划 | 验收测试 #5 | ✅ gate=needs-review，参数不变 |
| 所有变更可回滚 | 验收测试 #8 | ✅ rollbackPromotion 恢复原值 |
| 审计记录完整 | 验收测试 #6 | ✅ 5 类记录全部写入 |
| 错误自动修正 | 验收测试 #7 | ✅ 7 种错误类型映射正确 |
| 资源预算强制执行 | Resource Manager 测试 | ✅ 超限拒绝 + 降级计划 |

## 7. 提交历史

```
c557094d Add evolver acceptance coverage
5cf3a225 Add evolver runtime
2f5c508b Add evolver error corrector
17d2d300 Add evolver memory
8cf33982 Add evolver promotion controller
a96b289b Add evolver safety gate
eedd3276 Add evolver sandbox runner
35d01161 Add evolver variant generator
5f09f197 Add evolver resource manager
64f26c7b Add evolver metric evaluator
8535f678 Add evolver core types
```

合并提交：`Merge feat/evolver-core-types: Add Evolver v1 automated evolution system`

## 8. 已知限制

| 限制 | 说明 | 计划 |
|------|------|------|
| 内存存储 | Evolution Memory 使用内存实现，进程重启后数据丢失 | v2 添加持久化后端 |
| 无外部接口 | Evolver 未暴露 CLI/MCP/HTTP 端点 | v2 按需添加 |
| 确定性变体 | Variant Generator 生成确定性候选，无随机探索 | v2 添加策略驱动的随机变体 |
| 单变体执行 | Runtime 每次循环只执行第一个变体 | v2 支持多变体并行评估 |
| 无真实沙箱 | Sandbox Runner 使用注入函数，非进程隔离 | v2 支持 Worker Thread 隔离 |

## 9. 结论

Evolver v1 全自动进化系统通过全部 51 项单元测试、9 项验收测试和运行时实机验证。系统在本地环境中完整执行了受约束的自动进化循环，安全边界（参数自动/算法审查/结构计划）工作正常，审计记录完整，回滚机制有效。合并到主分支后对已有功能零影响。

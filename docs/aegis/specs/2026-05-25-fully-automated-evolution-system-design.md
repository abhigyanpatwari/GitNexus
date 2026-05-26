# 全自动进化系统设计

**日期:** 2026-05-25
**状态:** 待评审草案
**项目上下文:** GitNexus monorepo
**设计目标:** 在不越过安全边界的前提下，定义一个能自我学习、自我优化、自我迭代的本地自治系统

## 结论

本设计提出 **Evolver**：一个受约束的全自动进化系统。它不会直接做无边界的自我改写，而是通过“目标设定 -> 环境感知 -> 候选变体生成 -> 沙箱评估 -> 资源约束判断 -> 安全发布 -> 运行监测 -> 错误修正”的循环持续提升性能。

Evolver 的核心不是让系统任意修改自己，而是让它在可审计、可回滚、可度量的范围内自动提出改进、验证改进、应用低风险改进，并把高风险改进转成待审批计划。

## 任务意图草案

**结果:** 设计一个具备自我学习、自我优化、自我迭代能力的系统规格。

**目标:** 让系统能根据预设目标和环境变化自动调整结构、算法和参数，并持续提升性能。

**成功证据:** 规格中定义进化指标、学习模块、资源管理、错误修正、评估协议、安全边界和验收标准。

**停止条件:** 形成可评审设计规格，暂不进入实现。

**非目标:** 不允许无人确认地修改生产环境、推送代码、变更权限、删除数据、发送外部通信或绕过安全检查。

**范围:** 新的本地自治运行时，可作为上一个 Aletheia 主动学习系统的上层进化控制器。

**风险:** 指标被钻空子、资源耗尽、错误自我放大、不安全自我修改、评估样本污染、回滚失败、过度适配短期任务。

## 基线读取提示

- `AGENTS.md` 约束读写执行范围，禁止触碰真实密钥和生产凭据。
- `GUARDRAILS.md` 要求最小权限、保护秘密、执行影响分析、避免破坏性操作。
- `docs/aegis/baseline/2026-05-25-initial-baseline.md` 记录当前项目结构、契约和兼容边界。
- `docs/aegis/specs/2026-05-25-automated-active-learning-agent-design.md` 已定义主动学习、记忆保留和知识应用运行时。

## 影响说明草案

**受影响层:** 当前只新增设计文档。未来实现会新增本地进化控制器、评估器、沙箱执行器、资源预算器、变体注册表和错误修正模块。

**所有者:** Evolver 拥有进化策略、指标评估、变体生命周期和自动发布门禁。Aletheia 拥有主动学习和知识记忆。GitNexus 图谱仍拥有代码结构事实。

**不变量:** 所有自动改动必须可追踪、可评估、可回滚。未经确认不能改生产环境、不能推送到主分支、不能删除用户数据、不能绕过安全检查。

**兼容边界:** 初版不修改现有 CLI、MCP、HTTP、图谱 schema 和 Web UI 行为。

## 产品风险视角

- **价值:** 系统能把失败、环境变化和性能下降转化为自动改进任务，减少人工维护成本。
- **非目标:** 它不是无限权限的自我改写程序，也不是自动发布生产变更的机器人。
- **取舍:** 自动程度越高，越需要强评估、沙箱、预算和回滚；完全放开权限会让系统变得不可控。
- **决策点:** 首版应选择“受约束进化”，而不是“任意自我修改”。

## 基本原则审查

**不可压缩目标:** 系统必须在无人持续操作下提升预设指标，并在环境变化时恢复或提高任务表现。

**不可破坏约束:** 安全边界、资源预算、评估证据、可回滚性、审计日志、生产变更审批。

**应删除的假设:** 自我修改不等于进化。更多模型调用不等于更优。短期指标提升不等于长期稳定。

**最小可行路径:** 先做参数和策略级进化，再做算法组合级进化，最后才考虑结构级变更。

**升级信号:** 若需要修改公共契约、长期存储 schema、权限模型或生产发布流程，必须另写 ADR。

## 架构选项

### 方案 A：完全自修改系统

系统可直接改自身源码、重启自身并发布新版本。

**优点:** 自动程度最高，理论上适应性强。

**缺点:** 风险最高，评估和回滚复杂，容易出现不可控行为，不符合当前安全边界。

**结论:** 拒绝作为首版方向。

### 方案 B：受约束进化控制器

系统在沙箱中生成变体，使用评估器比较基线和候选，低风险参数变更可自动应用，高风险结构变更生成计划等待确认。

**优点:** 可审计、可回滚、可测试，符合本地开发安全边界。

**缺点:** 自动程度不如方案 A，结构级进化需要审批。

**结论:** 推荐。

### 方案 C：只做外部调参器

系统只调整配置、提示词、检索参数和预算，不生成结构或算法变体。

**优点:** 风险低，实现快。

**缺点:** 不能满足“调整结构、算法和参数”的完整要求。

**结论:** 可作为里程碑 1，但不能作为完整目标。

## 推荐架构

```text
Preset Goals
  -> Environment Observer
  -> Baseline Profiler
  -> Evolution Planner
  -> Variant Generator
  -> Sandbox Runner
  -> Metric Evaluator
  -> Resource Manager
  -> Safety Gate
  -> Promotion Controller
  -> Runtime Monitor
  -> Error Corrector
  -> Evolution Memory
```

## 核心模块

| 模块 | 职责 | 输入 | 输出 |
|------|------|------|------|
| Goal Registry | 保存预设目标、约束和优先级 | 用户目标、系统目标 | GoalSpec |
| Environment Observer | 监测任务、数据、依赖、性能和错误变化 | 日志、指标、任务结果 | EnvironmentSnapshot |
| Baseline Profiler | 建立当前版本表现基线 | 运行记录、基准测试 | BaselineProfile |
| Evolution Planner | 选择要优化的目标和路径 | GoalSpec、环境快照、基线 | EvolutionPlan |
| Variant Generator | 生成参数、算法和结构候选变体 | 计划、知识、历史结果 | VariantSet |
| Sandbox Runner | 在隔离环境执行候选变体 | 变体、测试、预算 | TrialResult |
| Metric Evaluator | 比较候选和基线表现 | TrialResult、指标定义 | EvaluationReport |
| Resource Manager | 控制算力、时间、费用和并发 | 预算、队列、风险 | ResourceDecision |
| Safety Gate | 判断是否允许自动应用 | 评估报告、风险策略 | GateDecision |
| Promotion Controller | 应用低风险变更并保留回滚点 | GateDecision、变体 | PromotionRecord |
| Runtime Monitor | 监测发布后的真实表现 | 运行指标、错误 | DriftSignal |
| Error Corrector | 自动隔离、回滚、重试或生成修复变体 | 错误、回归信号 | CorrectionAction |
| Evolution Memory | 保存变体、实验、失败原因和成功策略 | 全部运行痕迹 | 可检索演化知识 |

## 进化对象

Evolver 将进化对象分成三类，风险从低到高递增。

| 类型 | 示例 | 自动应用规则 |
|------|------|--------------|
| 参数级 | 阈值、权重、检索数量、超时、重试次数、预算分配 | 指标显著提升且安全测试通过即可自动应用 |
| 算法级 | 排序函数、候选选择策略、错误分类策略、资源调度策略 | 必须通过回归测试、对照评估和回滚演练 |
| 结构级 | 模块增删、契约调整、持久化结构、执行流程变化 | 只能生成计划和补丁候选，等待人工确认 |

## 进化指标体系

### 主指标

| 指标 | 含义 | 方向 |
|------|------|------|
| task_success_rate | 任务成功率 | 越高越好 |
| quality_score | 输出质量评分 | 越高越好 |
| adaptation_latency | 环境变化后恢复到目标表现的耗时 | 越低越好 |
| regression_rate | 新变体导致旧任务失败的比例 | 越低越好 |
| resource_efficiency | 单位资源产出的有效结果 | 越高越好 |
| error_recovery_rate | 错误自动修正成功比例 | 越高越好 |

### 安全指标

| 指标 | 失败条件 |
|------|----------|
| budget_violation_count | 超出资源预算 |
| unsafe_action_attempts | 尝试执行被禁止动作 |
| rollback_failure_count | 回滚失败 |
| provenance_gap_count | 变体缺少来源或评估记录 |
| approval_bypass_count | 高风险变更试图绕过确认 |

### 进化判定

候选变体必须同时满足：

```text
primary_metric_delta > configured_min_gain
regression_rate <= configured_regression_limit
resource_cost <= configured_budget
safety_metric_failures == 0
rollback_test == passed
```

## 数据模型

```typescript
export interface GoalSpec {
  id: string;
  name: string;
  objective: string;
  priority: number;
  targetMetrics: MetricTarget[];
  constraints: EvolutionConstraint[];
  stopConditions: string[];
}

export interface EnvironmentSnapshot {
  id: string;
  capturedAt: string;
  signals: EnvironmentSignal[];
  performance: MetricReading[];
  errors: ErrorEvent[];
  resourceUsage: ResourceUsage;
}

export interface EvolutionPlan {
  id: string;
  goalId: string;
  hypothesis: string;
  targetObject: EvolutionTarget;
  allowedMutationTypes: MutationType[];
  evaluationProtocolId: string;
  resourceBudget: ResourceBudget;
}

export interface VariantSpec {
  id: string;
  planId: string;
  mutationType: 'parameter' | 'algorithm' | 'structure';
  description: string;
  patch: VariantPatch;
  expectedGain: MetricExpectation[];
  riskLevel: 'low' | 'medium' | 'high';
  rollbackPlan: RollbackPlan;
  provenance: VariantProvenance[];
}

export interface EvaluationReport {
  id: string;
  variantId: string;
  baselineId: string;
  metricDeltas: MetricDelta[];
  regressions: RegressionFinding[];
  resourceCost: ResourceUsage;
  safetyFindings: SafetyFinding[];
  verdict: 'promote' | 'reject' | 'needs-review';
}
```

## 自适应学习模块

自适应学习模块负责把经验转成下一轮进化的选择偏好。

| 子模块 | 作用 |
|--------|------|
| Strategy Learner | 学习哪些变体生成策略更可能成功 |
| Failure Classifier | 把失败分为数据变化、资源不足、算法缺陷、评估缺陷和外部依赖变化 |
| Environment Pattern Miner | 识别环境变化模式，例如输入分布变化或依赖延迟升高 |
| Policy Optimizer | 调整探索与利用比例，避免只试熟悉方案 |
| Knowledge Retriever | 从 Evolution Memory 和 Aletheia 记忆中取回相关经验 |

学习策略采用保守升级：先更新候选排序权重，再更新变体生成模板，最后才建议结构级变更。

## 资源管理组件

资源管理器负责防止自动进化消耗无限资源。

| 资源 | 控制方式 |
|------|----------|
| 时间 | 每轮、每天、每目标最大运行时间 |
| 算力 | 并发上限、沙箱上限、CPU/内存上限 |
| 费用 | LLM 调用预算、外部 API 预算 |
| 存储 | 实验记录保留策略、旧变体压缩 |
| 风险 | 高风险变体数量上限、失败熔断 |

资源不足时，系统按优先级降级：减少候选数量、缩小评估集、延后低优先级目标、停止新探索、只保留错误修正。

## 错误修正功能

错误修正模块不是简单重试，而是先定位错误类别，再选择修正动作。

| 错误类型 | 自动动作 |
|----------|----------|
| 临时失败 | 指数退避重试 |
| 参数退化 | 回滚到上一个稳定参数集 |
| 算法回归 | 禁用候选变体并生成失败记忆 |
| 结构风险 | 停止自动应用，生成待审计划 |
| 资源耗尽 | 降低预算或暂停低优先级任务 |
| 评估失真 | 冻结晋升，重新采样评估集 |
| 安全边界触发 | 立即停止该进化计划并记录审计事件 |

## 自动进化循环

```text
1. 读取目标和当前指标
2. 观察环境变化和错误信号
3. 判断是否需要进化
4. 生成一个或多个改进假设
5. 生成候选变体
6. 在沙箱中运行评估协议
7. 比较候选和基线
8. 检查资源、安全和回滚条件
9. 自动应用低风险通过项
10. 监测真实运行表现
11. 发现退化时自动回滚或修正
12. 记录经验并更新下一轮策略
```

## 安全门禁

| 门禁 | 规则 |
|------|------|
| 权限门禁 | 禁止生产配置、权限、外部通信和数据库写入的无人变更 |
| 资源门禁 | 超预算立即停止候选评估 |
| 回归门禁 | 任一关键回归超过阈值则拒绝晋升 |
| 来源门禁 | 无来源、无评估或无回滚计划的变体不得晋升 |
| 风险门禁 | 结构级变更只能输出计划，不能自动应用 |
| 回滚门禁 | 回滚演练失败时不得晋升 |

## 与 Aletheia 的关系

Evolver 是进化控制层，Aletheia 是学习和知识层。

| 能力 | Aletheia | Evolver |
|------|----------|---------|
| 主动发现知识缺口 | 是 | 使用其结果 |
| 存储事实和流程记忆 | 是 | 存储进化实验记忆 |
| 生成候选改进 | 可提供知识 | 是 |
| 评估候选变体 | 否 | 是 |
| 自动应用低风险改进 | 否 | 是 |
| 回滚和错误修正 | 部分 | 是 |

## 开发里程碑

### 里程碑 0：规格和边界

- 完成本文档评审。
- 确认 Evolver 是否作为 Aletheia 上层模块实现。
- 确认首版只允许参数级自动应用。

**退出标准:** 规格获批，进入实现计划。

### 里程碑 1：指标和基线系统

- 定义 GoalSpec、MetricTarget、BaselineProfile。
- 实现基线采集和指标比较。
- 使用固定测试数据验证指标计算。

**退出标准:** 可以稳定判断候选是否优于基线。

### 里程碑 2：沙箱和资源预算

- 实现沙箱运行接口。
- 实现预算限制和并发限制。
- 实现超预算停止和记录。

**退出标准:** 任何候选都不能越过预算运行。

### 里程碑 3：参数级进化

- 生成参数变体。
- 评估变体。
- 自动晋升低风险参数变体。
- 支持参数回滚。

**退出标准:** 合成基准中参数自动改进主指标，且回滚测试通过。

### 里程碑 4：算法级候选

- 生成算法策略候选。
- 在沙箱中比较候选策略。
- 只允许通过完整回归测试的候选进入待晋升状态。

**退出标准:** 算法候选可被评估和记录，但默认不自动改公共契约。

### 里程碑 5：错误修正

- 接入错误分类。
- 实现自动重试、降级、回滚和修正候选生成。
- 实现安全边界触发后的停止和审计。

**退出标准:** 注入错误后系统能选择正确修正动作。

### 里程碑 6：结构级计划生成

- 识别结构级改进需求。
- 生成实现计划和风险报告。
- 保持人工确认门禁。

**退出标准:** 系统能提出结构调整方案，但不能自动应用高风险变更。

## 测试协议

### 单元测试

| 模块 | 测试内容 |
|------|----------|
| Metric Evaluator | 指标增益、回归、预算和安全结果计算 |
| Resource Manager | 时间、费用、并发、失败熔断 |
| Safety Gate | 低风险自动通过，高风险转人工确认 |
| Variant Generator | 参数、算法、结构三类变体生成和风险标记 |
| Error Corrector | 错误分类到修正动作的映射 |
| Promotion Controller | 晋升记录、回滚点、回滚演练 |
| Evolution Memory | 变体、结果、失败原因可检索 |

### 集成测试

- 端到端参数进化：从目标到参数变体晋升。
- 回归拒绝：主指标提升但旧任务失败时拒绝。
- 预算熔断：候选超过预算时停止。
- 回滚演练：晋升前必须能恢复基线。
- 环境变化：输入分布变化后触发新进化计划。
- 错误修正：注入临时失败、参数退化、算法回归和安全触发。

### 评估基准

| 指标 | 首版目标 |
|------|----------|
| 参数进化成功率 | 合成任务中至少 70% 目标获得正向改进 |
| 回归拦截率 | 至少 95% 已知回归样本被拒绝晋升 |
| 预算遵守率 | 100% 测试不超出配置预算 |
| 回滚成功率 | 100% 已晋升参数变体可回滚 |
| 错误修正匹配率 | 至少 90% 错误类型匹配正确动作 |
| 审计完整率 | 100% 变体有来源、评估和门禁记录 |
| 安全边界通过率 | 0 次高风险变更被自动应用 |

## 验收标准

Evolver 通过验收需要满足：

- 能基于预设目标自动发现需要改进的指标。
- 能感知环境变化并触发进化计划。
- 能生成参数、算法和结构三类候选变体。
- 能在沙箱中评估候选并和基线对比。
- 能自动应用低风险参数变体。
- 能对算法级变体执行严格评估。
- 能把结构级变更转为计划而不是直接应用。
- 能管理时间、算力、费用、存储和风险预算。
- 能在错误或退化后自动回滚、降级或修正。
- 能保留完整审计记录和进化记忆。

## ADR 信号

后续实现若确认以下内容，需要补 ADR：

- Evolver 的包位置和公共运行时契约。
- 进化记忆存储格式。
- 自动晋升门禁是否成为项目长期约束。
- Aletheia 与 Evolver 的职责边界。
- 是否允许算法级变体在特定条件下自动应用。

## 评审问题

- 首版是否只允许参数级自动应用，算法级和结构级都需要确认。
- Evolver 是否作为 Aletheia 的上层模块实现。
- 评估沙箱是否先使用本地模拟器，后续再接真实任务。
- 指标目标是否以 GitNexus 任务表现为主，还是先做通用合成任务。

## 自检

- 本规格没有要求无人确认地执行生产变更。
- 本规格把“自我修改”限定成受评估和门禁控制的候选变体生命周期。
- 本规格定义了指标、学习、资源、错误修正和安全门禁。
- 本规格明确了低风险自动应用和高风险待确认的边界。
- 本规格可作为后续实现计划的输入。

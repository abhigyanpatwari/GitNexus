# 全自动进化系统 Implementation Plan

## Goal

实现 Evolver 的首版本地运行时。它根据预设目标、环境信号、候选变体和评估结果，自动完成参数级进化，并把算法级和结构级变更保留在受控状态。首版不改生产配置、不推送代码、不删除数据、不发送外部通信，也不修改 GitNexus 既有 CLI、MCP、HTTP、图谱 schema 或 Web UI 行为。

## Architecture

Evolver 作为 `gitnexus/src/core/evolver/` 下的新内部模块实现，采用纯 TypeScript、无新增依赖、无外部网络调用。运行路径如下：

```text
GoalSpec[]
  -> EnvironmentSnapshot
  -> BaselineProfile
  -> EvolutionPlan
  -> VariantSpec[]
  -> TrialResult[]
  -> EvaluationReport[]
  -> GateDecision[]
  -> PromotionRecord | CorrectionAction
  -> EvolutionMemory
```

首版只自动应用 `parameter` 类型变体；`algorithm` 类型变体只能生成评估报告和 `needs-review`；`structure` 类型变体只能生成待评审计划记录。

## Tech Stack

- TypeScript ES2022, NodeNext modules.
- Vitest for unit and integration-style tests.
- Existing `gitnexus` package scripts: `npm run test:unit -- evolver`, `npx tsc --noEmit`.
- No runtime dependency changes in `package.json`.

## Baseline/Authority Refs

- Spec: `docs/aegis/specs/2026-05-25-fully-automated-evolution-system-design.md`
- Baseline: `docs/aegis/baseline/2026-05-25-initial-baseline.md`
- Rules: `AGENTS.md`, `GUARDRAILS.md`
- Package config: `gitnexus/package.json`, `gitnexus/tsconfig.json`

## Compatibility Boundary

- Do not modify existing CLI commands.
- Do not modify MCP tool contracts.
- Do not modify HTTP API routes.
- Do not modify graph schema, LadybugDB schema, or `.gitnexus/` registry/index layout.
- Do not add dependencies or lockfile changes in the first implementation.
- Keep all Evolver exports internal through `gitnexus/src/core/evolver/index.ts`.

## Verification

Run these checks after implementation slices:

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver
npx tsc --noEmit
```

Expected result:

```text
Test Files  ... passed
Tests       ... passed
```

and TypeScript exits with code `0`.

## Plan Basis

**Facts**
- The repo already uses TypeScript, Vitest, and `src/core/*` module boundaries.
- Tests import source files with `.js` extension from TypeScript test files.
- The accepted spec requires metrics, adaptive learning, resource management, error correction, safety gates, and audit memory.

**Assumptions**
- First implementation is an internal runtime, not a user-facing CLI command.
- Parameter-level promotion mutates an in-memory runtime configuration object in v1, not files on disk.
- Persistent storage is deferred; v1 uses in-memory memory records with stable interfaces.

**Unknowns**
- Final public API shape for future CLI integration.
- Whether algorithm-level promotion can ever become automatic.
- Whether Evolver eventually lives above Aletheia or beside it.

## Files

Create these implementation files:

```text
gitnexus/src/core/evolver/types.ts
gitnexus/src/core/evolver/metric-evaluator.ts
gitnexus/src/core/evolver/resource-manager.ts
gitnexus/src/core/evolver/variant-generator.ts
gitnexus/src/core/evolver/sandbox-runner.ts
gitnexus/src/core/evolver/safety-gate.ts
gitnexus/src/core/evolver/promotion-controller.ts
gitnexus/src/core/evolver/error-corrector.ts
gitnexus/src/core/evolver/evolution-memory.ts
gitnexus/src/core/evolver/evolver-runtime.ts
gitnexus/src/core/evolver/index.ts
```

Create these tests:

```text
gitnexus/test/unit/evolver/metric-evaluator.test.ts
gitnexus/test/unit/evolver/resource-manager.test.ts
gitnexus/test/unit/evolver/variant-generator.test.ts
gitnexus/test/unit/evolver/safety-gate.test.ts
gitnexus/test/unit/evolver/promotion-controller.test.ts
gitnexus/test/unit/evolver/error-corrector.test.ts
gitnexus/test/unit/evolver/evolution-memory.test.ts
gitnexus/test/unit/evolver/evolver-runtime.test.ts
```

## Plan Pressure Test

- **Owner / contract / retirement:** New owner is `core/evolver`; no old owner retired; no public contract changes.
- **Verification scope:** Unit tests cover every major module, runtime test covers end-to-end parameter evolution.
- **Task executability:** Each task creates one focused component with test-first steps and exact verification commands.
- **Pressure result:** Proceed.

## Ripple Signal Triage

- **Owner expansion:** Yes, new internal owner `core/evolver` is introduced.
- **Downstream scope:** No CLI, MCP, HTTP, graph, or Web UI consumer changes in v1.
- **Contract scope:** Internal TypeScript exports only.
- **Source-of-truth scope:** Evolver owns evolution records and decisions; GitNexus graph remains source for code facts.
- **Verification expansion:** Add dedicated unit tests and one runtime path test.

## ADR Signals To Preserve

Create an ADR later if implementation expands beyond this plan in any of these ways:

- Evolver becomes a public CLI, MCP, or HTTP feature.
- Evolution memory becomes persisted storage.
- Algorithm-level variants become auto-promotable.
- Evolver mutates files on disk.
- Evolver integrates directly with Aletheia or GitNexus graph data.

## Task 1: Core Types

**Files**
- Create `gitnexus/src/core/evolver/types.ts`
- Create `gitnexus/src/core/evolver/index.ts`
- Create `gitnexus/test/unit/evolver/types.test.ts`

**Why**
- Establish a typed contract for goals, metrics, environment snapshots, variants, budgets, evaluations, gates, promotions, memory, and corrections.

**Impact/Compatibility**
- Internal-only module. No existing files imported by production code.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/types.test.ts
npx tsc --noEmit
```

Expected: tests pass and TypeScript exits `0`.

**Steps**
- [ ] Write test: create `test/unit/evolver/types.test.ts` that imports `MutationType`, `VariantSpec`, `EvaluationReport`, `GateDecision`, and constructs one fully typed parameter variant with a promote evaluation.
- [ ] Verify RED: run `npm run test:unit -- evolver/types.test.ts`; expect module-not-found failure for `src/core/evolver/types.js`.
- [ ] Minimal code: create `types.ts` with exported interfaces and string union types from the spec. Create `index.ts` exporting `* from './types.js';`.
- [ ] Verify GREEN: run the same unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver core types"`.

## Task 2: Metric Evaluator

**Files**
- Create `gitnexus/src/core/evolver/metric-evaluator.ts`
- Create `gitnexus/test/unit/evolver/metric-evaluator.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Implement the decision math for metric deltas, regression limits, resource costs, safety failures, and report verdicts.

**Impact/Compatibility**
- Internal-only pure function module.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/metric-evaluator.test.ts
npx tsc --noEmit
```

Expected: promote, reject, and needs-review cases pass.

**Steps**
- [ ] Write test: cover a parameter variant that promotes, a regression that rejects, a safety finding that rejects, and an algorithm variant that returns `needs-review` despite positive metrics.
- [ ] Verify RED: run `npm run test:unit -- evolver/metric-evaluator.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `evaluateVariant(input)` that returns `EvaluationReport` using configured min gain, regression limit, budget limit, safety findings, and rollback status.
- [ ] Verify GREEN: run the unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver metric evaluator"`.

## Task 3: Resource Manager

**Files**
- Create `gitnexus/src/core/evolver/resource-manager.ts`
- Create `gitnexus/test/unit/evolver/resource-manager.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Enforce time, compute, cost, storage, concurrency, and risk budgets before running variants.

**Impact/Compatibility**
- Internal-only pure budget module.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/resource-manager.test.ts
npx tsc --noEmit
```

Expected: allowed, denied, and degraded decisions pass.

**Steps**
- [ ] Write test: cover budget allowed, cost denied, concurrency denied, and risk denied when high-risk variant quota is exhausted.
- [ ] Verify RED: run `npm run test:unit -- evolver/resource-manager.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `decideResourceUse(request, budget, currentUsage)` returning `{ allowed, reason, degradedPlan? }`.
- [ ] Verify GREEN: run the unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver resource manager"`.

## Task 4: Variant Generator

**Files**
- Create `gitnexus/src/core/evolver/variant-generator.ts`
- Create `gitnexus/test/unit/evolver/variant-generator.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Generate parameter, algorithm, and structure candidates while marking risk and rollback data.

**Impact/Compatibility**
- Internal-only generator. No file-system mutation.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/variant-generator.test.ts
npx tsc --noEmit
```

Expected: parameter variants are low risk, algorithm variants are medium risk by default, structure variants are high risk and not auto-applicable.

**Steps**
- [ ] Write test: create an `EvolutionPlan` allowing all mutation types and assert three returned variants have correct `mutationType`, `riskLevel`, `rollbackPlan`, and `provenance`.
- [ ] Verify RED: run `npm run test:unit -- evolver/variant-generator.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `generateVariants(plan, currentParameters)` with deterministic candidate IDs based on plan id and mutation type.
- [ ] Verify GREEN: run the unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver variant generator"`.

## Task 5: Sandbox Runner

**Files**
- Create `gitnexus/src/core/evolver/sandbox-runner.ts`
- Create `gitnexus/test/unit/evolver/sandbox-runner.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Evaluate candidates through a controlled interface without touching production state.

**Impact/Compatibility**
- No subprocess execution in v1. The sandbox is an injected function runner for deterministic tests.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/sandbox-runner.test.ts
npx tsc --noEmit
```

Expected: successful trial, failed trial, and timeout-budget rejection cases pass.

**Steps**
- [ ] Write test: inject a fake evaluator that returns metric readings; assert `TrialResult` records variant id, metrics, resource usage, and errors.
- [ ] Verify RED: run `npm run test:unit -- evolver/sandbox-runner.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `runSandboxTrial(variant, protocol, runner, budget)` where `runner` is an injected async function.
- [ ] Verify GREEN: run the unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver sandbox runner"`.

## Task 6: Safety Gate

**Files**
- Create `gitnexus/src/core/evolver/safety-gate.ts`
- Create `gitnexus/test/unit/evolver/safety-gate.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Enforce that only low-risk parameter variants with valid evaluation, provenance, budget, rollback, and safety results can auto-promote.

**Impact/Compatibility**
- Internal-only guard. This is the main protection against unsafe automation.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/safety-gate.test.ts
npx tsc --noEmit
```

Expected: parameter promote passes; algorithm and structure return `needs-review`; unsafe actions reject.

**Steps**
- [ ] Write test: cover low-risk parameter promotion, algorithm needs review, structure needs review, missing provenance reject, rollback failure reject, safety finding reject.
- [ ] Verify RED: run `npm run test:unit -- evolver/safety-gate.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `decidePromotion(variant, report)` returning `GateDecision` with `decision: 'allow' | 'reject' | 'needs-review'` and reasons.
- [ ] Verify GREEN: run the unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver safety gate"`.

## Task 7: Promotion Controller

**Files**
- Create `gitnexus/src/core/evolver/promotion-controller.ts`
- Create `gitnexus/test/unit/evolver/promotion-controller.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Apply approved parameter changes to an in-memory target and store a rollback point.

**Impact/Compatibility**
- Does not write files. Does not mutate external systems. Only mutates a caller-owned plain object passed into the controller.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/promotion-controller.test.ts
npx tsc --noEmit
```

Expected: allowed parameter promotion changes target, rollback restores target, blocked decision leaves target unchanged.

**Steps**
- [ ] Write test: pass `{ topK: 5 }`, promote patch `{ topK: 8 }`, assert rollback restores `{ topK: 5 }`; assert `needs-review` does not mutate.
- [ ] Verify RED: run `npm run test:unit -- evolver/promotion-controller.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `applyPromotion(target, variant, gateDecision)` and `rollbackPromotion(target, promotionRecord)`.
- [ ] Verify GREEN: run the unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver promotion controller"`.

## Task 8: Evolution Memory

**Files**
- Create `gitnexus/src/core/evolver/evolution-memory.ts`
- Create `gitnexus/test/unit/evolver/evolution-memory.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Store variants, trial results, evaluation reports, gate decisions, promotions, corrections, and failure reasons for future learning.

**Impact/Compatibility**
- In-memory store only. Stable interface allows persistent storage later without changing runtime callers.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/evolution-memory.test.ts
npx tsc --noEmit
```

Expected: records can be added and queried by goal id, variant id, verdict, and correction type.

**Steps**
- [ ] Write test: record a complete evolution run and assert query methods return expected records.
- [ ] Verify RED: run `npm run test:unit -- evolver/evolution-memory.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `InMemoryEvolutionMemory` with arrays/maps and read-only return copies.
- [ ] Verify GREEN: run the unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver memory"`.

## Task 9: Error Corrector

**Files**
- Create `gitnexus/src/core/evolver/error-corrector.ts`
- Create `gitnexus/test/unit/evolver/error-corrector.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Convert failure classes into retry, rollback, disable variant, reduce budget, freeze promotion, or stop-plan actions.

**Impact/Compatibility**
- Internal-only pure classifier/action selector.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/error-corrector.test.ts
npx tsc --noEmit
```

Expected: all spec-listed error classes map to the required correction action.

**Steps**
- [ ] Write test: cover temporary failure, parameter degradation, algorithm regression, structure risk, resource exhaustion, evaluation distortion, and safety trigger.
- [ ] Verify RED: run `npm run test:unit -- evolver/error-corrector.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `selectCorrectionAction(errorEvent, context)` returning a typed `CorrectionAction`.
- [ ] Verify GREEN: run the unit test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver error corrector"`.

## Task 10: Evolver Runtime

**Files**
- Create `gitnexus/src/core/evolver/evolver-runtime.ts`
- Create `gitnexus/test/unit/evolver/evolver-runtime.test.ts`
- Update `gitnexus/src/core/evolver/index.ts`

**Why**
- Connect all modules into one executable internal API for the first end-to-end parameter evolution path.

**Impact/Compatibility**
- Internal API only. No external side effects beyond caller-owned in-memory target object.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver/evolver-runtime.test.ts
npx tsc --noEmit
```

Expected: runtime promotes a safe parameter variant, rejects a regressive variant, and returns needs-review for structure variant.

**Steps**
- [ ] Write test: create a `createEvolverRuntime` instance with fake sandbox protocol. Assert one full run updates target parameters, stores memory, and returns a `PromotionRecord`.
- [ ] Verify RED: run `npm run test:unit -- evolver/evolver-runtime.test.ts`; expect missing module failure.
- [ ] Minimal code: implement `createEvolverRuntime({ memory, sandboxRunner, currentParameters })` with `runEvolution(goal, snapshot, baseline)`.
- [ ] Verify GREEN: run the runtime test and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver runtime"`.

## Task 11: Acceptance Test Slice

**Files**
- Create `gitnexus/test/unit/evolver/evolver-acceptance.test.ts`

**Why**
- Verify the user-visible requirements from the design spec in one focused test file.

**Impact/Compatibility**
- Test-only addition.

**Verification**

```powershell
cd C:\GitNexus\gitnexus
npm run test:unit -- evolver
npx tsc --noEmit
```

Expected: all Evolver tests pass and TypeScript exits `0`.

**Steps**
- [ ] Write test: assert Evolver can discover improvement need from metrics, generate variants, sandbox evaluate, auto-apply low-risk parameter change, block structure change, record audit memory, and select rollback after parameter degradation.
- [ ] Verify RED: if any acceptance expectation fails, record which module violates the spec.
- [ ] Minimal code: adjust the smallest owning module only; do not change public repo behavior.
- [ ] Verify GREEN: run `npm run test:unit -- evolver` and `npx tsc --noEmit`.
- [ ] Commit locally: `git add gitnexus/src/core/evolver gitnexus/test/unit/evolver && git commit -m "Add evolver acceptance coverage"`.

## Risks

- **Overreach risk:** Adding CLI or persistence during v1 would widen review scope. Keep runtime internal.
- **Metric gaming risk:** Candidate variants may optimize one metric while harming others. Safety gate must enforce regression limits.
- **Mutation risk:** Promotion must only mutate caller-owned in-memory parameters in v1.
- **Storage risk:** In-memory memory loses data across runs. This is accepted in v1 and preserved behind an interface for later persistence.
- **Testing risk:** Synthetic sandbox results can miss real-world behavior. Add real integration only after v1 internal runtime passes.

## Retirement

- No existing implementation is retired.
- No fallback is introduced.
- No compatibility shim is needed.
- Future retirement trigger: if persistent Evolution Memory is added, retire direct `InMemoryEvolutionMemory` construction from runtime tests and keep it as a test utility.

## Self-Review

- Every spec area maps to at least one task: metrics, learning, resources, variants, sandbox, safety, promotion, memory, error correction, runtime.
- No existing CLI, MCP, HTTP, graph, or Web UI contract changes are planned.
- Algorithm and structure variants do not auto-apply.
- Verification commands are exact and use existing package scripts.
- ADR signals are preserved for future public API, persistence, auto-promotion policy, and integration decisions.
- The plan avoids new dependencies and lockfile changes.

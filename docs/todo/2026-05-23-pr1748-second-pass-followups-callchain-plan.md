# PR #1748 第二轮审查 Follow-up 修复方案与调用链分析

日期：2026-05-23（Asia/Shanghai）  
分支：`codex/i18n-20260521`  
目标提交基线：`b4d521d069d9b3b03673dd54ad1736f5304fce8c`

## 目标

修复第二轮 Claude 审查中的 3 个非阻塞 follow-up，并保持当前 i18n PR 的机器输出/协议输出稳定：

1. `gitnexus/src/cli/help-i18n.ts` 中 Commander metadata label 仍用 `zh-CN ? ... : ...` 硬编码。
2. `gitnexus/src/cli/tool.ts` 中 `formatDetectChangesResult` 仍输出英文；同时 `eval-server.ts` 有同名重复 formatter。
3. `gitnexus-web/test/setup.ts` 未清理 `gitnexus.lng`，测试间可能发生语言状态泄漏。

## 适用规则与约束

- 遵守 `AGENTS.md` / `GUARDRAILS.md`：最小变更、运行影响分析、提交前运行 `gitnexus detect_changes`。
- 不修改 secrets、CI、发布、生产配置。
- CLI/MCP 机器可读契约必须稳定：MCP stdio JSON/text 包装、直接工具命令的结构化 JSON 输出路径不因本次变更改变。
- 新增 i18n key 必须保持 `en.ts` 与 `zh-CN.ts` 完全一致；`zh-CN.ts satisfies EnglishMessages` 与 `cli-i18n.test.ts` key parity 应继续保护。
- `docs/todo/...` 为本方案文档；代码变更仅限必要源文件和测试。

## 并行子 Agent 分析摘要

### 子任务 A：Commander help metadata label

- 调用链：`src/cli/index.ts` → `localizeCliHelp(program)` → `applyHelpI18n` → `command.configureHelp({ optionDescription: localizeOptionDescription })` → Commander help 输出。
- 问题点：`localizeOptionDescription` 中 `choices/default/preset/env` 四类标签直接用 `getCliLanguage() === 'zh-CN'` 分支。
- 结论：只影响 `--help` 人类可读输出，不影响命令解析或机器输出。
- 推荐：新增资源 key，并用 `t()` 统一渲染。

### 子任务 B：detect-changes formatter 英文硬编码

- 调用链：`index.ts` 注册 `detect-changes` → `detectChangesCommand` → `backend.callTool('detect_changes')` → `formatDetectChangesResult` → `output()` → `writeSync(1, ...)`。
- MCP 路径不共享该 formatter：`src/mcp/server.ts` 直接 `JSON.stringify(result)`，不经过 CLI `tool.ts` formatter。
- `eval-server.ts` 有重复的 `formatDetectChangesResult`，用于 eval HTTP server 的 LLM-friendly 文本格式。
- 推荐：抽取共享 `src/cli/detect-changes-format.ts`，由 `tool.ts` 和 `eval-server.ts` 复用，避免重复英文硬编码。

### 子任务 C：Web test setup 中 `gitnexus.lng` 未清理

- 调用链：`vitest.config.ts setupFiles` → `test/setup.ts` → `localStorage` 初始化/清理 → `src/i18n/index.ts` 的 `LanguageDetector` 读取 `gitnexus.lng` → `LanguageSwitcher`/`i18n.changeLanguage` 写回。
- 风险：若某测试写入 `gitnexus.lng=zh-CN` 且未清理，后续测试的初始语言和 `document.lang` 可能受污染。
- 推荐：不要全局 `localStorage.clear()`；仅定向清理 `gitnexus.lng`，并在 setup 顶层与 `beforeEach` 都清理一次，避免模块 import 阶段读到残留。

## GitNexus MCP 调用链与影响面证据

### 索引状态

- `list_repos` 显示 `GitNexus` 索引落后 HEAD 2 个提交。
- 已运行 `npx gitnexus analyze` 增量更新：`29,244 nodes | 45,756 edges | 1021 clusters | 300 flows`。

### 影响分析

1. `impact(target="localizeOptionDescription", file_path="gitnexus/src/cli/help-i18n.ts", direction="upstream")`
   - 风险：LOW
   - 直接影响：0
   - affected processes：0

2. `impact(target="formatDetectChangesResult", file_path="gitnexus/src/cli/tool.ts", direction="upstream")`
   - 风险：LOW
   - 直接影响：`detectChangesCommand`
   - affected processes：`detectChangesCommand` 相关流程

3. `impact(target="formatDetectChangesResult", file_path="gitnexus/src/cli/eval-server.ts", direction="upstream")`
   - 风险：LOW
   - 直接影响：`test/unit/eval-formatters.test.ts`
   - affected processes：0

4. `impact(target="setup.ts", file_path="gitnexus-web/test/setup.ts", direction="upstream")`
   - 风险：LOW
   - 直接影响：0
   - affected processes：0

### Cypher 调用链确认

- `DetectChangesCommand → GroupService` 过程：
  1. `detectChangesCommand` (`gitnexus/src/cli/tool.ts`)
  2. `callTool` (`gitnexus/src/mcp/local/local-backend.ts`)
  3. `callToolAtGroupRepo` (`gitnexus/src/mcp/local/local-backend.ts`)
  4. `getGroupService` (`gitnexus/src/mcp/local/local-backend.ts`)
  5. `GroupService` (`gitnexus/src/core/group/service.ts`)

- CALLS 查询确认：
  - `localizeCliHelp` 由 `gitnexus/src/cli/index.ts` 调用。
  - `applyHelpI18n` 由 `localizeCliHelp` 调用并递归自调。
  - `formatDetectChangesResult` 由 `detectChangesCommand` 与 `eval-server` 的 `formatToolResult` 使用。
  - `persistSupportedLanguage` 由 Web i18n 初始化与 `languageChanged` 路径使用。

## 最佳实施方案

### 1. Commander metadata label 资源化

文件：

- `gitnexus/src/cli/help-i18n.ts`
- `gitnexus/src/cli/i18n/en.ts`
- `gitnexus/src/cli/i18n/zh-CN.ts`
- `gitnexus/test/unit/cli-index-help.test.ts`

方案：

- 新增 CLI i18n key：
  - `help.optionMeta.choices`
  - `help.optionMeta.default`
  - `help.optionMeta.preset`
  - `help.optionMeta.env`
- `localizeOptionDescription` 中删除 `getCliLanguage()` 双分支，改为 `t('help.optionMeta.*')`。
- 新增一个构造型 Commander help 测试，覆盖 `.choices()` / `.default()` / `.preset()` / `.env()` 输出，确保中文/英文均由资源驱动。

验收标准：

- `help-i18n.ts` 不再依赖 `getCliLanguage()`。
- 中文 help metadata 显示 `可选值/默认/预设/环境变量`。
- 英文 help metadata 保持 `choices/default/preset/env`。

### 2. detect-changes formatter 统一 i18n 化

文件：

- 新增 `gitnexus/src/cli/detect-changes-format.ts`
- 修改 `gitnexus/src/cli/tool.ts`
- 修改 `gitnexus/src/cli/eval-server.ts`
- 修改 `gitnexus/src/cli/i18n/en.ts`
- 修改 `gitnexus/src/cli/i18n/zh-CN.ts`
- 修改 `gitnexus/test/unit/tool-direct-cli.test.ts`
- 修改 `gitnexus/test/unit/eval-formatters.test.ts`

方案：

- 抽取共享 `formatDetectChangesResult(result)` 到 `detect-changes-format.ts`。
- 使用 `t()` 渲染人类可读 label：
  - `tool.detectChanges.noChanges`
  - `tool.detectChanges.changesSummary`
  - `tool.detectChanges.affectedProcesses`
  - `tool.detectChanges.riskLevel`
  - `tool.detectChanges.unknownRisk`
  - `tool.detectChanges.changedSymbols`
  - `tool.detectChanges.overflowMore`
  - `tool.detectChanges.affectedExecutionFlows`
  - `tool.detectChanges.steps(_one/_other)`
  - `tool.detectChanges.changedSteps`
- `tool.ts` 与 `eval-server.ts` 删除本地重复 formatter，均 import 共享函数。
- 不改 `output()`、`backend.callTool()`、MCP server JSON path。

验收标准：

- 默认英文输出与当前用户可见语义保持一致。
- `GITNEXUS_LANG=zh-CN` 时 `detectChangesCommand` 输出中文 label。
- `eval-server` detect_changes formatter 同步中文 label，避免重复缺陷。
- MCP stdio 和其他 direct tool JSON 输出不变。

### 3. Web Vitest setup 定向清理 `gitnexus.lng`

文件：

- `gitnexus-web/test/setup.ts`
- `gitnexus-web/test/unit/test-setup-storage.test.ts`

方案：

- 在 `test/setup.ts` 顶层定义本地常量 `I18N_LANGUAGE_STORAGE_KEY = 'gitnexus.lng'`。
- `ensureStorage(...)` 后立即 `localStorage.removeItem(I18N_LANGUAGE_STORAGE_KEY)`，防止模块 import/i18n init 阶段读取残留。
- `beforeEach` 中定向删除 `gitnexus.lng`，同时保留现有 LLM settings 清理。
- 不从 `src/i18n` import `LANGUAGE_STORAGE_KEY`，避免 setup import 触发 i18n 初始化。
- 增加专用 setup 隔离测试，证明测试间会清理 `gitnexus.lng`，并避免修改 `i18n.test.tsx` 中已有的 LanguageSwitcher 持久化覆盖。

验收标准：

- 不使用全局 `localStorage.clear()`。
- 不影响 `embedding-auto-start`、`settings-service` 等其他 localStorage 测试。
- `i18n` 测试仍能验证正常语言持久化。

## 验证计划

最小验证：

```bash
cd gitnexus && npx vitest run test/unit/cli-index-help.test.ts test/unit/cli-i18n.test.ts test/unit/tool-direct-cli.test.ts test/unit/eval-formatters.test.ts test/unit/cli-message.test.ts test/unit/doctor-format.test.ts
cd gitnexus && npx tsc --noEmit
cd gitnexus && npx eslint src/cli/help-i18n.ts src/cli/detect-changes-format.ts src/cli/tool.ts src/cli/eval-server.ts src/cli/i18n/en.ts src/cli/i18n/zh-CN.ts test/unit/cli-index-help.test.ts test/unit/tool-direct-cli.test.ts test/unit/eval-formatters.test.ts
cd gitnexus-web && npx vitest run test/unit/i18n.test.tsx test/unit/embedding-auto-start.test.ts test/unit/settings-service.test.ts test/unit/test-setup-storage.test.ts
cd gitnexus-web && npx tsc -b --noEmit
cd gitnexus-web && npx eslint test/setup.ts test/unit/i18n.test.tsx test/unit/test-setup-storage.test.ts
cd /Users/wangxc/Code/GitNexus && git diff --check
```

手动 smoke：

```bash
cd gitnexus
GITNEXUS_LANG=zh-CN node --import tsx src/cli/index.ts query --help
GITNEXUS_LANG=zh-CN node --import tsx src/cli/index.ts detect-changes --scope staged --repo GitNexus
```

收尾：

- 运行 `mcp__gitnexus__.detect_changes(scope="staged", repo="GitNexus")`。
- 若提交/推送，则提交信息遵守 Lore Commit Protocol。

## 停止条件

- 三个 follow-up 均有代码修复和测试覆盖。
- 目标验证通过或明确记录不可运行原因。
- GitNexus detect_changes 显示影响面与预期一致。

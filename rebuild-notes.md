# 源码版 gitnexus 重建说明

4 处改动在 `src/`（2 个 commit：`28d0c2ec` 核心修复 + `23b17518` 打点配套）。`rebuild.ps1` 自动 build + 验证。若上游大改导致 `-Check` 报特征缺失，按下面思路在新版手动重做。

## 4 处改动

### 1. cpp 限定命名空间解析索引化（核心性能）
- **文件**：`gitnexus/src/core/ingestion/languages/cpp/inline-namespaces.ts`
- **目的**：`resolveCppQualifiedNamespaceMember` 从 O(N×M)（每次调用全量扫所有 parsedFiles）改 O(1) Map 索引查询（`buildNamespaceIndex`）。UE5 全量 emit receiver 从 29.5h 降到 ~1-2h。
- **定位特征**：`buildNamespaceIndex` / `cpp-ns-index-built`
- **重做**：若新版仍是全量遍历 `parsedFiles` 找匹配 namespace，加 `buildNamespaceIndex`（建 `Map<nsName, [{scope, scopesById}]>`，首次调用建、parsedFiles 引用不变则复用）+ 重写查询为 `_nsIndex.get(receiverName)`。返回值契约不变。

### 2. Option A 守卫 + hook 走通 + 去 via（核心防 OOM）
- **文件**：`gitnexus-shared/src/scope-resolution/finalize-algorithm.ts`
- **目的**：`populateFileClosure` 的 wildcard 分支走 `expandsWildcardTo` hook（原 Phase 2.5 不走 = 一致性 bug）；`if (names === null)` 守卫让 consumer wildcard（cpp `#include` 等）跳过纯废料的 transitive closure 复制；去 `transitiveVia` 死重字段。
- **定位特征**：`if (names === null)`；`transitiveVia` 应为 0
- **重做**：找 `populateFileClosure` 的 wildcard targetClosure 遍历块，加 `if (names === null)` 守卫（null=无 hook 实现→走 localDefs fan-out + transitive，保护 TS `export * from`；非 null=consumer wildcard→用过滤 names，跳过 transitive）。`expandsWildcardTo` 接口返回类型加 `| null`。run.ts 的 hook 默认值 `?? []` 改 `?? null`。

### 3. emit 6 子阶段打点 + expandsWildcardTo null 配套
- **文件**：`gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts`
- **目的**：6 个 emit 函数（receiver/unresolved-receiver/free-call/references/imports/post-resolution）前后加 `sr-emit-*-pre/post` 打点；`expandsWildcardTo` hook 默认 `?? []` → `?? null`（改动 2 配套）。
- **定位特征**：`sr-emit-receiver-pre`
- **重做**：emit 函数前后加 `logHeapProbe('sr-emit-<phase>-pre/post', ...)`；hook 默认值改 `?? null`。

### 4. 主流程 phase2/phase3 打点
- **文件**：`gitnexus/src/core/run-analyze.ts`
- **目的**：full rebuild 路径 `loadGraphToLbug` 前后加 `phase2-lbug-load-pre/post`；FTS 建索引前后加 `phase3-fts-pre/post`。
- **定位特征**：`phase2-lbug-load-pre`
- **重做**：full rebuild 路径的 `loadGraphToLbug` + `createSearchFTSIndexes` 前后加 `logHeapProbe`。需 `import { logHeapProbe } from './ingestion/utils/heap-probe.js'`。

## 升级流程
1. `cd E:\GitNexus && git fetch upstream && git merge upstream/main`
2. 解决 4 处改动区域的冲突（git 三方合并帮你定位）
3. `.\rebuild.ps1`（install + 激活 binding + build + 验证 4 特征）
4. 若验证报特征缺失（上游大改），按上面思路手动重做，再 `.\rebuild.ps1 -SkipInstall`

## 维护坑
- **@ladybugdb/core native binding**：`npm install --ignore-scripts` 后需手动激活——跑 `node node_modules/@ladybugdb/core/install.js`（复制 `core-win32-x64/lbugjs.node` 到根目录）。`rebuild.ps1` 已自动处理。
- **tree-sitter grammars**：prebuilds 在 git `vendor/` 里，运行时 node-gyp-build 直接加载，不用 postinstall 编译。
- **打点输出**：`logHeapProbe` 写 probe file，需 `GITNEXUS_DEBUG_HEAP=1` + `GITNEXUS_HEAP_PROBE_FILE=<路径>` 环境变量。
- **跨包打点限制**：`finalize-algorithm.ts` 在 `gitnexus-shared` 包，没有 fin-phase 打点（heap-probe 在 gitnexus 包，跨包 import 有依赖链问题）。核心修复完整，只少了 finalize 阶段的诊断打点。

## 验证基线
UE5 全量（91601 文件）exit 0 / 6.53h，2.59M nodes / 5.17M edges，内存峰值 72.7GB。emit receiver 29.5h→~1-2h，closureEntries 7.26亿→1254万。

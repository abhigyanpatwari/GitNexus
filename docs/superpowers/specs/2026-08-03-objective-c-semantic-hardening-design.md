# Objective-C 核心语义强化设计

> 状态：设计已逐节确认，待书面复核
> 日期：2026-08-03
> 证据基线：`566affc842c8e19b2b7514584c2c6590b0e3d32d`
> 前置设计：`2026-08-03-objective-c-core-language-design.md`
> 原则：TDD、失败关闭、语言逻辑隔离、其他语言零行为回归

## 1. 结论

本阶段在现有 Objective-C 核心支持上补齐生产项目最常见、且可静态确定的类型与消息语义：

- `instancetype` 与 Objective-C related result type；
- `Foo<P> *`、`id<P>`、`Class<P>` 和轻量泛型的结构化解释；
- instance、class-object、protocol、`self`、`super` receiver 派发；
- `@selector(...)` 的无歧义源码事实；
- `NS_ENUM`、`NS_OPTIONS`、availability 和 nullability 宏容错；
- dynamic/ambiguous 场景的显式 unresolved 结果。

总体方案仍以 `LanguageProvider` / `ScopeResolver` 为扩展边界。共享 ingestion 不识别
Objective-C 名称、token 或类型；只增加两个可选、语言无关的 resolver hook，以及现有
`resolveReceiverMember` 的可选尾部上下文。未实现这些扩展的 Provider 保持原路径。

## 2. 目标与非目标

### 2.1 目标

1. 对静态类型明确的 Objective-C message send 生成准确 `CALLS`。
2. 对协议约束、元类、related result 和 `super` 保留 Clang/Objective-C 语义。
3. 对不具备唯一静态目标的调用不猜测、不按遍历顺序选取候选。
4. 保留 nullability、ARC qualifier、轻量泛型和宏声明的源码证据。
5. 保证 worker、缓存、ParsedFile、LadybugDB 和 scope resolution 结果一致。
6. 保证 Java、Kotlin、Swift、C/C++ 等既有语言图无非预期变化。

### 2.2 非目标

- `.mm` Objective-C++；仍按现有策略明确跳过。
- Swift bridging header、generated `-Swift.h`、`@objc` 名称映射或跨语言派发。
- `.xcodeproj`、`.xcworkspace`、target membership、header map 和 build setting 求值。
- Clang 级宏展开、条件编译求值或 SDK overlay。
- `performSelector:`、`NSSelectorFromString`、swizzling、KVC/KVO、裸 `objc_msgSend` 解码。
- Storyboard/XIB、IBOutlet/IBAction、UIKit 页面关系。
- Objective-C CFG/PDG visitor。

## 3. 已确认的语义约束

### 3.1 `instancetype` 是 receiver-relative

`instancetype` 不在提取阶段替换为声明类。它表示 related result：消息表达式的静态结果类型
来自调用点 receiver。继承自基类的 `+factory` 被 `Child` 调用时返回 `Child`，不是基类。

除显式 `instancetype` 外，按 Clang 规则识别相关方法族：

- class method：`alloc`、`new`；
- instance method：`init`、`self`、`retain`、`autorelease`。

方法族只在返回类型与 declaring class、superclass、`id` 或 protocol-qualified `id` 兼容时
产生 related-result 语义。无法证明兼容时使用声明返回类型，不猜测。

### 3.2 协议约束与元类必须分离

| 源码类型 | receiver form | concrete base | protocols |
| --- | --- | --- | --- |
| `Foo *` | instance | `Foo` | `[]` |
| `Foo<P,Q> *` | instance | `Foo` | `[P,Q]` |
| `id<P,Q>` | instance | 无 | `[P,Q]` |
| `Class<P>` | class-object | 无 | `[P]` |
| `NSArray<Foo *> *` | instance | `NSArray` | `[]`，type argument 为 `Foo` |
| `id` | dynamic | 无 | `[]` |
| `Class` | dynamic class-object | 无 | `[]` |
| `instancetype` | related-result | 调用时确定 | `[]` |

`Class<P>` 表示遵循 P 的类对象，不表示名为 P 的具体类。`id<P>` 和 `Class<P>` 可以解析到
协议 contract，但不得声称存在唯一 concrete implementation。

### 3.3 selector 与实现不是同一身份

`@selector(save:)` 只有 selector 文本，没有 receiver、owner 或 instance/class method kind。
同一 selector 可由多个类、protocol 和 category 声明或实现。因此 selector 引用不直接关联到
任意 Method 节点，也不生成 `CALLS`。

## 4. Objective-C 私有类型描述符

新增语言私有模块 `languages/objective-c/type-semantics.ts`：

```ts
interface ObjectiveCTypeDescriptor {
  readonly raw: string;
  readonly baseName?: string;
  readonly protocols: readonly string[];
  readonly typeArguments: readonly string[];
  readonly receiverForm: 'instance' | 'class-object' | 'dynamic' | 'related-result';
  readonly qualifiers: readonly string[];
}
```

`parseObjectiveCTypeDescriptor(text)` 使用有界字符扫描器：

- 跟踪尖括号和括号深度；
- 区分 class base、protocol qualifier 和轻量 generic argument；
- 保留 `nullable`、`nonnull`、`__kindof`、`__weak`、`__strong`、
  `__unsafe_unretained`；
- 不执行宏展开或 typedef 求值；
- 输入超过现有 declared-spelling 上限、嵌套不平衡或超过深度上限时返回 dynamic descriptor；
- 纯函数、确定性、无模块级可变状态。

现有 `normalizeObjectiveCType` 保留为普通 lookup key 的兼容入口，并委托描述符解析器返回
`baseName`。特殊类型的精确信息从 `TypeRef.declaredSpelling` 恢复，不向全局 `TypeRef` 增加
Objective-C 字段。

## 5. Callsite 表示与 receiver kind

### 5.1 延后决定 `+/-`

除 `self`、`super` 外，capture 不按 receiver 首字母大小写决定方法种类：

- `@reference.name` 保存 unsigned selector；
- `@reference.candidate-names` 保存 `[-selector, +selector]`；
- `self`、`super` 根据 enclosing method kind 保存唯一 signed selector；
- resolver 必须处理或显式 suppress 带 Objective-C selector candidates 的 site，禁止落入
  任取候选的通用 fallback。

当 receiver 确定为：

- instance：只查询 `-selector`；
- class binding 或 class-object：只查询 `+selector`；
- `self`：使用 enclosing method kind；
- `super`：使用 enclosing method kind，并从直接父类开始；
- dynamic：不查 MethodRegistry，记录 unresolved。

### 5.2 共享扩展点

新增语言无关的可选 hook：

```ts
interface ReceiverMemberSuppression {
  readonly kind: 'unresolved';
  readonly reason: string;
  readonly candidateIds?: readonly string[];
}

resolveTypedReceiverMember?(
  typeRef: TypeRef,
  receiverName: string,
  memberName: string,
  callsite: Callsite,
  scopes: ScopeResolutionIndexes,
  model: SemanticModel,
): ReceiverMemberResolution | ReceiverMemberSuppression | undefined;
```

它在 receiver-bound Case 4 普通 class lookup 前执行：

- `resolved`：发唯一边；
- `ambiguous`：记录候选并 suppress；
- `unresolved`：记录 reason 并 suppress；
- `undefined`：Provider 不处理，继续原路径。

现有 `resolveReceiverMember` 增加可选尾部上下文：

```ts
interface ReceiverMemberContext {
  readonly receiverName: string;
  readonly receiverKind: 'class' | 'instance' | 'self' | 'super';
  readonly receiverTypeRef?: TypeRef;
}
```

参数追加且可选，既有 Provider 的函数签名保持可赋值。

### 5.3 协议 contract 查找

对 `id<P,Q>` / `Class<P,Q>`：

1. 解析协议及其继承协议；
2. 按 receiver form 选择 `-selector` 或 `+selector`；
3. 按 declarationKey 去重相同 contract；
4. 唯一 required contract：发 `CALLS` 到协议 Method declaration，reason
   `objective-c: protocol-dispatch`；
5. 唯一 optional contract：发条件性协议 contract 边，reason
   `objective-c: optional-protocol-dispatch`，confidence 固定为 `0.6`；required contract
   沿用确定性语言解析的 `0.85`；
6. 多个不等价 contract 或冲突签名：ambiguous；
7. 不从 `METHOD_IMPLEMENTS` 任选 concrete implementation。

对 `Foo<P> *`，先在 Foo + superclass 上查 concrete/declaration member；没有唯一成员时再查 P
contract。Foo 上存在多个 category implementation 时保持 ambiguous。

## 6. Related result 与嵌套消息链

新增第二个语言无关的可选 hook：

```ts
resolveRelatedResultOwner?(
  method: SymbolDefinition,
  receiverOwner: SymbolDefinition,
  callsite: Callsite,
): SymbolDefinition | undefined;
```

compound receiver fold 在读取 Method return type 前调用。Objective-C 实现仅在显式
`instancetype` 或满足方法族规则时返回 `receiverOwner`；其他返回类型交给既有逻辑。

嵌套消息使用现有 receiver-chain codec，不引入平行 wire format。例如：

```objc
[[Child alloc] init]
```

外层 `-init` site 的 receiver chain 表示为：

```text
base Child -> call +alloc
```

fold 解析 `+alloc` 后，related-result hook 返回 Child；外层再在 Child instance 上解析
`-init`，并继续保留 Child 类型。chain 无 base、超过深度、解码失败或中间 target 多义时整体
降级 unresolved，不使用部分前缀推断。

## 7. `super` 解析

`super` 从消息所在 Method 的词法宿主开始：

1. 根据 sourceIdentity/owner 找到当前主类或 category host 的 logical owner；
2. 读取该 owner 的唯一直接 superclass；
3. 从父类开始沿 MRO 查找，不查询当前类或当前类 category；
4. instance method 只查 `-selector`，class method 只查 `+selector`；
5. category 内 `super` 重定向到宿主主类的 superclass；
6. 主类、heritage 或直接父类多义时 suppress，不发边。

## 8. `@selector` 图模型

每个合法 `selector_expression` 生成一个源码位置稳定的 `CodeElement`：

```text
name: @selector(save:)
annotations:
  - objc:selector-reference
  - objc:selector:save:
sourceIdentity:
  selector text + file path + row + column
```

CodeElement 通过现有结构关系归属 enclosing Method/Function/File。它：

- 不生成 `CALLS`；
- 不生成指向任意 Method 的 `USES`；
- 不扩展共享 `ReferenceKind`；
- 可通过 selector annotation 与 Method 的 selector 属性进行查询层 join；
- 相同 selector 多次出现时保留不同 source-site。

字符串 selector、`NSSelectorFromString` 和 `performSelector:` 不创建静态 selector-to-method
关系。合法字符串可以在未来作为低置信度动态事实单独设计，不进入本阶段。

## 9. Apple 宏与 nullability

### 9.1 直接 AST 优先

vendored grammar 已声明 `macro_type_specifier`、`availability_attribute_specifier` 和
`selector_expression`。实现顺序为：

1. 先为现有 AST 写 characterization tests；
2. 能从 AST 取得的内容直接捕获；
3. 只有 AST 对固定语法产生 ERROR 且导致符号丢失时才增加语言内补偿；
4. 不因宏“看起来复杂”就预处理。

### 9.2 `NS_ENUM` / `NS_OPTIONS`

必须保存：

- enum/type 名；
- underlying type；
- enumerator 名和值的源码文本；
- `objc:ns-enum` 或 `objc:ns-options` annotation。

若 grammar 的 `macro_type_specifier` 已完整表示，则直接提取。若特定变体无法形成可用 AST，使用
有界源码扫描器生成 synthetic captures；不把整个宏替换为空白，也不猜测宏展开后的 ABI。
synthetic 与 AST capture 按文件位置和名称去重。

### 9.3 availability 与 assumed nullability

- `API_AVAILABLE`、`API_DEPRECATED` 等保存为声明 annotations；
- 不根据当前机器 SDK 或 deployment target 删除声明；
- `NS_ASSUME_NONNULL_BEGIN/END` 通过平衡区间扫描，为区间内声明添加
  `objc:nullability:assumed-nonnull`；
- 显式 `nullable` / `nonnull` 优先于 assumed 区间；
- `NS_ASSUME_NONNULL_*` 标记不被预处理器屏蔽，保证 capture 阶段仍可读取。

### 9.4 等长预处理边界

仅对 allowlist 内、确认破坏 AST、且不承载符号身份的 ASCII attribute wrapper 允许等长空白化。
实现必须：

- 保持 JavaScript `.length` 和每个换行位置；
- 纯函数、幂等；
- 跳过字符串、字符字面量、行注释和嵌套块注释；
- 对括号不平衡、未知宏、非 ASCII elided range 或超限输入返回原文；
- 不求值 `#if`、`#ifdef` 或 build setting；
- 通过现有 `preprocess-source-parity.test.ts`。

## 10. 失败、诊断与安全

| 场景 | 结果 |
| --- | --- |
| 裸 `id`、裸 `Class` | unresolved dynamic receiver |
| 未知 receiver | unresolved receiver |
| 多协议冲突 selector | ambiguous，保留候选 |
| 多 category implementation | ambiguous，保留候选 |
| optional protocol contract | conditional contract edge，不选实现 |
| malformed `@selector` | 跳过该事实，继续文件 |
| 未知/不平衡宏 | 原文解析，不做补偿 |
| receiver chain 不完整 | 整条 chain unresolved |
| external SDK 无源码 | external boundary，不创建伪节点 |
| `performSelector:` / swizzling | dynamic boundary，不发推测边 |

所有 suppress/unresolved 通过现有 resolution outcome 记录 `filePath`、selector、位置、phase 和
reason。日志不得包含完整源文件或可能的凭据内容。

类型与宏扫描器必须有长度、深度和候选数量上限，使用线性或有界线性扫描；不使用嵌套量词
正则。原生 grammar worker 沿用 safe-point drain/unref，不新增 `terminate()`。

## 11. TDD 测试设计

### 11.1 类型单元测试

新增 `gitnexus/test/unit/objective-c-type-semantics.test.ts`：

- `Foo *`、`Foo<P,Q> *`、`id<P,Q>`、`Class<P>`；
- 裸 `id`、裸 `Class`；
- `NSArray<Foo *> *` 和嵌套 lightweight generics；
- `instancetype`；
- nullability、ARC qualifier、`__kindof`；
- Unicode identifier；
- 不平衡、超深、超长和已有安全回归输入。

每项先写失败断言并确认 RED，再实现最小解析器。

### 11.2 selector 与宏单元测试

新增或扩展：

- `objective-c-selector.test.ts`：unsigned selector、self/super signed selector；
- `objective-c-scope-captures.test.ts`：候选名、related-result metadata；
- `objective-c-advanced-syntax.test.ts`：selector CodeElement、enum/options、availability；
- `objective-c-macro-preprocess.test.ts`：等长、换行不变、幂等、注释/字符串跳过、失败回退；
- `preprocess-source-parity.test.ts`：worker/bridge/embedding parity。

### 11.3 集成 fixture

新增 `test/fixtures/lang-resolution/objective-c-semantics/`，覆盖：

- `BaseFactory` / `ChildFactory` related result；
- `[[ChildFactory alloc] init]`；
- 小写 Class 变量和大写 instance 变量；
- `id<P,Q>` 与 `Class<P>`；
- required、optional 和冲突 protocol method；
- instance/class/category `super`；
- 多 category 同 selector；
- `@selector`、`NS_ENUM`、`NS_OPTIONS`；
- `performSelector:`、字符串 selector、裸 dynamic receiver 负向样例。

集成断言同时验证 nodes、`CALLS`、`USES`/结构关系、reason、confidence 和 unresolved outcome。

### 11.4 缓存与持久化

- worker 与直接 bridge 产物一致；
- cold、warm、incremental、full canonical graph 一致；
- `declaredSpelling`、annotations、selector CodeElement 和 related-result metadata 经过
  ParsedFile store/LadybugDB 后不丢失；
- Objective-C grammar 缺失时只跳过该语言；
- 非 Objective-C ParsedFile 不新增语言私有 payload。

## 12. 验证命令

实施阶段至少运行：

```bash
cd "gitnexus"
npm test -- objective-c
npm test
npx tsc --noEmit
npx eslint .
npx prettier --check .
```

提交前运行：

```bash
node "gitnexus/dist/cli/index.js" detect-changes \
  --scope compare --base-ref "main" --repo "."
```

随后运行完整 CI：六平台 grammar prebuild、unit/integration、macOS/Windows shards、E2E、ABI、
packaged smoke、Docker、benchmark、CodeQL、Gitleaks、workflow lint 和 Dependency Review。

## 13. 验收门槛

1. 类型描述符和 selector golden 100% 通过。
2. fixture 中静态唯一调用全部命中预期目标。
3. dynamic/ambiguous fixture 错误 `CALLS` 数量为 0。
4. `instancetype`/方法族在 subclass receiver 和嵌套消息链上保持 receiver type。
5. instance/class/category `super` 均只命中父链正确目标。
6. cold、warm、incremental、full canonical graph 完全一致。
7. 既有 Objective-C 测试零回归。
8. Java、Kotlin、Swift、C/C++ 等既有测试零新增失败。
9. 两个可选 resolver hook 未配置时，其他 Provider 结果保持不变。
10. 宏扫描器无异常、无超时、无 ReDoS；unknown input fail-open to original parse。
11. 完整 CI 全绿后才允许合并。

Objective-C 支持等级仍保持 `experimental`；本阶段完成不自动升级为 `production`。升级仍需前置
设计规定的固定真实 corpus、精度/召回率、性能和确定性硬门槛。

## 14. 实施分批与回滚

### 批次 A：类型与 receiver dispatch

- 类型描述符；
- unsigned selector candidates；
- typed/protocol/class-object receiver hook；
- dynamic/ambiguous suppress；
- 单元与集成测试。

可通过撤回 Objective-C hook 注册和相关共享可选调用点独立回滚。

### 批次 B：related result 与 `super`

- return metadata；
- receiver-chain；
- related-result hook；
- instance/class/category `super`。

可关闭 Objective-C related-result hook 回到现有行为，不影响批次 A。

### 批次 C：selector、宏与验收

- selector CodeElement；
- enum/options、availability、nullability；
- 动态行为负向测试；
- 缓存、持久化、完整 CI 和性能检查。

宏补偿与 selector facts 均为语言内功能，可分别回滚。

## 15. 风险登记

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| related-result 错绑声明类 | 高 | 保存 marker；仅在调用点使用 receiverOwner |
| `Class<P>` 被当作具体 P | 高 | descriptor 分离 class-object 与 protocol constraint |
| 大小写启发式误判 `+/-` | 高 | unsigned capture；registry/type binding 决定 kind |
| selector 任意绑定 Method | 高 | 独立 CodeElement；不发 target edge |
| 多 protocol/category 任取首项 | 高 | candidate set + ambiguity suppression |
| 宏补偿改变源码位置 | 高 | AST 优先；等长/换行 parity；synthetic captures 去重 |
| 新 hook 影响其他语言 | 中 | 可选 hook；未配置 contract tests；全语言 graph parity |
| selector CodeElement 增加图体积 | 低 | 仅显式 `@selector` occurrence；纳入 benchmark |
| 类型扫描器受恶意输入拖慢 | 中 | 长度/深度/候选上限；线性 scanner；安全测试 |

## 16. 最终评审结论

方案在修正 `instancetype`、protocol-qualified metaclass、selector identity 和 receiver kind 后可实施。
它没有把 Objective-C 语义塞入共享 ingestion，也不要求重构所有语言的 `TypeRef`。共享变化限于
两个通用可选 hook 和一个可选上下文；主要复杂度由 Objective-C Provider/ScopeResolver 自己承担。

满足第 13 节验收门槛后，可认为 GitNexus 对常见纯 Objective-C iOS 源码的核心类型与消息语义
达到可用于项目索引、调用图和影响分析的强化状态，但仍不等同于 Clang/Xcode 完整编译语义。

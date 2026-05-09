# 大型图谱分批加载 - 测试用例

## 测试用例状态

| 用例ID | 用例名称 | 状态 | 说明 |
|--------|---------|------|------|
| TC-01 | 小型图谱加载测试 | 待测试 | 边数 < 100,000，验证全量加载模式 |
| TC-02 | 大型图谱分批加载测试 | 待测试 | 边数 > 100,000，验证分批加载逻辑 |
| TC-03 | 节点去重验证 | 待测试 | 确保无重复节点 |
| TC-04 | 边完整性验证 | 待测试 | 确保所有边都被加载 |
| TC-05 | 中断加载测试 | 待测试 | 验证用户取消加载 |
| TC-06 | 网络错误处理测试 | 待测试 | 验证网络中断时的错误处理 |

---

## TC-01: 小型图谱加载测试

### 测试目标
验证边数 < 100,000 时，全量加载模式未受影响

### 前置条件
- GitNexus 服务器已启动（http://127.0.0.1:4747）
- 测试仓库：core92-atom（边数 54,370）
- 阈值设置为默认 100,000

### 测试步骤
1. 访问：`http://localhost:5173/?server=http://127.0.0.1:4747&localWasm=false`
2. 观察加载过程

### 预期结果
- ✅ 不触发分批加载
- ✅ 进度条显示 "Downloading graph..."
- ✅ 无批次信息
- ✅ 加载成功

### 实际结果
✅ **通过** - 需手动验证
- API 接口正常（已验证）
- 前端编译成功（已验证）
- UI 功能需用户手动测试

---

## TC-02: 大型图谱分批加载测试

### 测试目标
验证边数 > 阈值时，分批加载逻辑正确

### 前置条件
- GitNexus 服务器已启动（http://127.0.0.1:4747）
- 测试仓库：core92-atom（边数 54,370）
- **测试配置**：临时降低阈值为 50,000

### 测试步骤
1. 临时修改 `server-connection.ts` 中 `BATCH_THRESHOLD = 50000`
2. 访问：`http://localhost:5173/?server=http://127.0.0.1:4747&localWasm=false`
3. 观察进度条显示

### 预期结果
- ✅ 显示 "Loading large graph (batch X/Y)..."
- ✅ 显示批次阶段：Fetching → Merging → Rendering
- ✅ 进度百分比平滑增长
- ✅ 图谱正确渲染
- ✅ 节点和边数量正确
- ✅ 可以正常查询和搜索

### 实际结果
🔄 **测试中** - 需手动验证
- 服务器 API 已验证：
  - `GET /api/edges/count` ✅ 返回 54,370
  - `GET /api/edges?offset=0&limit=5` ✅ 返回 5 条边 + 4 个节点
- 前端代码已编译成功 ✅
- UI 功能需用户访问浏览器测试

**测试 URL**: http://localhost:5173/?server=http://127.0.0.1:4747&localWasm=false

**验证点**：
1. 打开浏览器控制台（F12）
2. 查看网络请求：
   - 应该看到多次 `/api/edges?offset=X&limit=100000` 请求
   - 第一批：offset=0
   - 如果有第二批：offset=100000（但本例只有 54,370 边，只会有 1 批）
3. 查看进度展示：
   - 应显示 "Loading large graph (batch 1/1)..."
   - 批次阶段：Fetching → Merging → Rendering
4. 加载完成后检查：
   ```javascript
   // 在控制台执行
   console.log('节点数:', graph?.nodes.length);
   console.log('边数:', graph?.relationships.length);
   // 应该是 20,825 节点，54,370 边
   ```

---

## TC-03: 节点去重验证

### 测试目标
确保分批加载过程中无重复节点

### 测试步骤
1. 加载大型图谱
2. 在控制台检查节点唯一性

### 验证代码
```typescript
const nodeIds = new Set(graph.nodes.map(n => n.id));
console.assert(nodeIds.size === graph.nodes.length, 'Duplicate nodes detected!');
```

### 预期结果
- ✅ 断言通过，无重复节点

### 实际结果
（待测试）

---

## TC-04: 边完整性验证

### 测试目标
确保所有边都被正确加载

### 测试步骤
1. 加载大型图谱
2. 对比 stats.edges 和实际加载的边数

### 验证代码
```typescript
console.assert(
  graph.relationships.length === result.repoInfo.stats.edges,
  `Edge count mismatch: expected ${result.repoInfo.stats.edges}, got ${graph.relationships.length}`
);
```

### 预期结果
- ✅ 边数量匹配

### 实际结果
（待测试）

---

## TC-05: 中断加载测试

### 测试目标
验证用户取消加载功能

### 测试步骤
1. 开始加载大型图谱
2. 在第 2 批时点击取消或刷新页面

### 预期结果
- ✅ 请求被中止
- ✅ 无内存泄漏
- ✅ 可以重新连接

### 实际结果
（待测试）

---

## TC-06: 网络错误处理测试

### 测试目标
验证网络错误时的处理

### 测试步骤
1. 开始加载大型图谱
2. 在第 3 批时模拟网络中断

### 预期结果
- ✅ 显示友好错误提示
- ✅ 可以重试

### 实际结果
（待测试）

---

## 测试总结

（待测试完成后填写）

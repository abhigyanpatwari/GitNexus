# Bundle 還原使用範例 | Bundle Restoration Examples

## 概述 | Overview

本文件展示如何使用 `code_context_packet_v1` 進行 AI agents 間的知識傳遞與重用。透過結構化封包，AI 可以：

1. **避免重複查詢** - 直接重用先前的分析結果
2. **保持上下文連續性** - 跨對話 session 維持知識狀態  
3. **提升協作效率** - 多個 AI 共享相同的程式碼理解

## 使用場景 | Use Cases

### 場景 1：Symbol Context 重用

**情境：** Agent A 已分析 `UserService` 類別，Agent B 需要相同資訊

```json
{
  "packet_id": "550e8400-e29b-41d4-a716-446655440001",
  "version": "1.0",
  "source": {
    "tool": "gitnexus",
    "agent_id": "claude-sonnet-4-session-001"
  },
  "timestamp": "2026-03-14T18:31:00Z",
  "context_type": "symbol_context",
  "query": {
    "original_query": "analyze UserService dependencies",
    "intent": "understand"
  },
  "repository": {
    "name": "ecommerce-backend",
    "commit_hash": "abc123def456"
  },
  "data": {
    "symbol": {
      "name": "UserService",
      "type": "class",
      "file_path": "src/services/user.ts",
      "line_range": {"start": 15, "end": 89}
    },
    "dependencies": [
      {
        "name": "DatabaseClient",
        "type": "class",
        "file_path": "src/db/client.ts"
      },
      {
        "name": "Logger",
        "type": "interface", 
        "file_path": "src/utils/logger.ts"
      }
    ],
    "dependents": [
      {
        "name": "AuthController",
        "type": "class",
        "file_path": "src/controllers/auth.ts"
      }
    ],
    "processes": ["user_registration", "user_authentication"]
  },
  "summary": "UserService 依賴 DatabaseClient 和 Logger，被 AuthController 使用",
  "ai_instructions": "此類別是核心服務，修改前需評估對 AuthController 的影響"
}
```

**Agent B 重用方式：**
```typescript
// Agent B 接收到封包後，可直接使用而無需重新查詢
const packet = receiveContextPacket();
if (packet.context_type === 'symbol_context' && 
    packet.data.symbol.name === 'UserService') {
  
  console.log(`✅ 重用快取：${packet.summary}`);
  console.log(`📋 使用指示：${packet.ai_instructions}`);
  
  // 直接使用依賴資訊進行後續分析
  const dependencies = packet.data.dependencies;
  // ... 繼續處理
}
```

### 場景 2：Impact Analysis 傳遞

**情境：** 重構前的影響分析結果需要在多個 AI 間共享

```json
{
  "packet_id": "550e8400-e29b-41d4-a716-446655440002", 
  "version": "1.0",
  "source": {
    "tool": "gitnexus",
    "agent_id": "cursor-ai-refactor-001"
  },
  "timestamp": "2026-03-14T18:35:00Z",
  "context_type": "impact_analysis",
  "query": {
    "original_query": "impact of renaming validateUser method",
    "intent": "impact_assess"
  },
  "data": {
    "target_symbol": {
      "name": "validateUser",
      "type": "method",
      "file_path": "src/auth/validator.ts"
    },
    "risk_level": "HIGH",
    "affected_symbols": [
      {
        "symbol": {
          "name": "AuthController.login",
          "type": "method",
          "file_path": "src/controllers/auth.ts"
        },
        "impact_type": "direct_caller",
        "depth": 1
      },
      {
        "symbol": {
          "name": "UserRegistrationFlow",
          "type": "function", 
          "file_path": "src/flows/registration.ts"
        },
        "impact_type": "indirect_caller",
        "depth": 2
      }
    ]
  },
  "metadata": {
    "confidence_score": 0.95,
    "processing_time_ms": 1200
  },
  "summary": "重新命名 validateUser 將直接影響 1 個方法，間接影響 1 個流程",
  "ai_instructions": "⚠️ HIGH 風險：執行重構前必須更新 AuthController.login 方法"
}
```

### 場景 3：跨 Session 知識保持

**情境：** 使用者在不同時間點繼續相同的重構工作

```typescript
// Session 1: 初始分析
const analysisPacket = {
  "packet_id": "550e8400-e29b-41d4-a716-446655440003",
  "context_type": "refactor_plan",
  "data": {
    "plan_id": "refactor-user-service-2026-03-14",
    "operations": [
      {
        "operation_type": "extract",
        "target": {
          "name": "UserService.validateEmail",
          "type": "method",
          "file_path": "src/services/user.ts"
        },
        "new_name": "EmailValidator",
        "new_location": "src/validators/email.ts"
      }
    ]
  },
  "ai_instructions": "第一步：提取 validateEmail 到獨立驗證器類別"
};

// Session 2: 繼續重構（數小時後）
const restoredContext = loadContextPacket("refactor-user-service-2026-03-14");
console.log(`🔄 恢復重構計畫：${restoredContext.data.plan_id}`);
console.log(`📝 下一步：${restoredContext.ai_instructions}`);
```

## 實作指南 | Implementation Guide

### 1. 封包產生 | Packet Generation

```typescript
export function createContextPacket(
  contextType: ContextType,
  data: any,
  query: string,
  intent: QueryIntent
): CodeContextPacket {
  return {
    packet_id: generateUUID(),
    version: "1.0",
    source: {
      tool: "gitnexus",
      agent_id: getCurrentAgentId(),
      session_id: getCurrentSessionId()
    },
    timestamp: new Date().toISOString(),
    context_type: contextType,
    query: {
      original_query: query,
      intent: intent
    },
    repository: getCurrentRepository(),
    data: data,
    summary: generateSummary(data),
    ai_instructions: generateInstructions(contextType, data)
  };
}
```

### 2. 封包驗證 | Packet Validation

```typescript
import Ajv from 'ajv';
import schema from '../schemas/code_context_packet_v1.json';

const ajv = new Ajv();
const validate = ajv.compile(schema);

export function validatePacket(packet: any): boolean {
  const valid = validate(packet);
  if (!valid) {
    console.error('封包驗證失敗:', validate.errors);
    return false;
  }
  return true;
}
```

### 3. 封包儲存與檢索 | Storage & Retrieval

```typescript
// 儲存到本地快取
export function storePacket(packet: CodeContextPacket): void {
  const key = `${packet.repository.name}:${packet.context_type}:${packet.packet_id}`;
  localStorage.setItem(key, JSON.stringify(packet));
}

// 依查詢檢索相關封包
export function findRelevantPackets(
  query: string, 
  contextType?: ContextType
): CodeContextPacket[] {
  const keys = Object.keys(localStorage)
    .filter(key => key.includes(getCurrentRepository().name))
    .filter(key => !contextType || key.includes(contextType));
    
  return keys
    .map(key => JSON.parse(localStorage.getItem(key)!))
    .filter(packet => isRelevant(packet, query))
    .sort((a, b) => b.metadata?.confidence_score - a.metadata?.confidence_score);
}
```

## 最佳實踐 | Best Practices

### ✅ 建議做法

1. **總是驗證封包** - 使用 JSON Schema 確保資料完整性
2. **設定過期時間** - 避免使用過時的程式碼分析結果  
3. **包含信心分數** - 讓接收方評估資料可靠性
4. **提供清晰指示** - `ai_instructions` 欄位應具體可執行

### ❌ 避免事項

1. **不要儲存敏感資訊** - 封包可能被其他 AI 存取
2. **不要假設封包永遠有效** - 程式碼變更會使分析失效
3. **不要忽略版本控制** - 確保封包對應正確的 commit

## 效益評估 | Benefits Assessment

- **⚡ 效能提升：** 避免重複分析，節省 60-80% 查詢時間
- **🧠 知識保持：** 跨 session 維持上下文，提升連續性
- **🤝 協作增強：** 多 AI 共享理解，減少誤解與衝突
- **📊 可追溯性：** 完整記錄分析來源與信心程度

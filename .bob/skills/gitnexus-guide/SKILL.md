---
name: gitnexus-guide
description: Complete reference for GitNexus tools, resources, and graph schema. Use when you need detailed information about available capabilities, resource URIs, or Cypher query syntax
---

# GitNexus Complete Guide

Complete reference for all GitNexus MCP tools, resources, and graph schema.

## Available Tools

### gitnexus_query
Process-grouped code intelligence — find execution flows related to a concept.

**Parameters:**
- `query` (required): Natural language or keyword search
- `task_context` (optional): What you're working on
- `goal` (optional): What you want to find
- `limit` (optional): Max processes (default: 5)
- `max_symbols` (optional): Max symbols per process (default: 10)
- `include_content` (optional): Include source code (default: false)
- `repo` (optional): Repository name (omit if only one indexed)

**Returns:** Processes ranked by relevance with their symbols and file locations.

**Example:**
```
gitnexus_query({
  query: "user authentication",
  task_context: "adding OAuth support",
  goal: "find existing auth validation logic",
  limit: 5
})
```

### gitnexus_context
360-degree view of a single symbol — categorized refs, process participation.

**Parameters:**
- `name` (optional): Symbol name
- `uid` (optional): Direct symbol UID (zero-ambiguity)
- `file_path` (optional): File path to disambiguate
- `include_content` (optional): Include source code (default: false)
- `repo` (optional): Repository name

**Returns:** Incoming/outgoing references, process participation, file location.

**Example:**
```
gitnexus_context({
  name: "validateUser",
  include_content: true
})
```

### gitnexus_impact
Blast radius analysis — what breaks if you change a symbol.

**Parameters:**
- `target` (required): Symbol name or file path
- `direction` (required): "upstream" or "downstream"
- `maxDepth` (optional): Max depth (default: 3)
- `relationTypes` (optional): Filter edge types
- `includeTests` (optional): Include test files (default: false)
- `minConfidence` (optional): Min confidence 0-1 (default: 0.7)
- `repo` (optional): Repository name

**Returns:** Affected symbols by depth, risk level, affected processes/modules.

**Example:**
```
gitnexus_impact({
  target: "UserService",
  direction: "upstream",
  maxDepth: 3,
  relationTypes: ["CALLS", "IMPORTS", "HAS_METHOD"]
})
```

### gitnexus_detect_changes
Git diff impact analysis — what do your changes affect.

**Parameters:**
- `scope` (optional): "unstaged", "staged", "all", "compare" (default: "unstaged")
- `base_ref` (optional): Branch/commit for "compare" scope
- `repo` (optional): Repository name

**Returns:** Changed symbols, affected processes, risk summary.

**Example:**
```
gitnexus_detect_changes({
  scope: "compare",
  base_ref: "main"
})
```

### gitnexus_rename
Multi-file coordinated rename with confidence tags.

**Parameters:**
- `symbol_name` (optional): Current symbol name
- `symbol_uid` (optional): Direct symbol UID
- `new_name` (required): New name
- `file_path` (optional): File path to disambiguate
- `dry_run` (optional): Preview only (default: true)
- `repo` (optional): Repository name

**Returns:** Edits tagged with confidence (graph vs text_search).

**Example:**
```
gitnexus_rename({
  symbol_name: "validateUser",
  new_name: "authenticateUser",
  dry_run: true
})
```

### gitnexus_cypher
Execute Cypher queries against the knowledge graph.

**Parameters:**
- `query` (required): Cypher query
- `repo` (optional): Repository name

**Returns:** Results formatted as Markdown table.

**Example:**
```
gitnexus_cypher({
  query: "MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: 'validateUser'}) RETURN a.name, a.filePath"
})
```

## Available Resources

### Repository Discovery
- `gitnexus://repos` — List all indexed repositories

### Repository Context
- `gitnexus://repo/{name}/context` — Stats, staleness check (~150 tokens)
- `gitnexus://repo/{name}/clusters` — All functional areas (~300 tokens)
- `gitnexus://repo/{name}/processes` — All execution flows
- `gitnexus://repo/{name}/schema` — Graph schema for Cypher

### Detailed Views
- `gitnexus://repo/{name}/cluster/{clusterName}` — Module members (~500 tokens)
- `gitnexus://repo/{name}/process/{processName}` — Step-by-step trace (~200 tokens)

### Setup
- `gitnexus://setup` — AGENTS.md content for all repos

## Graph Schema

### Node Types
- `File`, `Folder`
- `Function`, `Class`, `Interface`, `Method`
- `CodeElement` (generic)
- `Community` (functional areas)
- `Process` (execution flows)
- Multi-language: `Struct`, `Enum`, `Trait`, `Impl` (use backticks in Cypher)

### Edge Types
All relationships use single `CodeRelation` table with `type` property:

- `CONTAINS` — file/folder containment
- `DEFINES` — file defines symbol
- `CALLS` — function/method calls
- `IMPORTS` — module imports
- `EXTENDS` — class inheritance
- `IMPLEMENTS` — interface implementation
- `HAS_METHOD` — class has method
- `HAS_PROPERTY` — class has property
- `ACCESSES` — field read/write (reason: 'read' or 'write')
- `OVERRIDES` — method override (MRO resolution)
- `MEMBER_OF` — symbol belongs to community
- `STEP_IN_PROCESS` — symbol is step in process

### Edge Properties
- `type` (STRING): Edge type
- `confidence` (DOUBLE): 0.0-1.0
- `reason` (STRING): Additional context
- `step` (INT32): Step number in process

### Community Properties
- `heuristicLabel`: Human-readable name
- `cohesion`: Cohesion score
- `symbolCount`: Number of symbols
- `keywords`: Key terms
- `description`: Auto-generated description
- `enrichedBy`: LLM model used

### Process Properties
- `heuristicLabel`: Human-readable name
- `processType`: Type of flow
- `stepCount`: Number of steps
- `communities`: Involved communities
- `entryPointId`: Starting symbol
- `terminalId`: Ending symbol

## Cypher Query Examples

### Find callers of a function
```cypher
MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"})
RETURN a.name, a.filePath
```

### Find community members
```cypher
MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
WHERE c.heuristicLabel = "Auth"
RETURN f.name
```

### Trace a process
```cypher
MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
WHERE p.heuristicLabel = "UserLogin"
RETURN s.name, r.step
ORDER BY r.step
```

### Find all methods of a class
```cypher
MATCH (c:Class {name: "UserService"})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m:Method)
RETURN m.name, m.parameterCount, m.returnType
```

### Find all writers of a field
```cypher
MATCH (f:Function)-[r:CodeRelation {type: 'ACCESSES', reason: 'write'}]->(p:Property)
WHERE p.name = "address"
RETURN f.name, f.filePath
```

### Detect diamond inheritance
```cypher
MATCH (d:Class)-[:CodeRelation {type: 'EXTENDS'}]->(b1),
      (d)-[:CodeRelation {type: 'EXTENDS'}]->(b2),
      (b1)-[:CodeRelation {type: 'EXTENDS'}]->(a),
      (b2)-[:CodeRelation {type: 'EXTENDS'}]->(a)
WHERE b1 <> b2
RETURN d.name, b1.name, b2.name, a.name
```

## Relation Types Reference

| Type | Description | Use Case |
|------|-------------|----------|
| CALLS | Function/method calls | Trace execution flows |
| IMPORTS | Module imports | Dependency analysis |
| EXTENDS | Class inheritance | Hierarchy analysis |
| IMPLEMENTS | Interface implementation | Contract analysis |
| HAS_METHOD | Class methods | Class structure |
| HAS_PROPERTY | Class properties | Data model |
| ACCESSES | Field read/write | Data flow analysis |
| OVERRIDES | Method override | Polymorphism analysis |
| MEMBER_OF | Community membership | Module boundaries |
| STEP_IN_PROCESS | Process steps | Execution traces |

## Tips

- Use `heuristicLabel` (not `label`) for community/process names
- All relationships use single `CodeRelation` table
- Filter with `{type: 'CALLS'}` etc.
- ACCESSES edges include `reason: 'read'` or `'write'`
- Confidence < 0.8 indicates fuzzy match
- Use backticks for multi-language nodes: `` `Struct` ``
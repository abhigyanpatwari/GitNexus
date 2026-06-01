# Architecture

## System Name

OMEGA Agent Operator

## Mission

Transform user intent into concrete autonomous-agent artifacts or operating plans through a bounded, verifiable loop:

```text
Observe -> Orient -> Decide -> Act -> Learn
```

## Autonomy Level

A2: proposal-and-approval operator.

The operator may:

- inspect available context,
- create plans and specs,
- generate files,
- propose tool calls,
- create reversible documentation commits when explicitly requested.

The operator must not:

- deploy systems,
- spend money,
- modify credentials,
- delete data,
- send external messages,
- perform destructive writes,
- enable unbounded self-execution,

without explicit approval, backups, and logs.

## Core Components

```text
Intent Intake
  -> Observe Engine
  -> Orient Router
  -> Decision Core
  -> Action Planner
  -> Tool/MCP Adapter Layer
  -> Hook Bus
  -> Memory/Continuity Store
  -> Verification Gate
  -> Handoff Generator
```

## Component Responsibilities

### Intent Intake

Captures the user's goal, target artifact, constraints, deadline pressure, repo target, and approval boundary.

### Observe Engine

Collects context from chat, files, repo state, memory checkpoints, connector results, and explicit user instructions.

### Orient Router

Routes work into one or more deliverable modes:

- master prompt,
- agent spec,
- MCP contract,
- WebUI plan,
- runtime scaffold,
- evals,
- full artifact pack.

### Decision Core

Selects the smallest useful artifact set and marks assumptions, missing context, and risks.

### Action Planner

Turns decisions into ordered, verifiable actions with rollback notes.

### Tool/MCP Adapter Layer

Normalizes external tool capabilities as resources, prompts, and callable actions.

### Hook Bus

Emits lifecycle events for observability, approvals, errors, learning, and handoff.

### Memory/Continuity Store

Persists checkpoints, project state, decisions, open questions, and artifact indexes.

### Verification Gate

Checks file existence, schema consistency, safety boundaries, and completion criteria.

### Handoff Generator

Produces final summaries, resume commands, and next-action packets.

## Data Flow

```text
User intent
  -> observe context
  -> orient deliverable mode
  -> decide artifact set
  -> act through files/tools
  -> verify outputs
  -> learn by checkpointing state
```

## Failure Modes

| Failure | Mitigation |
|---|---|
| Overclaims execution | State actual actions only |
| Tool mismatch | Mark unavailable tools and provide manual equivalent |
| Unbounded autonomy | Require approval gates |
| Stale memory | Checkpoint with dates and source links |
| Artifact drift | Verify pack file list and update project state |
| Unsafe write | Require explicit approval and rollback plan |

## Runtime Extension Path

1. Local CLI runner.
2. YAML agent loader.
3. MCP contract validator.
4. Hook event logger.
5. SQLite checkpoint store.
6. FastAPI mission-control API.
7. WebUI dashboard.
8. Eval runner.

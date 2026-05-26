# Fully Automated Active Learning Agent Design

**Date:** 2026-05-25
**Status:** Draft for review
**Project context:** GitNexus monorepo
**Design owner:** Proposed new agent runtime package, not implemented yet

## Executive Summary

This design proposes **Aletheia**, a novel AI agent architecture centered on fully automated active learning, durable memory retention, and reusable knowledge application. The agent is not just a tool-calling loop. It is a closed runtime that continuously detects uncertainty, turns uncertainty into learning tasks, gathers evidence, stores knowledge with provenance, tests whether new knowledge improves performance, and applies validated knowledge to future work without waiting for human prompts.

The recommended implementation path is a TypeScript-first runtime that fits GitNexus: it uses a deterministic workflow backbone, a hybrid memory store, an evidence-first learning loop, and strict safety controls around external actions. It can later integrate GitNexus code graphs as one knowledge source, but it should not initially modify existing GitNexus indexing internals.

## Market Analysis

### LangGraph

**Architecture:** Graph-based state machine where nodes perform work, edges encode transitions, and a typed shared state moves through execution. Official docs emphasize durable execution, human-in-the-loop, short-term memory, long-term memory, tracing, and production deployment: https://docs.langchain.com/oss/python/langgraph/overview

**Capabilities:** Strong for long-running stateful workflows, resumable execution, branching, retries, observability through LangSmith, and multi-agent graph composition.

**Limitations:** Graph modeling adds overhead for simple tasks. Most active learning behavior still has to be designed by the application author. Memory exists, but autonomous knowledge-gap detection and evidence validation are not the central abstraction.

**Implementation approach:** Developers define state schemas, node functions, conditional edges, and checkpoint stores. The graph is the runtime contract.

### CrewAI

**Architecture:** Production applications are modeled as Flows plus Crews. Flows provide state, events, control flow, and branching. Crews provide role-based autonomous agents with goals, tools, tasks, and delegation. Official docs describe Flows as the backbone and Crews as the intelligence layer: https://docs.crewai.com/en/introduction

**Capabilities:** Fast to model business workflows, clear role separation, simple task delegation, event-driven orchestration, and multi-agent collaboration.

**Limitations:** Role metaphors can hide state and evidence quality. Crews are strong at collaboration but not inherently designed around self-directed curriculum generation, long-term knowledge governance, or proof that learned facts improved future task performance.

**Implementation approach:** Developers declare agents, tasks, tools, flows, events, and process modes.

### AutoGen And Microsoft Agent Framework

**Architecture:** AutoGen moved toward an asynchronous event-driven layered architecture with Core, AgentChat, and Extensions. Microsoft describes v0.4 as modular, event-driven, observable, distributed, cross-language, and type-supported: https://www.microsoft.com/en-us/research/blog/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/

**Capabilities:** Strong for multi-agent conversations, event-driven cooperation, reusable agents, observability, distributed systems, and research workflows.

**Limitations:** Conversation-first patterns can cause high token use and can make knowledge ownership unclear unless memory, provenance, and evaluation are added deliberately. Microsoft has also converged AutoGen with Semantic Kernel into Microsoft Agent Framework for enterprise deployment, which increases platform dependency: https://azure.microsoft.com/en-us/blog/introducing-microsoft-agent-framework/

**Implementation approach:** Developers compose event-driven agents, message handlers, model clients, tools, memory, and team patterns.

### OpenAI Agents SDK

**Architecture:** Lightweight runner loop with primitives such as agents, tools, handoffs, sessions, guardrails, and tracing. Public guides describe handoffs for delegation and guardrails for input/output validation: https://www.artificial-intelligence-wiki.com/agentic-ai/agent-architectures-and-components/openai-agents-sdk-guide/

**Capabilities:** Fast path to working agents, clean function-tool ergonomics, built-in tracing, handoffs, guardrails, sessions, and hosted tool support.

**Limitations:** Strong default path for OpenAI-native workloads but less suitable as the core abstraction for a model-agnostic self-learning runtime. Sandboxing, cost limits, source ranking, memory governance, and autonomous learning policy remain application responsibilities.

**Implementation approach:** Developers define agent instructions, tools, handoff targets, guardrails, and runner invocations.

### Memory-Focused Systems

**Architecture:** Production memory layers increasingly separate working, episodic, semantic, and procedural memory, often using vector search plus structured stores or knowledge graphs. Contemporary surveys describe episodic memory as event traces, semantic memory as facts and relationships, and procedural memory as reusable behaviors or workflows: https://www.artificial-intelligence-wiki.com/agentic-ai/agent-architectures-and-components/agent-memory-systems-guide/

**Capabilities:** Cross-session recall, personalization, factual storage, learned workflows, vector retrieval, graph relationships, bitemporal facts, and provenance-aware knowledge.

**Limitations:** Most memory systems retrieve what was stored. They do not automatically decide what the agent should learn next, whether a source is trustworthy, whether the new memory contradicts old memory, or whether storing it improved task outcomes.

**Implementation approach:** Developers build extractors, embeddings, graph edges, retrieval policies, conflict resolution, retention rules, and prompt/context injection.

## Market Gap

Current systems generally optimize one of four areas:

| Area | Leading examples | Gap |
|------|------------------|-----|
| Durable orchestration | LangGraph | Learning goals are application-defined, not autonomous |
| Role collaboration | CrewAI, AutoGen | Knowledge ownership and evidence quality can drift |
| Simple agent execution | OpenAI Agents SDK | Self-learning memory governance is outside the SDK |
| Persistent memory | Mem0, Zep, Letta-style systems | Storage and recall are stronger than self-directed learning |

The missing product is a runtime where the primary unit is neither a graph node nor a role nor a tool call. The primary unit is a **knowledge improvement cycle**: detect gap -> acquire evidence -> validate -> store -> apply -> measure impact.

## First-Principles Review

**First Principle:** The agent must improve its future task performance by autonomously identifying, acquiring, validating, storing, and applying knowledge.

**Non-negotiables:** Every learned item must have provenance, confidence, expiry or review policy, and measurable application evidence. External writes and communications remain guarded.

**Assumptions to Drop:** More agents do not imply better learning. Larger context windows do not replace memory. Vector search alone does not equal knowledge.

**Smallest Sufficient Path:** Build one durable learner loop with hybrid memory and evaluation gates before adding multi-agent teams.

**Escalation Signal:** If implementation needs to modify GitNexus graph schema, MCP public contracts, or production permissions, create a separate ADR and review it first.

## Task Intent Draft

**Outcome:** Design a new autonomous active-learning agent with architecture, mechanisms, memory, knowledge integration, self-improvement, milestones, tests, and evaluation criteria.

**Goal:** Produce a buildable specification that can guide implementation after review.

**Success evidence:** The spec defines components, data models, loops, safety boundaries, testing protocols, and measurable acceptance criteria for autonomous learning and knowledge application.

**Stop condition:** Stop before implementation until the design is reviewed.

**Non-goals:** Do not build production deployment, alter GitNexus core graph schema, add external communications, or implement unrestricted web/browser automation in the first version.

**Scope:** New local runtime module or package, likely TypeScript, with optional later GitNexus integration.

**Risks:** Hallucinated memories, memory poisoning, source over-trust, runaway cost, unbounded tool use, stale knowledge, and self-improvement loops that optimize proxy metrics instead of real task outcomes.

## Baseline Read Set Hint

- `README.md` confirms GitNexus builds a local code knowledge graph for AI agents.
- `AGENTS.md` defines safety, scope, validation, and GitNexus-specific impact rules.
- `GUARDRAILS.md` requires least privilege, secrets protection, and review before destructive or high-risk actions.
- `ARCHITECTURE.md` defines the current package boundaries and graph/query ownership.
- Root `package.json` shows TypeScript tooling and repo-wide quality commands.
- Existing `docs/superpowers/specs/2026-04-02-pr626-high-fixes-design.md` shows the local style for focused design documents.

## Impact Statement Draft

**Affected layers:** New design docs now. Future implementation would affect a new package or module, optional CLI command, optional local store, optional evaluation harness, and optional GitNexus query integration.

**Owners:** The new agent runtime should be the canonical owner of learning-cycle policy, memory write policy, and self-evaluation. GitNexus graph remains the canonical owner of codebase structure.

**Invariants:** Do not create a second owner for GitNexus graph facts. Do not store secrets. Do not perform irreversible actions without explicit approval. Do not treat unverified memories as facts.

**Compatibility:** Existing CLI, MCP, HTTP, graph schema, and web behavior remain unchanged for the initial implementation.

## Product Risk Lens

- **Value:** A self-learning agent can reduce repeated context explanation, improve task accuracy across sessions, and turn failures into reusable procedural knowledge.
- **Non-goals:** It is not an unsupervised production operator, not a replacement for source-of-truth systems, and not a hidden telemetry collector.
- **Trade-offs:** More autonomy increases learning speed but also increases risk from bad sources and runaway actions.
- **Decision needed:** Choose whether the first build should be a standalone local runtime, a GitNexus-native feature, or an adapter on an existing agent framework.

## Options

### Option A: Extend GitNexus Native Runtime

Build the active-learning agent directly inside `gitnexus/`, using GitNexus graph queries as the core memory substrate.

**Pros:** Deep code awareness from day one, strong alignment with project purpose, reuse of existing graph and embeddings.

**Cons:** High coupling to existing graph contracts, greater blast radius, harder to generalize beyond codebases, risk of creating duplicate graph ownership.

**Verdict:** Not recommended for v1.

### Option B: Standalone Local Learner Runtime With GitNexus Adapter

Create a separate runtime that owns learning policy, memory, and evaluation. GitNexus becomes one evidence provider through an adapter, not the memory owner.

**Pros:** Clean ownership, lower risk, reusable outside code tasks, easier to test, can adopt GitNexus data without mutating its schema.

**Cons:** Requires adapter contracts and a new local store. Some integration work is deferred.

**Verdict:** Recommended.

### Option C: Wrap An Existing Framework

Build on LangGraph, CrewAI, or OpenAI Agents SDK and implement the active-learning loop as application code.

**Pros:** Faster bootstrap, durable workflow primitives available, ecosystem integrations.

**Cons:** Framework abstractions could become the architecture. Active learning remains bolted on instead of being the core contract. Adds dependency churn and migration risk.

**Verdict:** Acceptable for prototype experiments, not recommended as the product architecture.

## Recommended Architecture

Aletheia uses a deterministic learner loop with bounded agentic steps. The core runtime is model-agnostic and tool-agnostic.

```text
Task/Observation
  -> Goal Interpreter
  -> Gap Detector
  -> Learning Agenda
  -> Evidence Acquisition
  -> Evidence Critic
  -> Memory Writer
  -> Retrieval Planner
  -> Knowledge Applicator
  -> Outcome Evaluator
  -> Policy Updater
```

### Core Components

| Component | Responsibility | Key inputs | Key outputs |
|-----------|----------------|------------|-------------|
| Goal Interpreter | Convert user or system task into success criteria and required knowledge | Task, context, constraints | Goal frame, success tests |
| Gap Detector | Identify missing, stale, contradictory, or low-confidence knowledge | Goal frame, memories, traces | KnowledgeGap records |
| Learning Agenda | Rank gaps by value, risk, cost, and dependency | Knowledge gaps, budget, policy | LearningTask queue |
| Evidence Acquisition | Query allowed sources and tools | LearningTask, source policy | EvidenceBundle |
| Evidence Critic | Score credibility, conflict, freshness, and task relevance | EvidenceBundle, existing memories | EvidenceAssessment |
| Memory Writer | Persist approved knowledge and relationships | EvidenceAssessment | Memory records and links |
| Retrieval Planner | Select working context for a task | Goal, memory index, budget | ContextPack |
| Knowledge Applicator | Use selected knowledge to solve tasks | ContextPack, tools | Action plan and result |
| Outcome Evaluator | Compare result to success criteria | Result, tests, trace | OutcomeScore |
| Policy Updater | Adjust retrieval, confidence, and learning policies | OutcomeScore, trace | PolicyDelta |

### Memory Model

Aletheia uses four memory classes.

| Memory type | Stores | Retrieval mode | Write gate |
|-------------|--------|----------------|------------|
| Working memory | Current task state, hypotheses, selected context | Direct state lookup | Runtime only |
| Episodic memory | Runs, tool calls, failures, decisions, outcomes | Time, task, entity, trace similarity | Always with redaction |
| Semantic memory | Facts, concepts, entities, relationships | Hybrid vector + graph + filters | Evidence critic approval |
| Procedural memory | Reusable workflows, tool sequences, prompts, test recipes | Intent similarity + preconditions | Outcome evaluator approval |

### Memory Record Schema

```typescript
export interface MemoryRecord {
  id: string;
  type: 'episodic' | 'semantic' | 'procedural';
  content: string;
  summary: string;
  entities: MemoryEntityRef[];
  relations: MemoryRelation[];
  provenance: EvidenceRef[];
  confidence: number;
  status: 'candidate' | 'validated' | 'deprecated' | 'rejected';
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  supersedes?: string[];
  tags: string[];
}
```

### Knowledge Gap Schema

```typescript
export interface KnowledgeGap {
  id: string;
  taskId: string;
  description: string;
  requiredFor: string;
  gapType: 'missing' | 'stale' | 'conflict' | 'low-confidence' | 'procedural-failure';
  priority: number;
  risk: 'low' | 'medium' | 'high';
  evidenceNeeded: string[];
  stopCondition: string;
}
```

### Evidence Schema

```typescript
export interface EvidenceBundle {
  id: string;
  gapId: string;
  sources: EvidenceSource[];
  extractedClaims: EvidenceClaim[];
  retrievalTrace: RetrievalStep[];
  acquisitionCost: EvidenceCost;
}
```

### Learning Cycle

1. The agent receives a task or observes a failure.
2. It extracts the knowledge needed to complete the task.
3. It retrieves existing memories and checks confidence, freshness, and contradictions.
4. It creates ranked knowledge gaps.
5. It acquires evidence from allowed sources only.
6. It critiques evidence and rejects weak or conflicting material.
7. It writes candidate or validated memory with provenance.
8. It retries or completes the task with the updated context.
9. It measures improvement against success criteria.
10. It promotes procedural memory only when repeated evidence shows a reusable workflow.

### Retrieval Strategy

- Use metadata filters first: task domain, source type, confidence, status, expiry, and safety level.
- Use lexical search for exact names, commands, APIs, errors, and identifiers.
- Use vector search for conceptual similarity.
- Use graph traversal for entity relationships, supersession chains, and source lineage.
- Build a ContextPack with quoted memory snippets, provenance IDs, confidence, and known contradictions.

### Self-Improvement Strategy

Aletheia improves policies, not model weights, in v1.

| Loop | Improvement target | Promotion rule |
|------|--------------------|----------------|
| Retrieval tuning | Which memory classes and filters to use | Better outcome score across repeated similar tasks |
| Procedural learning | Tool sequence, prompt recipe, test protocol | At least two successful applications with matching preconditions |
| Source ranking | Which evidence sources deserve trust | Evidence later confirmed by tests or authoritative sources |
| Forgetting policy | Which memories expire or need review | Stale, contradicted, unused, or low-confidence memories |
| Gap detection | Which uncertainty patterns matter | Gaps that predict task failure or low confidence |

### Safety And Governance

- No external communication, database write, permission change, or destructive operation without an explicit approval boundary.
- Every memory write records source, acquisition time, confidence, and extraction trace.
- Candidate memories cannot override validated memories without conflict handling.
- Sensitive values are redacted before episodic storage.
- Tool execution uses allowlists, budgets, timeouts, and per-task stop conditions.
- The agent must degrade to asking for review when a high-risk gap blocks action.

## Implementation Approach

### Proposed Package Layout

```text
aletheia/
  src/
    runtime/
      learner-loop.ts
      agent-state.ts
      policy.ts
    learning/
      gap-detector.ts
      agenda.ts
      evidence-critic.ts
    memory/
      store.ts
      schema.ts
      retrieval.ts
      consolidation.ts
    knowledge/
      context-pack.ts
      applicator.ts
      conflict-resolution.ts
    sources/
      source-provider.ts
      web-provider.ts
      gitnexus-provider.ts
      filesystem-provider.ts
    evaluation/
      outcome-evaluator.ts
      benchmarks.ts
      metrics.ts
    safety/
      redaction.ts
      permissions.ts
      budgets.ts
    cli/
      index.ts
  test/
    unit/
    integration/
    fixtures/
```

### Storage Plan

**V1 local store:** SQLite-compatible relational storage for records, provenance, traces, and policy metadata, plus pluggable vector index support. If the implementation stays inside GitNexus, this must not reuse `.gitnexus/` graph schema without a separate reviewed adapter.

**V2 hybrid store:** Add graph relationships for entity links, contradiction edges, source lineage, and procedural preconditions.

### Source Provider Contract

```typescript
export interface SourceProvider {
  name: string;
  capabilities: SourceCapability[];
  riskLevel: 'low' | 'medium' | 'high';
  search(query: SourceQuery, policy: SourcePolicy): Promise<EvidenceSource[]>;
  fetch(source: EvidenceSource, policy: SourcePolicy): Promise<SourceDocument>;
}
```

### Runtime Contract

```typescript
export interface AletheiaRuntime {
  runTask(input: TaskInput): Promise<TaskResult>;
  learnFromObservation(observation: Observation): Promise<LearningResult>;
  retrieveContext(query: KnowledgeQuery): Promise<ContextPack>;
  evaluateMemory(memoryId: string): Promise<MemoryEvaluation>;
}
```

## Development Milestones

### Milestone 0: Specification And Baseline

- Finalize this design.
- Confirm package location and dependency policy.
- Create an implementation plan after design review.

**Exit criteria:** Approved spec and task plan.

### Milestone 1: Core Types And In-Memory Runtime

- Define schemas for task, gap, evidence, memory, context, outcome, and policy.
- Implement learner loop with in-memory repositories.
- Implement deterministic mock source provider and evaluator.

**Exit criteria:** Unit tests prove gap -> evidence -> memory -> retrieval -> application cycle.

### Milestone 2: Persistent Memory Store

- Add local persistence.
- Add provenance and trace storage.
- Add redaction before episodic writes.
- Add conflict and supersession handling.

**Exit criteria:** Memories survive process restart, conflict tests pass, redaction tests pass.

### Milestone 3: Active Learning Mechanisms

- Implement gap detection for missing, stale, conflict, low-confidence, and procedural-failure cases.
- Implement agenda ranking by value, risk, cost, and dependency.
- Implement source trust scoring.

**Exit criteria:** Synthetic tasks produce expected prioritized learning tasks.

### Milestone 4: Knowledge Application

- Implement ContextPack assembly.
- Implement procedural memory matching and application.
- Implement outcome scoring and policy updates.

**Exit criteria:** Similar task family shows better second-run success or lower tool cost due to stored knowledge.

### Milestone 5: GitNexus Adapter

- Add read-only source provider that can query GitNexus context, processes, and symbol relationships.
- Keep GitNexus graph facts as evidence, not as Aletheia-owned memory.

**Exit criteria:** Agent can use GitNexus evidence for code tasks without changing GitNexus graph schema.

### Milestone 6: Evaluation Harness

- Add repeat-task benchmark.
- Add memory poisoning benchmark.
- Add stale fact benchmark.
- Add procedural transfer benchmark.

**Exit criteria:** Metrics report success lift, retrieval precision, contradiction handling, cost, and safety violations.

## Testing Protocols

### Unit Tests

| Area | Tests |
|------|-------|
| Gap detector | Missing/stale/conflict/low-confidence/procedural failure classification |
| Agenda | Priority ordering, budget cutoffs, dependency ordering |
| Evidence critic | Source trust, freshness, contradiction detection, weak evidence rejection |
| Memory writer | Provenance required, redaction, supersession, status transitions |
| Retrieval | Exact lookup, semantic lookup, graph relationship lookup, expiry filtering |
| Applicator | ContextPack assembly, procedural matching, degraded behavior |
| Evaluator | Success scoring, policy delta generation, promotion rules |

### Integration Tests

- Full learning cycle with deterministic fake source.
- Restart test proving persistent memory retention.
- Contradictory source test proving candidate memory does not overwrite validated memory.
- Repeated task test proving procedural memory reuse.
- GitNexus adapter smoke test using fixture graph responses.

### Safety Tests

- Secrets are redacted from episodic traces.
- Disallowed tools are blocked before execution.
- Budget exhaustion stops acquisition.
- High-risk gaps require review instead of autonomous action.
- Memory poisoning samples stay candidate or rejected.

### Evaluation Benchmarks

| Metric | Target for v1 |
|--------|---------------|
| Learning lift | Second attempt improves task score on synthetic benchmark by at least 20% |
| Retrieval precision | Top-5 retrieved memories contain relevant validated memory in at least 80% of benchmark cases |
| Provenance coverage | 100% of semantic and procedural memories have source references |
| Redaction reliability | 100% of seeded secret fixtures removed before storage |
| Conflict handling | 90% of direct contradiction fixtures detected |
| Procedural reuse | Reusable workflow selected in at least 70% of matching repeated tasks |
| Cost control | Learning agenda respects configured acquisition budget in 100% of tests |
| Safety boundary | 0 autonomous execution of blocked external actions in tests |

## Acceptance Criteria

Aletheia is acceptable when it can:

- Autonomously identify at least five classes of knowledge gaps.
- Seek evidence from allowed sources without human prompting.
- Store episodic, semantic, and procedural memories with provenance.
- Retrieve and apply validated knowledge to solve a later task.
- Show measurable improvement after learning on repeated benchmark tasks.
- Reject or quarantine poisoned, stale, contradictory, or weak evidence.
- Explain which memories influenced a result.
- Respect tool, budget, privacy, and approval boundaries.

## ADR Signals

This design touches durable architecture surfaces:

- New canonical owner for active-learning policy.
- New memory artifact shape.
- New source-provider contract.
- Optional future adapter to GitNexus graph evidence.

If implementation proceeds, create an ADR when the package location, storage backend, and public runtime contract are chosen.

## Open Review Questions

- Should the first implementation live as a top-level `aletheia/` package, inside `gitnexus/src/core/agent-learning/`, or outside this repository?
- Should v1 use SQLite plus a lightweight vector index, or start with an in-memory store and defer persistence until Milestone 2?
- Should web acquisition be included in v1, or should v1 use only local files, deterministic fixtures, and GitNexus evidence?

## Self-Review

- No implementation code is proposed for the existing product surface.
- No source-of-truth ownership is moved from GitNexus graph modules.
- The design separates memory ownership from evidence providers.
- Safety boundaries are explicit for external writes and communications.
- Acceptance criteria are measurable.
- Open questions are bounded to implementation planning choices.

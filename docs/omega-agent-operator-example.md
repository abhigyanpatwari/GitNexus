# Omega Agent Operator Example

Status: committed from ChatGPT session on 2026-06-01.

## Source Prompt

> I’m building an AI workspace agent for a 12-person product team.  
> It should read Slack, summarize decisions, create Linear tickets, keep project memory, and produce a weekly product-risk brief.  
> I don’t want another chatbot. I want an operator that actually reduces management overhead.  
> What should the system become, what should I kill, and what is the first version?

## Operator Mode

OMEGA run using the strategic cognition loop:

```text
DECODE -> JUDGE -> MUTATE -> SELECT -> STRUCTURE -> COMMAND
```

Full stack applied:

```text
ZERO -> TRIBUNAL -> MUTATE -> LEVER -> ASCEND -> COMMAND
```

---

## ZERO

### Essence

This is not a chatbot. It is a project-operating layer that turns team communication into decisions, tasks, memory, and risk signals.

### Core Mechanic

```text
observe team signals -> extract commitments / decisions / risks -> verify ambiguity -> write structured artifacts -> surface only what requires human judgment
```

### Minimum Viable Form

A weekly operator that reads selected Slack channels and Linear projects, then produces:

1. decision log
2. unresolved questions
3. ticket suggestions
4. product-risk brief
5. memory checkpoint

### First Move

Do not start with an autonomous agent. Start with a read-only intelligence loop.

---

## TRIBUNAL

### Charge

The idea risks becoming a generic AI productivity assistant with too many integrations, vague autonomy, and no measurable authority.

### Defense

The need is real. Product teams lose context across Slack, tickets, meetings, and decisions. A system that preserves decisions and converts ambiguity into structured follow-up has strong leverage.

### Evidence

The strongest signal is the user phrase: "I don’t want another chatbot." The winning form must be judged by operational impact, not conversational cleverness.

### Contradictions

- Wants reduced management overhead, but may create new review overhead.
- Wants action, but integrations like Slack and Linear require permission boundaries.
- Wants memory, but memory without source links becomes hallucinated project lore.
- Wants autonomy, but premature write-access can damage trust.

### Verdict

Conditionally approved. Mutate first.

### Conditions for Approval

1. Read-only first.
2. Every output must cite source messages, tickets, or meetings.
3. No ticket creation until suggestion quality is proven.
4. Memory must be append-only with correction logs.
5. Weekly brief must include confidence levels.
6. Success metric must be managerial time saved, not number of AI outputs.

---

## MUTATE

### Mutation 1: Decision Harvester

Core idea: a system that only extracts and preserves decisions from messy team communication.

How it works: scans Slack and Linear, identifies decision-like statements, groups them by project, asks for confirmation when confidence is low, and writes a weekly decision ledger.

Risk: too narrow if the team expects broader automation.

Best use case: teams drowning in Slack decisions that never reach tickets or docs.

### Mutation 2: Risk Sentinel

Core idea: a weekly product-risk intelligence agent.

How it works: detects blockers, repeated unresolved questions, scope creep, silent tickets, dependency slippage, and contradiction between roadmap and execution.

Risk: can feel negative or alarmist if not tuned carefully.

Best use case: product leads who want early warning without manually reading everything.

### Mutation 3: Ticket Forge

Core idea: a conversion engine from conversation fragments into structured Linear ticket drafts.

How it works: extracts possible tasks, adds acceptance criteria, links source context, detects duplicates, and queues drafts for approval.

Risk: can flood the backlog with low-quality tasks.

Best use case: teams where Slack constantly generates work that never becomes tracked.

### Mutation 4: Project Memory Spine

Core idea: an append-only memory atlas for product work.

How it works: creates project pages containing decisions, assumptions, risks, owners, open questions, milestones, and source-linked changes over time.

Risk: becomes stale unless automatically refreshed and corrected.

Best use case: multi-week or multi-month projects where context loss is expensive.

### Selected Mutation

Risk Sentinel + Project Memory Spine.

This pairing directly attacks management overhead. The team does not need another place to chat. It needs a durable operational picture: what changed, what matters, what is risky, and what needs a decision.

---

## LEVER

### Highest-Leverage Move

Build a read-only weekly brief generator before building an autonomous agent.

### Why

It proves value without permission risk. If the weekly brief consistently saves time, then ticket drafting and write-access become justified.

### Lever Test

After 3 weekly runs, ask:

> Did this brief reveal something important faster than the product lead would have found manually?

If yes, expand. If no, kill or narrow.

---

## ASCEND

### Current Form

AI workspace agent.

### Higher Form

Product Operations Intelligence Layer.

### Ascension Path

1. Read-only Observer  
   Summarizes Slack, Linear, and docs.

2. Memory Spine  
   Maintains source-linked decisions, risks, assumptions, and open questions.

3. Risk Sentinel  
   Detects unresolved ambiguity, project drift, bottlenecks, and silent failures.

4. Drafting Operator  
   Suggests tickets, briefs, and decision requests.

5. Controlled Executor  
   Creates tickets or updates docs only after approval.

### Final Shape

A trusted operational layer that does not replace the product manager. It removes the PM's context-reconstruction burden.

---

## COMMAND

### Orders

1. Kill the generic chatbot framing.
2. Define the first artifact as a weekly Product Risk + Memory Brief.
3. Limit v1 sources to 2 Slack channels, 1 Linear workspace/project, and optional product docs folder.
4. Generate only the required operational sections.
5. Mark every item with confidence, source, and human-review status.

### Required Brief Sections

```text
1. Executive summary
2. New decisions
3. Changed assumptions
4. Open questions
5. Emerging risks
6. Suggested Linear tickets
7. Source-linked memory checkpoint
```

### Required Item Metadata

```text
confidence: high / medium / low
source: Slack / Linear / Doc
requires_human_review: true / false
```

### Checkpoint

Run the system manually or semi-manually for 3 weeks. Measure whether it reduces the product lead’s weekly review time.

### Done State

The product lead can read one brief and know:

- what changed
- what is blocked
- what decisions were made
- what risks are rising
- what tickets should exist
- what needs human judgment

---

## Build Spec

### System

Product Operations Intelligence Layer.

A read-only AI operator that converts Slack and Linear activity into a weekly source-linked product-risk and memory brief.

### Operating Model

```text
observe -> extract -> classify -> verify -> brief -> checkpoint
```

The system does not act autonomously in v1. It recommends. Humans approve.

### Modules

```text
/connectors
  slack_reader
  linear_reader
  docs_reader_optional

/extraction
  decision_extractor
  risk_extractor
  question_extractor
  ticket_candidate_extractor

/memory
  project_memory_atlas
  decision_log
  assumption_log
  correction_log

/briefing
  weekly_brief_generator
  confidence_labeler
  source_linker

/review
  human_review_queue
  approval_state
```

### Commands

```text
/run-weekly-brief
/extract-decisions
/extract-risks
/suggest-tickets
/update-memory-checkpoint
/show-open-questions
```

### Memory

Persist only structured, source-linked records:

```text
decision
assumption
risk
open_question
ticket_candidate
correction
weekly_checkpoint
```

Never store unsupported summaries as fact.

### Workflow

```text
Monday-Friday:
  collect signals read-only

Friday:
  generate draft brief

Human review:
  approve / reject / correct

After review:
  write memory checkpoint
  carry unresolved questions forward
```

### Outputs

```text
weekly_product_risk_brief.md
decision_log.md
open_questions.md
ticket_suggestions.json
memory_checkpoint.json
```

### Risks

1. False certainty  
   Fix: confidence labels and source links.

2. Backlog spam  
   Fix: ticket suggestions only, no automatic creation.

3. Privacy concerns  
   Fix: scoped channels, explicit permissions, no DMs in v1.

4. Stale memory  
   Fix: correction log and weekly checkpointing.

5. Over-automation  
   Fix: read-only first, approval-gated writes later.

### First Version

A CLI or scheduled script that ingests exported Slack/Linear data and produces one markdown brief plus one JSON memory checkpoint.

### Next Move

Create the v1 schema:

- SourceMessage
- Decision
- Risk
- OpenQuestion
- TicketSuggestion
- WeeklyBrief
- MemoryCheckpoint

This creates the operational spine before integrations, dashboards, or autonomy.

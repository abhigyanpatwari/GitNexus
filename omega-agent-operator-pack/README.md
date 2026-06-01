# OMEGA Agent Operator Artifact Pack

Date: 2026-06-01
Repo target: AUUU-os/GitNexus
Mode: full-pack
Autonomy: A2 proposal-and-approval operator

## Purpose

This pack turns the OMEGA Agent Operator checkpoint into a reusable autonomous-agent operating artifact. It is not a deployed runtime. It is a source-of-truth package containing the prompt, agent spec, MCP contract, hooks, architecture, evals, and project state needed to build or operate the agent safely.

## OMEGA Loop

```text
Observe -> Orient -> Decide -> Act -> Learn
```

## Pack Contents

```text
README.md
docs/PROJECT_STATE.md
docs/ARCHITECTURE.md
docs/AGENT_BLUEPRINT.md
prompts/OMEGA_AGENT_MASTER_PROMPT.md
agents/omega-agent.agent.yaml
mcp/MCP_CONTRACT.md
hooks/hooks_manifest.yaml
evals/BEHAVIORAL_EVALS.md
```

## Operating Boundary

The default operator is approval-gated. It may read context, draft artifacts, and propose tool calls, but it must not perform destructive actions, external sends, deployment, purchases, credential changes, or irreversible writes without explicit approval and logs.

## Quick Start

1. Read `docs/PROJECT_STATE.md`.
2. Use `prompts/OMEGA_AGENT_MASTER_PROMPT.md` as the system/master prompt.
3. Configure the agent from `agents/omega-agent.agent.yaml`.
4. Implement or map tools using `mcp/MCP_CONTRACT.md`.
5. Register lifecycle events from `hooks/hooks_manifest.yaml`.
6. Validate behavior using `evals/BEHAVIORAL_EVALS.md`.

## Current Status

Documentation/specification pack complete. No runtime has been deployed and no autonomous execution has been activated.

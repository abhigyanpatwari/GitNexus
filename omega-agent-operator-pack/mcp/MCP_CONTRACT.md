# MCP Contract

## Purpose

Define the tool/resource/prompt surface for OMEGA Agent Operator. This is a contract, not a live server implementation.

## Resources

### project_state

Read current project state and checkpoint lineage.

```text
resource://omega/project_state
```

### artifact_index

List known generated artifacts and their verification status.

```text
resource://omega/artifacts
```

### decision_log

Read prior decisions and approval boundaries.

```text
resource://omega/decisions
```

## Tools

### create_artifact

Create a proposed artifact in the workspace.

Input:

```json
{
  "path": "string",
  "content": "string",
  "artifact_type": "markdown|yaml|json|code|other"
}
```

Output:

```json
{
  "path": "string",
  "created": true,
  "checksum": "string"
}
```

### verify_artifact_pack

Verify that required pack files exist and are non-empty.

Input:

```json
{
  "root": "string",
  "required_files": ["string"]
}
```

Output:

```json
{
  "ok": true,
  "missing": [],
  "present": []
}
```

### create_checkpoint

Persist a continuity checkpoint.

Input:

```json
{
  "project": "string",
  "summary": "string",
  "artifacts": ["string"],
  "next": "string"
}
```

Output:

```json
{
  "checkpoint_id": "string",
  "path": "string"
}
```

### propose_tool_action

Create an approval-ready external action proposal.

Input:

```json
{
  "action": "string",
  "target": "string",
  "risk": "low|medium|high",
  "rollback": "string"
}
```

Output:

```json
{
  "requires_approval": true,
  "proposal_id": "string"
}
```

## Prompts

### omega_plan

Generate an Observe -> Orient -> Decide -> Act -> Learn plan.

### omega_handoff

Generate final deliverable, verification, and next move.

## Hook Events

The MCP implementation should emit hook events defined in `hooks/hooks_manifest.yaml`.

## Security

- Tools must be allowlisted.
- Destructive actions require approval.
- Every external write must be logged.
- Secrets must never be written to artifacts.

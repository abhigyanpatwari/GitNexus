# OMEGA Agent Operator Runtime Scaffold

Local-first runtime scaffold for the OMEGA Agent Operator artifact pack.

## Status

Runnable scaffold, not a deployed autonomous service.

Default autonomy: `A2` proposal-and-approval.

## What It Provides

- OMEGA loop: Observe -> Orient -> Decide -> Act -> Learn
- CLI runner
- FastAPI app
- SQLite project memory
- Hook event logging
- Approval-gated action proposals
- Artifact writer
- Behavioral tests

## Quick Start

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e .[dev]
pytest
omega run "Build a checkpoint for the current project"
omega api
```

Then open:

```text
http://127.0.0.1:8000/health
```

## Safety Boundary

The runtime does not execute destructive actions. It can propose actions and write local artifacts, but external writes, deployments, credential changes, deletions, and scheduled autonomy require explicit approval.

## Project Layout

```text
src/omega_operator/
  __init__.py
  api.py
  approvals.py
  artifacts.py
  cli.py
  config.py
  hooks.py
  memory.py
  models.py
  runtime.py
  safety.py

tests/
  test_runtime.py
  test_memory.py
  test_safety.py
```

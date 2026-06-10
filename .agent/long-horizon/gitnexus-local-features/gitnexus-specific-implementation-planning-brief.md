# GitNexus-Specific Implementation Planning Brief

Use this when you want a planning-only implementation brief for work in the GitNexus repo and want the planner to ground itself in the real repository before proposing changes.

This is a project-specific prompt artifact for `C:\Users\steve\projects\gitnexus\source-rc109-integration`, not a generic planning template.

## Intended Use

Use this brief when you want:

- planning only
- no source edits yet
- a repo-grounded implementation plan
- explicit inspection of architecture, entry points, dependencies, tests, and conventions before planning

Do not use it when you want immediate implementation.

## GitNexus Repo Context To Preserve

The planner should ground itself in the current repo before drafting the plan.

Known top-level structure:

- `gitnexus/` = CLI, MCP server, HTTP API, ingestion pipeline, graph logic
- `gitnexus-web/` = Vite/React web UI
- `gitnexus-shared/` = shared TypeScript types/constants
- `.agent/long-horizon/gitnexus-local-features/` = long-horizon control bundle

Current canonical architecture reference:

- `ARCHITECTURE.md`

Common entry points:

- `gitnexus/src/cli/index.ts`
- `gitnexus/src/server/api.ts`
- `gitnexus/src/mcp/local/local-backend.ts`

Current relevant build/test commands:

From `gitnexus/package.json`:

- `npm run build`
- `npm test`
- `npm run test:unit`
- `npm run test:integration`
- `npm run dev`

From `gitnexus-web/package.json`:

- `npm run build`
- `npm test`
- `npm run dev`

Current workflow expectations for this branch:

- work on `local/gitnexus-local-features`
- inspect existing patterns before proposing new abstractions
- prefer focused tests first
- preserve deterministic CLI/report contracts where already established
- keep plans aligned with the long-horizon control bundle when the task belongs to that workstream

## Prompt To Use

```text
PLANNING TASK ONLY. DO NOT MODIFY FILES. DO NOT IMPLEMENT YET.

I want an end-to-end implementation plan for:

[describe the goal]

Before writing the plan, inspect the repository and relevant files. Identify the current architecture, entry points, dependencies, test setup, build commands, and any existing patterns that should be followed.

For this GitNexus repo, you should at minimum inspect:
- ARCHITECTURE.md
- gitnexus/package.json
- gitnexus-web/package.json
- gitnexus/src/cli/index.ts
- gitnexus/src/server/api.ts
- gitnexus/src/mcp/local/local-backend.ts
- the most relevant feature-specific source and tests for the requested goal

Your output must be a complete implementation plan with these sections:

1. Objective
   - What the change is intended to achieve.
   - What is explicitly out of scope.

2. Current-state analysis
   - Relevant files, modules, functions, routes, components, configs, and tests.
   - How the existing system currently works.
   - Any constraints or conventions found in the repo.

3. Proposed design
   - The technical approach.
   - New or changed components.
   - Data flow / control flow.
   - Any alternatives considered and why they are rejected.

4. Implementation sequence
   - Break the work into ordered phases.
   - Each phase should have concrete tasks.
   - Include the files likely to be changed in each phase.
   - Explain dependencies between phases.

5. Testing and validation
   - Unit tests, integration tests, type checks, lint checks, manual checks.
   - Exact commands to run where possible.
   - Expected successful outcomes.

6. Risks and edge cases
   - Failure modes.
   - Ambiguities.
   - Backward compatibility issues.
   - Security, performance, or maintainability concerns.

7. Acceptance criteria
   - Clear conditions that define “done”.
   - Include observable behaviours, not vague statements.

8. PR / commit breakdown
   - Suggest how this should be split into reviewable commits or PRs.

9. Open questions
   - Only include questions that genuinely block implementation.
   - If something can be inferred from the repo, infer it and state the assumption.

Additional GitNexus-specific planning rules:
- Follow existing CLI/MCP/API/report patterns before proposing new surfaces.
- Prefer deterministic JSON/Markdown contracts where similar features already use them.
- Name the exact test files and commands most relevant to the requested feature.
- Separate local closed-world behavior from deferred GitHub/provider/CI/external automation where relevant.
- If the goal belongs to the local-features workstream, reconcile the plan with:
  - `.agent/long-horizon/gitnexus-local-features/prompt.md`
  - `.agent/long-horizon/gitnexus-local-features/plans.md`
  - `.agent/long-horizon/gitnexus-local-features/implement.md`
  - `.agent/long-horizon/gitnexus-local-features/documentation.md`
  - `.agent/long-horizon/gitnexus-local-features/feature-map.md`

STOP after producing the plan. Do not write code until I explicitly say:
“Proceed with implementation.”
```

## Recommended Usage Notes

- Replace `[describe the goal]` with one feature or one tightly bounded vertical slice.
- If the goal is part of the local-features workstream, keep the requested plan aligned with the selected-task model already used in the long-horizon docs.
- If the goal touches CLI, MCP, API, and report surfaces together, ask for one end-to-end plan rather than separate mini-plans.
- If the goal is broad, prefer one implementation plan per top-level slice rather than one giant all-feature plan.

## Example GitNexus-Specific Starters

- `I want an end-to-end implementation plan for Task 2 Wiki Usage-Hardening.`
- `I want an end-to-end implementation plan for expanding pr-impact toward a GitHub-facing local workflow.`
- `I want an end-to-end implementation plan for the next bounded OCaml semantics slice.`


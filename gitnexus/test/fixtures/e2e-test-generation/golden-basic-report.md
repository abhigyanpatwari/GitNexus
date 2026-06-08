# GitNexus E2E Test Plan Report

Confidence: MEDIUM

Schema: e2e-test-plan.v1alpha1

## Target Contract

- App: gitnexus-web
- Framework: playwright
- Browser: chromium
- Backend: http://localhost:4747
- Frontend: http://localhost:5173
- Fixture policy: CI mini fixture repo indexed before E2E run

## Summary

- Proposed scenarios: 2
- Covered by existing spec: 1
- New proposals: 1
- High priority: 1
- Impact evidence mode: pr-impact
- Source impact verdict: BLOCK
- Regression Forensics confidence: MEDIUM

## Proposed Scenarios

| Scenario | Priority | Status | Target Spec | Evidence |
| --- | --- | --- | --- | --- |
| Exercise route /api/grants after impacted API change | HIGH | covered_by_existing_spec | gitnexus-web/e2e/grants.spec.ts | Route /api/grants has risk HIGH; Consumers: 3; Mismatches: 1; api_impact reported consumers and one shape mismatch |
| Add E2E scenario for changed surface renderGraph | MEDIUM | new_proposal | gitnexus-web/e2e/render-graph.spec.ts | Risk: MEDIUM; Direct dependents: 2; Processes affected: 1; Test reference: unknown_or_unreferenced |

## Caveats

- High-risk impact has no known graph-derived test reference.
- V1 proposes scenarios only; it does not generate executable test files.
- Browser execution, generated Playwright files, CI mutation, and GitHub automation are out of scope.

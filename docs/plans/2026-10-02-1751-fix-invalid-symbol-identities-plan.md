---
title: Invalid Symbol Identities - Plan
type: fix
date: 2026-10-02
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Invalid Symbol Identities - Plan

## Goal Capsule

- Objective: Context and impact users never receive relationship results anchored to a missing or corrupted symbol identity.
- Means: Validate database lookup identities before symbol selection and graph traversal; return actionable errors through existing tool envelopes.
- Authority: Issue #3424 defines the defect; repository instructions govern execution; this plan defines the bounded correction.
- Execution: Implement regression tests first, then verify the shared resolver and public context/impact responses.
- Stop conditions: An incompatible valid-ID requirement or evidence requiring a native database change needs renewed diagnosis before widening the fix.
- Tail ownership: LFG owns review, commit, PR creation, and CI. No release or merge is part of this change.

---

## Product Contract

### Summary

Reject malformed identities returned by symbol lookup before context or impact can use them to query relationships.
Preserve valid lookups and provide a clear instruction to rebuild an invalid index.

### Problem Frame

[Issue #3424](https://github.com/abhigyanpatwari/GitNexus/issues/3424) reports a Python method with a missing or NUL-filled UID returning unrelated Swift callers and exact context claims.
Its original repository is confidential and no reduced reproducer exists.
At main commit `412446408d0e3f286b9e461fc451c25bf6283b3c`, the shared resolver accepts projected IDs without runtime validation.
The incremental write checks from #3442 do not establish the validity of every later read or legacy index.

### Requirements

- R1. A lookup row with a missing, non-string, blank, or NUL-containing ID must fail before enrichment, selection, or relationship traversal, including group impact's direct UID adapter.
- R2. A direct UID lookup returning a different ID must fail; invalid candidates must never be silently removed to create a confident winner.
- R3. Context and callgraph/PDG impact must report an actionable index error for R1/R2; impact must retain unknown risk and an undetermined count rather than a zero blast radius.
- R4. Healthy name/file and UID lookups, legacy ID formats, empty lookups, and incomplete optional metadata retain existing behavior.
- R5. A deterministic mixed Python/Swift fixture must show that a Python method keeps its identity and only its actual callers.

### Scope Boundaries

The correction covers symbol lookup and the context/impact error envelopes.
It does not invent a Python-specific resolver rule, alter graph persistence, or claim to repair valid-ID relationships already stored incorrectly.
Group tools retain their existing aggregation/degradation contracts; the shared resolver must not return malformed anchors to any caller.

### Acceptance Examples

- AE1. Covers R1/R3: A Python lookup row with a NUL-filled ID returns an error and rebuild guidance without running a relationship query or reporting exact context.
- AE2. Covers R2: A valid candidate beside a malformed candidate returns an error rather than selecting the valid candidate.
- AE3. Covers R4/R5: A Python method with same-named Swift symbols returns the Python UID and expected Python callers when selected by file or UID.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Validate the shared resolver's database row identities immediately after projection normalization, before any enrichment or candidate filtering. Reuse the same check in `impactByUid`, which bypasses that resolver, retaining its existing null-on-failure contract.
- KTD2. Treat the ID as opaque. Check runtime string validity and reject NUL without trimming, rewriting, or requiring a modern label/path grammar. Existing tests intentionally use legacy IDs and sparse Tool nodes.
- KTD3. Use a distinguishable internal identity error and reuse existing context and impact error envelopes. Recovery guidance must recommend an explicit-repository forced rebuild; suggesting context as a fallback for this error would repeat the same unsafe lookup.
- KTD4. Use mocked projection failures for deterministic bad-read coverage and the native indexed-DB harness for healthy cross-language isolation. Neither test is evidence of the original macOS native corruption mechanism.

### Assumptions

The reported unusable identity is enough to justify rejecting that response even when the original corrupt database is unavailable.
Additional direct-UID mismatch protection belongs to the same lookup contract.
Optional label and source-range omissions remain supported.
No external research is needed for this correction: the resolver, existing error envelopes, and native test harness define the relevant behavior locally.

### System-Wide Impact

The resolver is shared by context, impact, trace, rename, PDG queries, and group resolution.
Valid results must remain unchanged; other consumers retain their existing handling of resolver failures.
The new checks are bounded by the existing candidate window and add no database query.

---

## Implementation Units

### U1. Reject invalid lookup identities and report actionable errors

**Goal:** Enforce R1-R4 and AE1-AE2 at the shared lookup boundary.

**Dependencies:** None.

**Files:** `gitnexus/src/mcp/local/local-backend.ts`; `gitnexus/test/unit/symbol-identity-validation.test.ts`.

**Approach:** Follow KTD1-KTD3. Keep validation local to symbol lookup and preserve the current error envelopes. Verify the direct UID matches the requested UID before returning success.

**Patterns to follow:** `mcp-context-route-chain.test.ts` for public-backend mocking; `impact` and `makePdgImpactErrorResult` for unknown-risk error responses.

**Execution note:** Demonstrate failing tests against the unmodified resolver before applying the correction.

**Test scenarios:**

1. Covers AE1: Missing, null, numeric, empty, whitespace-only, embedded-NUL, and NUL-only IDs in object and tuple rows fail for context and both impact modes without traversal.
2. Covers AE2: A mixed valid/invalid candidate set fails before label enrichment or ambiguity selection.
3. A direct UID result that differs from the requested ID fails; a matching opaque ID remains accepted.
4. An empty lookup keeps its existing not-found behavior.
5. Existing legacy IDs and omitted optional metadata remain accepted.
6. Group impact's direct UID adapter returns its existing failure sentinel for a malformed or mismatched ID without running BFS; legitimate synthetic IDs remain accepted.

**Verification:** Tests assert public error outcomes and absence of relationship queries, not just helper return values. Existing resolver/impact unit tests and TypeScript compilation pass.

### U2. Verify cross-language isolation through the native backend

**Goal:** Enforce R4-R5 and AE3 with real database queries.

**Dependencies:** U1.

**Files:** `gitnexus/test/integration/symbol-identity-isolation.test.ts`; existing `gitnexus/test/helpers/test-indexed-db.ts` is the harness reference.

**Approach:** Follow KTD4. Seed distinct Python and Swift symbols with intentionally colliding names and separate call edges. Query context and upstream impact through `LocalBackend.callTool` using file hints and returned UIDs.

**Test scenarios:**

1. Covers AE3: Python name/file selection returns the expected stable UID and Python caller while excluding Swift callers and constructors.
2. UID lookup produces the same target and relationship set.
3. Healthy Swift lookups still resolve their own callers.

**Verification:** Native tests assert exact identities and caller membership; existing `local-backend-calltool.test.ts` and impact suites continue passing.

---

## Verification Contract

Run targeted new unit and native integration tests, plus existing resolver, UID, ambiguity, context, and impact tests.
Run `npm test` and `npx tsc --noEmit` from `gitnexus/`, reporting any environment or baseline failures separately.
Run the repository-required graph impact checks before edits and `detect-changes` before commit; incomplete results are unresolved evidence.
Review the diff for unchanged valid-query behavior and absence of speculative persistence changes.

## Definition of Done

All applicable requirements have passing regression evidence, including a before/after failure at the invalid-row boundary.
The PR describes the prevented failure and the unverified native root cause separately.
No abandoned diagnostic code, generated index files, or unrelated edits remain in the diff.

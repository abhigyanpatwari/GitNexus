# Master Index: Namespace Isolation & Markdown Integration

This document serves as the comprehensive table of contents based on the C4 Bottom-Up navigation principle of the GitNexus system.

## 1. System Level (L1)
- [System Context](./system-context.md): Overview of the task, Actors, Boundaries, and the reason the system exists.

## 2. Cross-cutting
- [Glossary - Unified Terminology](./glossary.md): Standardization of naming conventions.
- [Data Flow Diagram](./data-flow.md): The data transfer flow from hard disk down to the LLM Response.

## 3. Ingestion Pipeline
The Container block responsible for dissecting Source code and Text, forcing them into the Graph Database.

- **[Container: Ingestion Pipeline](./ingestion/ingestion-pipeline.md)**
  - **[Component: Git Boundary Detector](./ingestion/git-detector/detector.md)**
    - [Code (Module): `git-namespace-detector.ts`](./ingestion/git-detector/git-namespace-detector.md)
  - **[Component: Markdown AST Parser](./ingestion/markdown/parser.md)**
    - [Code (Module): `markdown-processor.ts`](./ingestion/markdown/markdown-processor.md)

## 4. Search & Query Engine
The Container block responsible for matching Vectors and Filtering by Namespace for the Agent.

- **[Container: Search Engine](./search/search-engine.md)**
  - **[Component: Hybrid Search Mechanism](./search/hybrid/hybrid.md)**
    - [Code (Module): `hybrid-search.ts`](./search/hybrid/hybrid-search.md)

## 5. Verification Pipeline (Quality Assurance)
The Censorship Container block. Confirms reliability and prevents Regression via End-to-End test cases.

- **[Container: Verification Pipeline](./testing/testing-verification.md)**
  - [Code (Module): `git-namespace-detector.test.ts`](./testing/detector-unit-tests.md)
  - [Code (Module): `markdown-pseudocode.test.ts`](./testing/markdown-unit-tests.md)
  - [Code (Module): `namespace-isolation.test.ts`](./testing/integration-tests.md)

## 6. Architecture Decisions (ADR)
- [ADR-001: KuzuDB Schema Modifications](./architecture-decisions/ADR-001-kuzudb-schema.md)

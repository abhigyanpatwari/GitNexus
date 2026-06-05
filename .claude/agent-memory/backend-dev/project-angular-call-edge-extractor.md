---
name: angular-call-edge-extractor
description: WI-#31 added extractAngularCalls() in 2026-06; emits CALLS edges from @NgModule providers to DI tokens and from @Component template bindings to bound methods
metadata:
  type: project
---

WI-#31 (closed 2026-06) added `extractAngularCalls()` in `gitnexus/src/core/ingestion/extractors/angular-metadata.ts` alongside the existing `extractAngularMetadata()` (which emits non-CALLS edges DECLARES / IMPORTS_MODULE / PROVIDES / BOOTSTRAPS for #32).

**What it emits:**
- `@NgModule({ providers: [UserService, AuthService] })` → CALLS edge from `Class:<file>:<className>` → `UserService`, `AuthService` (form: `callForm: 'free'`)
- `@Component({ template: '<button (click)="onClick()">…' })` → CALLS edge from `Class:<file>:<ComponentName>` → `onClick` (form: `callForm: 'member'`, `receiverName: 'this'`, `receiverTypeName: <ComponentName>`)
- Handles both `string` and `template_string` (backtick literal) for the template value.
- Template-binding regex: `/\(\s*\w+\s*\)\s*=\s*"([A-Za-z_$][\w$]*)\s*\([^"]*\)"/g` — matches `(click)="onClick()"`, `(input)="onInput($event)"`, etc. Captures only the method name.

**How it wires in:** The parse-worker (`gitnexus/src/core/ingestion/workers/parse-worker.ts`) calls `extractAngularCalls(tree, filePath)` for every .ts/.js file, then converts the returned `AngularCallRecord[]` into `ExtractedCall[]` and pushes them into `result.calls`. From there they flow through `processCallsFromExtracted` (graph CALLS edges are only created if the called name resolves to a node in the same file or an imported file).

**Why:** Issue #31 reported the context tool didn't show `AppModule → UserService` (DI) or `AppComponent → onClick` (template) edges. After the fix, both patterns are indexed.

**How to apply:** New Angular metadata extractors should follow the same pattern (separate function, dedicated interface, returns records, worker converts to canonical `ExtractedCall[]`). Tests in `test/unit/angular-metadata.test.ts` (15 tests) cover providers, single/empty arrays, template bindings with/without args, multiple bindings, and the combined NgModule+Component case. Existing 19 angular route tests in `test/unit/route-extractors/angular.test.ts` remain unchanged and must keep passing.

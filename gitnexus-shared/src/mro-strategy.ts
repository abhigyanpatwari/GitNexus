/**
 * MRO (Method Resolution Order) strategy — shared between CLI and any
 * future consumer that reasons about multiple-inheritance semantics.
 *
 * Lives in `gitnexus-shared` so the low-level resolution module
 * (`core/ingestion/model/resolve.ts`) does not need to import from
 * `languages/` — keeping the `model/` layer free of language-registry
 * coupling.
 *
 * Strategy semantics:
 * - `first-wins`:       BFS ancestor walk, first match wins (default).
 * - `leftmost-base`:    BFS ancestor walk, leftmost base wins (C++).
 * - `c3`:               C3-linearized ancestor order, first match wins (Python).
 * - `implements-split`: BFS walk, first match wins (Java/C#/Kotlin) — full
 *                       interface-default ambiguity is handled at graph level.
 * - `qualified-syntax`: No auto-resolution (Rust — requires `<T as Trait>::m`).
 */
export type MroStrategy =
  | 'first-wins'
  | 'c3'
  | 'leftmost-base'
  | 'implements-split'
  | 'qualified-syntax';

// Scenario-map controls fixture (Phase 1 U17), pair `numeric-boundary`. A constants-only module:
// it declares no function, so its code runs only while the module loads, a phase V8 per-test
// coverage discards. The facet must find PAGE_LIMIT through the static import closure (KTD6).

/** Largest page size a listing request may ask for. */
export const PAGE_LIMIT = 100;

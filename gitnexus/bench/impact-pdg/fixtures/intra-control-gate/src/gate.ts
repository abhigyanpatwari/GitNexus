// Pure intra-procedural CONTROL-dependence fixture — SOURCE-ONLY (KTD9 anchor).
// Unlike the sibling control fixtures, this fixture's intra_AIS is NOT reconciled
// against the live traversal: each guarded arm is a SINGLE statement on its own
// block, so there is no consecutive-statement coalescing to surprise the
// source-derived annotation. It exists to give the corpus one independent data
// point — if the traversal matches an annotation written purely from language
// semantics, F1=1.0 is a genuine confirmation, not self-consistency.

export function gate(ok: boolean): number {
  if (!ok) {
    return 0;
  }
  return 1;
}

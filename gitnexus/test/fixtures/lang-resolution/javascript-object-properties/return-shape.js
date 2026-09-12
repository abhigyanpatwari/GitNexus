// R3-4: an anonymous literal in return position — the dominant shape in
// idiomatic JS (437 sites in one backend directory of the reporting repo),
// including the ~25-field payload of its entire signal pipeline. It binds to
// nothing, so its keys had no anchor and could not be named at all.
export function formatAlert(row) {
  const shorthandOnlyField = row.shorthand;
  return {
    returnShapeOnlyField: row.raw,
    sharedWithDeclared: row.other,
    // SHORTHAND — the commonest spelling, and the one `(pair)` cannot match.
    // The reporting repo's own alert payload is mostly this form.
    shorthandOnlyField,
  };
}

// A SECOND function returning a same-named key. Two distinct shapes, so two
// distinct nodes — qualifying by the owning function is what keeps them apart.
export function formatSummary(row) {
  return {
    summaryOnlyField: row.summary,
  };
}

// The reader. Untyped receiver, so this is the name-inference path.
export function readsReturnShape(alert) {
  return alert.returnShapeOnlyField;
}

// The R2-1b GUARANTEE, as a fixture: a DECLARED anchor for the same name.
// `sharedWithDeclared` is both a named-object key and a return-shape key, and a
// read of it must keep resolving to the DECLARED one — otherwise indexing
// return shapes would silently move existing answers.
export const declaredHome = {
  sharedWithDeclared: 1,
};

export function readsShared(bag) {
  return bag.sharedWithDeclared;
}

// Anonymous functions give nothing to qualify by, so their return shapes stay
// unanchored rather than colliding on a shared empty owner.
export const anonHolder = [
  function (row) {
    return { anonReturnKey: row.x };
  },
];

// The production anchor for a name a test fixture also constructs. A read here
// must resolve to THIS one, not to the fixture's.
export function buildProductionShape(row) {
  return {
    productionAndTestField: row.real,
  };
}

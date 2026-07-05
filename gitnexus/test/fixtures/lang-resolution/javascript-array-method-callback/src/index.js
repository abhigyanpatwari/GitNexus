function transform(account) {
  return account.id;
}

function predicate(account) {
  return account.active;
}

// Control: a normal named function whose body calls `transform` directly.
// Proves the registry-primary resolver wires same-file free calls for this
// fixture, so the callback assertions below are not vacuous.
function run(account) {
  return transform(account);
}

const accountsList = [];

// #1876: array higher-order-method callbacks at module scope. Pre-fix the JS
// scope model emitted a phantom `Function:exportData` / `Function:firstActive`
// for these callbacks (they match the HOC-wrapped-arrow declaration pattern),
// and calls INSIDE the callbacks (`transform`, `predicate`) attributed to that
// phantom Function. Post-fix the callback is no longer a `Function` def, so the
// inner calls fall through to the enclosing File scope.
const exportData = accountsList.map((account) => transform(account));
const firstActive = accountsList.find((account) => predicate(account));

module.exports = { run, exportData, firstActive };

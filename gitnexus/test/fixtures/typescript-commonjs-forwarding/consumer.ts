const { changed, stable, renamedChanged, renamedStable } = require('./forward');
export function callChanged() { return changed(); }
export function callStable() { return stable(); }
export function callRenamedChanged() { return renamedChanged(); }
export function callRenamedStable() { return renamedStable(); }

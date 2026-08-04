import { Deps } from './deps';

// `r` is a bare-name receiver whose type binding is the member expression
// `d.repo` — the chain-typebinding shape that reaches Case 3b. The fold lands
// on the Repo INTERFACE, so the primary edge targets Repo.save and the
// implementations are reachable only through the interface-dispatch fan-out.
export function runSave(d: Deps): void {
    const r = d.repo;
    r.save('row');
}

// Same shape, concrete owner: Case 3b resolves PlainCache, which is not an
// Interface, so the fan-out must stay inert.
export function runCache(d: Deps): void {
    const c = d.cache;
    c.run();
}

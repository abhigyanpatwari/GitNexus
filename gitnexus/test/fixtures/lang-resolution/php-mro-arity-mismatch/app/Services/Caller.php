<?php

namespace App\Services;

use App\Models\ChildModel;
use App\Models\Orphan;

class Caller
{
    public function callIncompatible(): void
    {
        // ChildModel::method takes 2 args; ParentModel::method takes 1.
        // Class-name receiver -> hits Case 2 (findClassBindingInScope) in
        // receiver-bound-calls.ts.
        // Pre-fix bug: MRO walk emits a false CALLS edge to ParentModel::method
        // because Case 2 used `continue` on arity mismatch and fell through.
        // Post-fix: zero edges (PHP throws ArgumentCountError at runtime).
        ChildModel::method(1);
    }

    public function callCompatible(): void
    {
        // Happy path: ChildModel::compat takes 1 arg; matches call site.
        ChildModel::compat(1);
    }

    public function callNoParent(): void
    {
        // Orphan::method takes 2 args; called with 1; no parent class exists.
        // Pre-fix: same Case 2 bug — the loop exhausts with memberDef cleared,
        // BUT with `continue` the loop simply ends after one iteration since
        // the chain has only one entry; no edge would have been emitted here
        // even pre-fix. Post-fix: same — zero edges. Documents the boundary.
        Orphan::method(1);
    }

    public function callMostDerivedHappy(): void
    {
        // Happy path: ChildModel::method takes 2 args; matches call site.
        ChildModel::method(1, 2);
    }
}

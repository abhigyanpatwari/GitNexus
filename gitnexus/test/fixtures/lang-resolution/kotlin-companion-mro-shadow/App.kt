// Fixture for U2 (#1756 remediation plan): MRO shadowing and same-arity
// static+instance collision in receiver-bound dispatch.
//
// Three scenarios:
//   1. `Child` has only a companion `foo` AND extends `Base` whose
//      instance `foo` is the legitimate target. The static-only filter
//      must run INSIDE the MRO chain walk so the chain falls through to
//      `Base.foo` instead of aborting on `Child.Companion.foo`.
//   2. `ChildWithInstance` has BOTH an instance `foo` AND a same-arity
//      companion `foo`. The filter must run BEFORE arity narrowing so
//      the pair doesn't collapse to OVERLOAD_AMBIGUOUS — Kotlin compile-
//      resolves this unambiguously to the instance method because
//      companion members are not legal instance-dispatch candidates.
//   3. `Standalone` only has a companion `foo` (no instance ancestor).
//      The chain walk filters every owner; no edge should be emitted.
open class Base {
    open fun foo() {}
}

class Child : Base() {
    companion object {
        fun foo(): Child = Child()
    }
}

class ChildWithInstance : Base() {
    fun foo(): Int = 0
    companion object {
        fun foo(): ChildWithInstance = ChildWithInstance()
    }
}

class Standalone {
    companion object {
        fun foo(): Standalone = Standalone()
    }
}

// Should resolve to Base.foo via MRO chain skip past static-only Child.foo.
fun useChild(c: Child) {
    c.foo()
}

// Should resolve to ChildWithInstance.foo (instance, not companion, not Base).
fun useChildWithInstance(c: ChildWithInstance) {
    c.foo()
}

// Should emit no edge — entire chain is static-only.
fun useStandalone(s: Standalone) {
    s.foo()
}

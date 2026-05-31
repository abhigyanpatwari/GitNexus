class A {
    func m() {
        // A's distinctly-named method (resolves via the FIRST if-let
        // clause binding `a: makeA() -> A`).
    }
}

class B {
    func shared() {
        // B.shared — SAME method name as Decoy.shared below, so a bare
        // `b.shared()` is ambiguous for a unique-name global fallback and
        // can ONLY resolve to B.shared via the SECOND if-let clause binding
        // `b: makeB() -> B`. A first-clause-only reader misses that binding,
        // so `b.shared()` stays unresolved.
    }
}

class Decoy {
    func shared() {
        // collides with B.shared to defeat the name-only fallback.
    }
}

func makeA() -> A {
    return A()
}

func makeB() -> B {
    return B()
}

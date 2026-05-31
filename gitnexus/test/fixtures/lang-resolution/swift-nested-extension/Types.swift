enum Foo {
    struct Bar {
        func base() {
            // Bar's own method. A same-named `base` lives on Decoy below,
            // so a bare `base()` call is ambiguous for a unique-name global
            // fallback — it resolves to Bar.base only when the extension's
            // `self` is the trailing type `Bar`.
        }
    }
}

class Decoy {
    func base() {
        // collides with Bar.base to defeat the name-only fallback.
    }
}

// #1992: GENERIC inherent-impl ownership. Two same-tail `Inner<T>` types under
// sibling mods, each with a generic inherent impl `impl<T> Inner<T>`. Their
// methods must own through DISTINCT mod-qualified Impl nodes (`a.Inner` /
// `b.Inner`), not orphan to File.
pub mod a {
    pub struct Inner<T> { v: T }
    impl<T> Inner<T> {
        pub fn fa(&self) {}
    }
}

pub mod b {
    pub struct Inner<T> { v: T }
    impl<T> Inner<T> {
        pub fn fb(&self) {}
    }
}

// Scoped-generic inherent impl: `impl<T> crate::c::Scoped<T>` is a `generic_type`
// wrapping a `scoped_type_identifier`. tree-sitter-queries materializes NO
// @definition.impl node for this shape, so `fd` must stay orphaned (scoped-generic
// deferred, #1992) — the owner walk must NOT mint a phantom `c.Scoped` owner.
pub mod c {
    pub struct Scoped<T> { v: T }
}
pub mod d {
    impl<T> crate::c::Scoped<T> {
        pub fn fd(&self) {}
    }
}

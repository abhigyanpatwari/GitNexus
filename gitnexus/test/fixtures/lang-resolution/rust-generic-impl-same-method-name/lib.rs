// #1992 follow-up (F3): two same-tail generic inherent impls that ALSO share a
// method name. Pre-fix the Method node id keys `${className}.${name}` with the
// BARE tail (`Inner.m`), so `a::Inner::m` and `b::Inner::m` collapse onto ONE
// Method node (graph addNode is first-write-wins). Both HAS_METHOD edges then
// point at the survivor, silently losing the second method. Qualifying
// `className` (`a.Inner` / `b.Inner`) keys them as `a.Inner.m` / `b.Inner.m`, so
// BOTH Method nodes survive and each owns through its own mod-qualified Impl node.
pub mod a {
    pub struct Inner<T> {
        v: T,
    }
    impl<T> Inner<T> {
        pub fn m(&self) {}
    }
}

pub mod b {
    pub struct Inner<T> {
        v: T,
    }
    impl<T> Inner<T> {
        pub fn m(&self) {}
    }
}

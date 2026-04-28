// Trait "parent" — methods on a Rust trait are NOT reachable via direct
// `obj.method()` syntax on structs that implement the trait unless the trait
// itself is in scope. Our qualified-syntax MRO strategy reflects this: direct
// member calls do NOT walk trait ancestry, so `c.trait_only()` below should
// produce NO CALLS edge to `Parent::trait_only`.

pub trait Parent {
    fn trait_only(&self) -> &str {
        "parent-default"
    }
}

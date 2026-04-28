use crate::parent::Parent;

pub struct Child;

impl Child {
    // Direct impl method — MUST resolve via resolveMemberCall owner-scoped path.
    pub fn own_method(&self) -> &str {
        "child-own"
    }
}

// Trait implementation — `trait_only` is provided by the trait's default impl
// but is NOT reachable via direct `obj.trait_only()` in Rust without the trait
// being in scope. The resolver correctly treats qualified-syntax MRO as opaque
// to direct member calls.
impl Parent for Child {}

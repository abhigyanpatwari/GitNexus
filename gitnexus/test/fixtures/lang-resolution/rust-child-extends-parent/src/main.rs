mod child;
mod parent;

use crate::child::Child;

fn run() {
    let c = Child;
    // Direct impl method — SHOULD resolve to Child::own_method.
    c.own_method();
    // Trait-inherited default — direct member-call SHOULD NOT resolve to
    // Parent::trait_only under Rust's qualified-syntax MRO strategy.
    c.trait_only();
}

fn main() {
    run();
}

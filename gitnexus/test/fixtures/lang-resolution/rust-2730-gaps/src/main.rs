mod a;
mod facade;
mod tools;

// Case 1: inline module — rustc resolves `inner::dispatch` via the module tree.
// There is no `inner.rs` on disk.
mod inner {
    pub fn dispatch() -> usize {
        1
    }
}

fn dispatch() -> usize {
    inner::dispatch()
}

// Case 2: nested path a::b::dispatch()
fn nested() -> usize {
    a::b::dispatch()
}

// Case 3: through a `pub use` re-export facade
fn via_reexport() -> usize {
    facade::dispatch()
}

fn main() {
    dispatch();
    nested();
    via_reexport();
}

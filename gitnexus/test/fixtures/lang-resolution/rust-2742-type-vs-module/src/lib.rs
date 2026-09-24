// A crate-root module whose name matches a TYPE imported elsewhere in the crate.
// Nothing in `b.rs` names this module, so no call from `b.rs` may reach it.
pub mod Buffer {
    pub fn with_capacity() -> usize {
        111
    }
}

pub mod b;
pub mod c;

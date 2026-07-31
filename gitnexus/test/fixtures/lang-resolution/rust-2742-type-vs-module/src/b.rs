// `Buffer` here is the TYPE from `c`, not the crate-root module of the same name.
// In Rust 2018 a bare first segment resolves in this module, so the import wins.
use crate::c::Buffer;

pub fn call() -> usize {
    Buffer::with_capacity()
}

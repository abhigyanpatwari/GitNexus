pub mod b;

// Case 4: super:: path from a child module, with a local shadow present.
pub fn dispatch() -> usize {
    4
}

// Second definition: makes `helper` globally ambiguous on purpose.
pub fn helper() -> usize {
    8
}

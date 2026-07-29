use crate::tools;

// Same-name wrapper (#2730). Must bind to alpha's tools::dispatch, never beta's.
pub fn dispatch(name: &str) -> usize {
    tools::dispatch(name)
}

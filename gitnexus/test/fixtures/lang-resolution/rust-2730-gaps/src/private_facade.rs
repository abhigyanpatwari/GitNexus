// A PRIVATE use. It does not put `helper` on this module's public surface, so
// `private_facade::helper()` does not compile and must not resolve (#2741 review).
use crate::tools::helper;

pub fn touch() -> usize {
    helper()
}

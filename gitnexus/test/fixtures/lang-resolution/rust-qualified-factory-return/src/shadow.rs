use crate::modx;
use crate::modx::Other;

// A path's leading segment names a module in the type namespace, so a `let`
// value named `modx` does not shadow it: `x` is still a `C`, while
// `modx.m()` dispatches on the local `Other`.
pub fn local_shadow() -> i32 {
    let modx = Other;
    let x = modx::make();
    x.m() + modx.m()
}

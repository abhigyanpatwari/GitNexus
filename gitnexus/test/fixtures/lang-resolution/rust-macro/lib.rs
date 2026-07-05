// F72 — a macro invocation resolves to its `macro_rules!` definition (a
// Macro node) via a USES edge, and NEVER to a same-named free function.
// Macros and functions are disjoint namespaces.

macro_rules! greet {
    ($name:expr) => {
        let _ = $name;
    };
}

// Same simple name as the macro, on purpose: proves the macro invocation
// does not bind to this function (no false CALLS edge) and the function
// call does not bind to the macro.
fn greet() -> u32 {
    0
}

fn run() {
    greet!("world"); // macro invocation -> USES edge to Macro greet
    let _ = greet(); // function call    -> CALLS edge to Function greet
}

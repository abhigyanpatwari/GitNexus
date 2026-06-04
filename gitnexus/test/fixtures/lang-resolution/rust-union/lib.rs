// F71 — a `union` is captured as a Struct-labeled node (every
// registry-primary resolution gate includes Struct but excludes Union),
// and it is resolvable: the union literal is a real type constructor.

union MyUnion {
    int_val: i32,
    float_val: f64,
}

fn make() -> MyUnion {
    MyUnion { int_val: 5 } // constructor -> CALLS edge to the Struct MyUnion
}

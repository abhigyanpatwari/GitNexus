// F66/F68 — let binding with various pattern shapes
fn pattern_shapes() {
    let x = 1;                    // bare identifier
    let mut y = 2;                // identifier with mut
    let (a, b) = (1, 2);          // tuple pattern
    let Some(val) = Some(3);      // tuple struct pattern
    let Foo { field } = Foo { field: 1 }; // struct pattern
    let ref z = 4;                // ref pattern
    let n @ 1..=10 = 5;           // captured pattern
}

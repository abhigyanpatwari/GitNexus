module enums_demo::shapes {
    /// All four Move 2 enum variant shapes.
    enum Shape has copy, drop {
        /// Unit variant.
        Empty,
        /// Positional variant.
        Circle(u64),
        /// Named-field variant.
        Rectangle {
            width: u64,
            height: u64
        },
        /// Multi-positional variant.
        Triangle(u64, u64, u64)
    }

    /// Generic enum with a phantom type parameter on a variant.
    enum Result<T, phantom E> has drop {
        Ok(T),
        Err
    }

    public fun area(s: &Shape): u64 {
        match(s) {
            Shape::Empty => 0,
            Shape::Circle(r) => 3 * (*r) * (*r),
            Shape::Rectangle { width, height } => (*width) * (*height),
            Shape::Triangle(a, b, c) => ((*a) + (*b) + (*c)) / 2
        }
    }

    public fun ok_value<T: copy, E>(r: &Result<T, E>): T {
        match(r) { Result::Ok(v) => *v, Result::Err => abort 0 }
    }
}

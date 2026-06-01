pub struct Widget {
    label: String,
}

pub struct Gadget {
    id: u32,
}

// Qualified trait path with NO `use` — the base is a `scoped_type_identifier`
// that resolves by its trailing name `Drawable` (KTD-1). The trait is unique
// and lives in a sibling module, so it resolves via the single-match fast path.
// This doubles as the lone-cross-module-match characterization: tail-only
// resolution is no worse than the bare-name path here, and distinguishing
// same-named traits across modules is deferred (qualifier-preserving resolution).
impl crate::traits::Drawable for Widget {
    fn draw(&self) {
        println!("{}", self.label);
    }
}

// Qualified-generic trait path — `crate::traits::Wrapped<u32>` normalizes to the
// trailing `Wrapped` through the generic_type -> scoped_type_identifier tail.
impl crate::traits::Wrapped<u32> for Gadget {
    fn wrap(&self) -> u32 {
        self.id
    }
}

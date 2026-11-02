pub struct C;

impl C {
    pub fn m(&self) -> i32 {
        1
    }
}

pub struct Other;

impl Other {
    // Shares its name with the module-level `make` below, but returns `Other`.
    pub fn make() -> Other {
        Other
    }

    pub fn m(&self) -> i32 {
        2
    }
}

pub fn make() -> C {
    C
}

// No return annotation: nothing in the program says what a call returns.
pub fn untyped() {}

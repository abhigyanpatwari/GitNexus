pub struct ClientBuilder;

impl ClientBuilder {
    pub fn new() -> usize {
        1
    }
}

// A module-level `new` living alongside the type. Before #2741 review H2 the
// imported TYPE was treated as the module `client`, so `ClientBuilder::new()`
// bound HERE instead of to the associated function.
pub fn new() -> usize {
    2
}

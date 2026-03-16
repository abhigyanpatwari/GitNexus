pub struct Handler {
    pub name: String,
}

impl Handler {
    pub fn process(&self) -> bool {
        true
    }
}

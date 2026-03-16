pub struct User {
    pub name: String,
}

impl User {
    pub fn blank() -> Self {
        let fresh = Self { name: String::new() };
        fresh.validate();
        fresh
    }

    pub fn validate(&self) -> bool {
        !self.name.is_empty()
    }

    pub fn greet(&self) -> String {
        format!("Hello, {}", self.name)
    }
}

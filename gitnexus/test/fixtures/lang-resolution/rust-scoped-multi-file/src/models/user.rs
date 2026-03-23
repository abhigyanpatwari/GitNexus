pub struct User {
    name: String,
}

impl User {
    pub fn new(name: &str) -> Self {
        User { name: name.to_string() }
    }

    pub fn save(&self) {
        println!("Saving user {}", self.name);
    }
}

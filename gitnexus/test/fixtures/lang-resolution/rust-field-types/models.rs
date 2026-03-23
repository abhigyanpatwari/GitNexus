pub struct Address {
    pub city: String,
}

impl Address {
    pub fn save(&self) {
        // persist address
    }
}

pub struct User {
    pub name: String,
    pub address: Address,
}

impl User {
    pub fn greet(&self) -> &str {
        &self.name
    }
}

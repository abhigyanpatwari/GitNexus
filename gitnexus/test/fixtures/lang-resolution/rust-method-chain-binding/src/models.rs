pub struct City {
    pub name: String,
}

impl City {
    pub fn save(&self) -> bool { true }
}

pub struct Address {
    pub city: City,
}

impl Address {
    pub fn get_city(&self) -> &City { &self.city }
}

pub struct User {
    pub address: Address,
}

pub fn get_user() -> User {
    User { address: Address { city: City { name: "NYC".to_string() } } }
}

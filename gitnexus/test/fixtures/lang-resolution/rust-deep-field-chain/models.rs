pub struct City {
    pub zip_code: String,
}

impl City {
    pub fn get_name(&self) -> &str {
        "city"
    }
}

pub struct Address {
    pub city: City,
    pub street: String,
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

pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) -> bool {
        true
    }
}

pub struct Repo {
    pub name: String,
}

impl Repo {
    pub fn save(&self) -> bool {
        true
    }
}

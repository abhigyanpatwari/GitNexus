pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) -> bool {
        true
    }
}

pub struct Repo {
    pub url: String,
}

impl Repo {
    pub fn persist(&self) -> bool {
        true
    }
}

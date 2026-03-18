pub struct Repo {
    pub name: String,
}

impl Repo {
    pub fn save(&self) {}
}

pub fn get_repos() -> Vec<Repo> {
    vec![Repo { name: "main".into() }]
}

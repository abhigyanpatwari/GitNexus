pub struct Repo {
    name: String,
}

impl Repo {
    pub fn new(name: &str) -> Self {
        Repo { name: name.to_string() }
    }

    pub fn clone_repo(&self) {
        println!("Cloning repo {}", self.name);
    }
}

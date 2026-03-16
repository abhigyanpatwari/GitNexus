pub struct Repo;

impl Repo {
    pub fn new() -> Self {
        Repo
    }

    pub fn save(&self) -> bool {
        true
    }
}

impl Default for Repo {
    fn default() -> Self {
        Repo
    }
}

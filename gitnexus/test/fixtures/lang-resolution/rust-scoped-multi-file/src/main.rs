mod models;

use crate::models::{User, Repo};

fn main() {
    let user = User::new("alice");
    user.save();

    let repo = Repo::new("my-repo");
    repo.clone_repo();
}

mod models;

use models::{User, Repo};

fn get_user() -> User {
    User { name: String::from("alice") }
}

fn get_repo() -> Repo {
    Repo { name: String::from("main") }
}

fn process_user() {
    let user = get_user();
    user.save();
}

fn process_repo() {
    let repo = get_repo();
    repo.save();
}

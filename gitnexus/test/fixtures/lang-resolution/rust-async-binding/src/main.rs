mod user;
mod repo;

use user::User;
use repo::Repo;

async fn get_user() -> User {
    User { name: String::from("alice") }
}

async fn get_repo() -> Repo {
    Repo { name: String::from("main") }
}

async fn process_user() {
    let user = get_user().await;
    user.save();
}

async fn process_repo() {
    let repo = get_repo().await;
    repo.save();
}

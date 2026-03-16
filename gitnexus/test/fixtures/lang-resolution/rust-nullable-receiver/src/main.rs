mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

fn find_user() -> Option<User> {
    Some(User)
}

fn find_repo() -> Option<Repo> {
    Some(Repo)
}

fn process_entities() {
    let user: Option<User> = find_user();
    user.unwrap().save();
    let repo: Option<Repo> = find_repo();
    repo.unwrap().save();
}

fn main() {}

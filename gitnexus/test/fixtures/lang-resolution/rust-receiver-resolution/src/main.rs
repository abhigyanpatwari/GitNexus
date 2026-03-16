mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

fn process_entities() {
    let user: User = User;
    let repo: Repo = Repo;
    user.save();
    repo.save();
}

fn main() {}

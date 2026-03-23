mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

fn process(opt: Option<User>) {
    match opt {
        Some(user) => user.save(),
        None => {},
    }
}

fn check(res: Result<Repo, String>) {
    if let Ok(repo) = res {
        repo.save();
    }
}

fn main() {}

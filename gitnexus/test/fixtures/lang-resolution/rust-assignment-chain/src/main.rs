mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

fn get_user() -> User { User }
fn get_repo() -> Repo { Repo }

fn process_entities() {
    let u: User = get_user();
    let alias = u;
    alias.save();

    let r: Repo = get_repo();
    let r_alias = r;
    r_alias.save();
}

fn main() {}

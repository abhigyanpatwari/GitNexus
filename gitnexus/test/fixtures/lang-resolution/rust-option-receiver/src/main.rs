mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

// Tests that Option<User> unwraps to User in TypeEnv,
// and assignment chain from Option-typed source resolves correctly.
fn process_entities() {
    let opt: Option<User> = Some(User);
    let alias = opt;
    alias.save();

    let repo: Repo = Repo;
    repo.save();
}

fn main() {}

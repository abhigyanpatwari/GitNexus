mod lib;
use lib::{SqlRepo, Repository};

fn process() {
    let repo = SqlRepo;
    let user = repo.find(42);
    repo.save(&user);
    let n = repo.count();
}
